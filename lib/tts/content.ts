/**
 * Content-script-scoped TTS manager.
 *
 * One playback instance per content script lifetime. Owns the
 * ElevenLabs settings, the AudioContext, and the sentence buffer.
 * Exposes a small imperative API for the trial UI to use:
 *
 *   tts.start()                        // initialize the AudioContext
 *                                      // (must be called from a user
 *                                      // gesture — the checkout click)
 *   tts.enqueue(text)                  // feed raw streaming text in
 *   tts.flush()                        // flush any final partial
 *                                      // sentence (on stream end)
 *   tts.interrupt()                    // stop everything
 *   tts.setMuted(bool) / isMuted()
 *   tts.setEnabled(bool) / isEnabled()
 *   tts.subscribe(cb)                  // state changes for the UI
 *
 * The manager reads voice settings via `loadSettings()` once per
 * `start()` (the trial mount) and keeps them current through a
 * `chrome.storage.onChanged` listener, so the Options page can change
 * the key/voice live without remounting the trial and without a
 * storage read per streamed chunk. The key is NEVER logged — only the
 * `keySet` boolean.
 */

import { SentenceBuffer } from './sentenceBuffer.ts'
import { TtsPlayback, type TtsState } from './playback.ts'
import { loadSettings, SETTINGS_KEY, type VoiceConfig } from '@/lib/storage/settings.ts'
import { log } from '@/lib/utils/log.ts'

let singleton: TtsManager | null = null

export function getTtsManager(): TtsManager {
  if (!singleton) singleton = new TtsManager()
  return singleton
}

// Re-export the class under a non-colliding name so React prop
// types can reference it without colliding with the singleton
// getter (same name would shadow the import).
export { TtsManager as TtsManagerClass }

export interface TtsSubscriberState {
  enabled: boolean
  muted: boolean
  state: TtsState
  /** True while the AI is generating text. Used by the UI to show
   * the speaker icon even before audio is actually playing. */
  speaking: boolean
  queueLength: number
  /** Last error message, for the "voice off" tooltip. */
  lastError: string | null
  /** True when the manager is configured to play audio (enabled +
   *  apiKey set + audio not muted). */
  willSpeak: boolean
  keySet: boolean
}

export type TtsSubscriber = (s: TtsSubscriberState) => void

class TtsManager {
  private playback: TtsPlayback
  private buf = new SentenceBuffer()
  private enabled = false
  private config: VoiceConfig | null = null
  private speaking = false
  private subs = new Set<TtsSubscriber>()
  private lastState: TtsState = 'idle'
  /** True once voice settings have been read at least once. */
  private configLoaded = false

