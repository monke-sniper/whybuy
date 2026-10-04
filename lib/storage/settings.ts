import type { ByokConfig, ByokProvider, JudgeMode, PromptDetail } from '../ai/types.ts'
import { DEFAULT_VOICE_ID, DEFAULT_MODEL_ID } from '../tts/elevenLabs.ts'

import type { SttModelId } from '../stt/elevenLabs.ts'

export type DebateLength = 'short' | 'standard' | 'long'
export type Tone = 'firm' | 'socratic' | 'sardonic'

/**
 * ElevenLabs text-to-speech configuration. The API key is stored
 * alongside the BYOK AI key in `chrome.storage.local` and is NEVER
 * logged — diagnostic output uses `voice.keySet = !!apiKey` only.
 */
export interface VoiceConfig {
  /** Master switch — false = no audio even if the key is set. */
  enabled: boolean
  /** ElevenLabs API key (xi-api-key). Stored locally; never synced. */
  apiKey: string
  /** Voice ID. Default = Rachel (calm, English). */
  voiceId: string
  /** Model ID. Default = eleven_turbo_v2_5 (lowest latency). */
  modelId: string
  /** Master mute — tri-state UI toggle in the trial and Options. */
  muted: boolean
  /** Volume 0..1. Default 1. */
  volume: number
  /**
   * AudioBufferSourceNode playback rate. 1 = normal speed.
   * Default 1.5 = 50% faster so the trial "wastes less time".
   * Slight chipmunk effect, but acceptable for a casual debate.
   * Range 0.5..2.0.
   */
  playbackRate: number
  /**
   * Native ElevenLabs speaking rate (0.5..1.2 for turbo v2.5).
   * Default 1.2 (max for the model) so the model regenerates audio
   * 20% faster without pitch distortion. Combined with playbackRate
   * this gives ~1.8x effective speed.
   */
  speed: number
  /** Voice settings — see elevenLabs.ts. */
  stability: number
  similarityBoost: number
}

/**
 * ElevenLabs speech-to-text configuration. STT reuses the API
 * key stored in `VoiceConfig` (we don't store it twice). The
 * key is NEVER logged — diagnostic output uses `voice.keySet` only.
 */
export interface SttConfig {
  /** Master switch — false = no STT button even if key is set. */
  enabled: boolean
  /** Scribe model. 'scribe_v2' is the default (best quality). */
  modelId: SttModelId
}

export interface Settings {
  debateLength: DebateLength
  tone: Tone
  ignoredSites: string[]
  /** AI provider selection. null = use Chrome AI / scripted fallback. */
  byok: ByokConfig | null
  /**
   * Prompt detail level for the prosecution. `'minimal'` is the safe
   * default: it works on every model. `'rich'` is opt-in for users
   * with a reasoning-capable model that benefits from the structured
   * product card (brand, rating, etc.).
   */
  promptDetail: PromptDetail
  /**
   * Judge output mode. `'natural'` (default) is a line-based ruling
   * format that works on every model. `'structured'` is the historical
   * `<think>...</think>` + JSON format, best for reasoning models.
   */
  judgeMode: JudgeMode
  /**
   * ElevenLabs TTS config. `null` until the user opts in (the
   * Options page creates a default config when the user opens the
   * Voice section for the first time).
   */
  voice: VoiceConfig | null
  /**
   * ElevenLabs STT config. `null` until the user opts in (the
   * Options page creates a default config when the user opens the
   * Speech-to-Text section for the first time). Reuses the API
   * key from `voice`.
   */
  stt: SttConfig | null
}

/** chrome.storage.local key holding the Settings object. */
export const SETTINGS_KEY = 'whybuy.settings.v1'
const KEY = SETTINGS_KEY

const DEFAULT_VOICE: VoiceConfig = {
  enabled: false,
  apiKey: '',
  voiceId: DEFAULT_VOICE_ID,
  modelId: DEFAULT_MODEL_ID,
  muted: false,
  volume: 1,
  // The user wanted faster TTS so the trial "wastes less time".
  // 1.5x Web Audio playback (slight pitch up) + 1.2x ElevenLabs
  // native speed (no pitch distortion) ≈ 1.8x effective speed.
  playbackRate: 1.5,
  speed: 1.2,
  stability: 0.5,
  similarityBoost: 0.75,
}

const DEFAULT_STT: SttConfig = {
  enabled: false,
  modelId: 'scribe_v2',
}

const DEFAULTS: Settings = {
  debateLength: 'standard',
  tone: 'firm',
  ignoredSites: [],
  byok: null,
  promptDetail: 'minimal',
  judgeMode: 'natural',
  voice: null,
  stt: null,
}

export async function loadSettings(): Promise<Settings> {
  const raw = (await chrome.storage.local.get(KEY))[KEY]
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
  const obj = raw as Partial<Settings> & { future?: any }
  // Migrate from the old `future` shape if present.
  let byok: ByokConfig | null = obj.byok ?? null
  if (!byok && obj.future?.apiKey) {
    byok = { provider: obj.future.provider || 'gemini', apiKey: obj.future.apiKey }
  }
  // Normalize the two new fields — accept only the canonical values;
  // anything else falls back to the safe defaults.
  const promptDetail: PromptDetail = obj.promptDetail === 'rich' ? 'rich' : 'minimal'
  const judgeMode: JudgeMode = obj.judgeMode === 'structured' ? 'structured' : 'natural'
  // Normalize voice config: preserve user data, fall back to safe
  // defaults for any missing field, but NEVER auto-create a config
  // (the user must opt in via the Options page).
  const voice: VoiceConfig | null = normalizeVoice(obj.voice)
  // Normalize STT config: same opt-in policy. Reuses the voice key.
  const stt: SttConfig | null = normalizeStt(obj.stt)
  return { ...DEFAULTS, ...obj, byok, promptDetail, judgeMode, voice, stt }
}

export async function saveSettings(next: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: next })
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  const cur = await loadSettings()
  const next: Settings = { ...cur, ...patch }
  await saveSettings(next)
  return next
}

/**
 * Build a safe `VoiceConfig` from arbitrary input. Tolerates missing
 * fields, out-of-range numbers, and unknown voice IDs by falling
 * back to the defaults. Returns null if the input is explicitly null.
 */
export function normalizeVoice(raw: unknown): VoiceConfig | null {
  if (raw == null) return null
  if (typeof raw !== 'object') return { ...DEFAULT_VOICE }
  const o = raw as Partial<VoiceConfig>
  return {
    enabled: !!o.enabled,
    apiKey: typeof o.apiKey === 'string' ? o.apiKey : '',
    voiceId: typeof o.voiceId === 'string' && o.voiceId.length > 0 ? o.voiceId : DEFAULT_VOICE.voiceId,
    modelId: typeof o.modelId === 'string' && o.modelId.length > 0 ? o.modelId : DEFAULT_VOICE.modelId,
    muted: !!o.muted,
    volume: clamp01(typeof o.volume === 'number' ? o.volume : DEFAULT_VOICE.volume),
    playbackRate: clampPlaybackRate(
      typeof o.playbackRate === 'number' ? o.playbackRate : DEFAULT_VOICE.playbackRate,
    ),
    speed: clampSpeed(
      typeof o.speed === 'number' ? o.speed : DEFAULT_VOICE.speed,
    ),
    stability: clamp01(typeof o.stability === 'number' ? o.stability : DEFAULT_VOICE.stability),
    similarityBoost: clamp01(
      typeof o.similarityBoost === 'number' ? o.similarityBoost : DEFAULT_VOICE.similarityBoost,
    ),
  }
}

export function defaultVoiceConfig(): VoiceConfig {
  return { ...DEFAULT_VOICE }
}

/**
 * Build a safe `SttConfig` from arbitrary input. Tolerates missing
 * fields and unknown model IDs by falling back to the defaults.
 * Returns null if the input is explicitly null.
 */
export function normalizeStt(raw: unknown): SttConfig | null {
  if (raw == null) return null
  if (typeof raw !== 'object') return { ...DEFAULT_STT }
  const o = raw as Partial<SttConfig>
  return {
    enabled: !!o.enabled,
    modelId: o.modelId === 'scribe_v1' ? 'scribe_v1' : 'scribe_v2',
  }
}

export function defaultSttConfig(): SttConfig {
  return { ...DEFAULT_STT }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_VOICE.volume
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function clampPlaybackRate(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VOICE.playbackRate
  if (n < 0.5) return 0.5
  if (n > 2) return 2
  return n
}

function clampSpeed(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_VOICE.speed
  if (n < 0.5) return 0.5
  if (n > 1.2) return 1.2
  return n
}