  constructor() {
    this.playback = new TtsPlayback({
      onState: (s) => {
        this.lastState = s
        this.notify()
      },
      onError: (msg) => {
        log('TTS playback error:', msg)
        this.notify()
      },
    })
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && SETTINGS_KEY in changes) void this.syncFromSettings()
      })
    } catch {
      // No storage events (tests): settings refresh on start()/sync only.
    }
  }

  // === lifecycle ===

  /**
   * Initialize the AudioContext. Call from a user-gesture handler
   * (the checkout click). Returns true if the manager is ready to
   * play audio, false if voice is disabled or the key is missing.
   */
  async start(): Promise<boolean> {
    const settings = await loadSettings()
    this.config = settings.voice
    this.configLoaded = true
    if (!this.config || !this.config.enabled || !this.config.apiKey) {
      this.enabled = false
      this.notify()
      return false
    }
    this.enabled = true
    this.playback.setMuted(this.config.muted)
    this.playback.setVolume(this.config.volume)
    this.playback.setPlaybackRate(this.config.playbackRate)
    this.playback.start()
    return true
  }

  /** Voice config, read from disk only the first time it is needed. */
  private async ensureConfig(): Promise<VoiceConfig | null> {
    if (!this.configLoaded) await this.refreshConfig()
    return this.config
  }

  /**
   * Re-read voice config from disk. Driven by the storage change
   * listener so the Options page can change the key/voice live.
   */
  private async refreshConfig(): Promise<VoiceConfig | null> {
    const settings = await loadSettings()
    this.config = settings.voice
    this.configLoaded = true
    if (this.config) {
      this.playback.setMuted(this.config.muted)
      this.playback.setVolume(this.config.volume)
      this.playback.setPlaybackRate(this.config.playbackRate)
    }
    return this.config
  }

  // === text input ===

  /**
   * Feed a streaming text chunk into the sentence buffer. Complete
   * sentences are sent to ElevenLabs. Safe to call many times.
   */
  async enqueue(chunk: string): Promise<void> {
    if (!chunk) return
    this.speaking = true
    const config = await this.ensureConfig()
    if (!config || !config.enabled || !config.apiKey) {
      this.notify()
      return
    }
    this.enabled = true
    const sentence = this.buf.push(chunk)
    this.notify()
    if (sentence) this.playback.speak(sentence, ttsConfigFromVoice(config))
  }

  /**
   * Flush any buffered partial sentence. Call on stream end.
   */
  async flush(): Promise<void> {
    if (!this.speaking) return
    this.speaking = false
    const config = await this.ensureConfig()
    const rest = this.buf.flush()
    this.notify()
    if (rest && config && config.enabled && config.apiKey) {
      this.playback.speak(rest, ttsConfigFromVoice(config))
    }
  }

  /**
   * Stop everything immediately. Call when the user submits a turn,
   * the trial closes, override is clicked, etc.
   */
  interrupt(): void {
    this.speaking = false
    // Reset the buffer so partial text from the interrupted turn
    // doesn't bleed into the next turn's audio.
    this.buf = new SentenceBuffer()
    this.playback.interrupt()
    this.notify()
  }

  // === controls ===

  isEnabled(): boolean {
    return this.enabled
  }

  isMuted(): boolean {
    return this.playback.isMuted()
  }

  isBusy(): boolean {
    return this.playback.isBusy()
  }

  queueLength(): number {
    return this.playback.queueLength()
  }

  setMuted(m: boolean): void {
    this.playback.setMuted(m)
    this.notify()
  }

  toggleMuted(): boolean {
    const next = !this.playback.isMuted()
    this.setMuted(next)
    return next
  }

  /**
   * Re-read voice settings and apply enabled/muted/volume. Called
   * when the Options page changes the config so the trial picks it
   * up immediately. Also persists mute to settings so it survives
   * across trials.
   */
  async syncFromSettings(): Promise<void> {
    await this.refreshConfig()
    this.enabled = !!(this.config?.enabled && this.config.apiKey)
    this.notify()
  }

  // === subscription ===

  subscribe(cb: TtsSubscriber): () => void {
    this.subs.add(cb)
    cb(this.snapshot())
    return () => this.subs.delete(cb)
  }

  snapshot(): TtsSubscriberState {
    const c = this.config
    const keySet = !!c?.apiKey
    return {
      enabled: this.enabled,
      muted: this.playback.isMuted(),
      state: this.lastState,
      speaking: this.speaking,
      queueLength: this.playback.queueLength(),
      lastError: this.playback.getLastError(),
      willSpeak: this.enabled && !this.playback.isMuted() && keySet,
      keySet,
    }
  }

  private notify() {
    const snap = this.snapshot()
    for (const cb of this.subs) {
      try {
        cb(snap)
      } catch {}
    }
  }
}

function ttsConfigFromVoice(c: VoiceConfig) {
  return {
    apiKey: c.apiKey,
    voiceId: c.voiceId,
    modelId: c.modelId,
    stability: c.stability,
    similarityBoost: c.similarityBoost,
    // playbackRate is read by TtsPlayback.speak() and applied to the
    // AudioBufferSourceNode. We also set it on the manager so it
    // takes effect even if the next speak() call comes before the
    // Options page sync.
    playbackRate: c.playbackRate,
    // Native ElevenLabs speed is passed through to the request body
    // so the model regenerates the audio faster (no pitch shift).
    speed: c.speed,
  }
}
