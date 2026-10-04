import { useEffect, useReducer, useRef, useState } from 'react'
import type { Cart, ChatMessage, Product, ProviderStatus, Verdict } from '@/lib/ai/types'
import { TRIAL_PORT, type TrialEvent } from '@/lib/messaging/bus'
import { createInitialState, reduce, roundLabel, TOTAL_ROUNDS, type Phase, type TrialState } from '@/lib/trial/stateMachine'
import { Header } from './Header'
import { Bench } from './Bench'
import { Panels } from './Panels'
import { Composer } from './Composer'
import { JudgeRoom } from './JudgeRoom'
import { LossScreen } from './LossScreen'
import { IntroOverlay } from './IntroOverlay'
import { UnsupportedOverlay } from './UnsupportedOverlay'
import { CooldownGate } from './CooldownGate'
import { ProductCardStack } from './ProductCard'
import { VoiceButton } from './VoiceButton'
import type { TtsManagerClass as TtsManager, TtsSubscriberState } from '@/lib/tts/content.ts'
import { saveSettings } from '@/lib/storage/settings.ts'
import { getSttManager, type SttManager } from '@/lib/stt/content.ts'

export interface TrialProps {
  product: Product
  cart?: Cart | null
  providerStatus: ProviderStatus
  providerName?: string
  existingCooldown: { until: number; product: Product; groupLabel?: string; confidence: number } | null
  /** Provided by mountTrial, not by callers. */
  host?: HTMLElement
  shadow?: ShadowRoot
  /** TTS manager from the content script. Always provided. */
  tts?: TtsManager
  onProceed?: () => void
  onAbandon?: (verdict: Verdict) => void
  onOverride?: (verdict: Verdict) => void
  onClose?: () => void
  /** May return a promise; closing the tab waits for it so the record is never cut off. */
  onTranscript?: (transcript: ChatMessage[], verdict: Verdict, outcome: 'accepted-abandon' | 'overridden-proceeded' | 'proceeded-after-proceed') => void | Promise<void>
}

/** Props the caller of mountTrial provides; mountTrial adds host/shadow. */
export type MountTrialProps = Omit<TrialProps, 'host' | 'shadow'>

/** Longest we wait for the outcome record to be written before navigating/closing. */
const RECORD_WAIT_MS = 2000

/**
 * Resolve once the outcome record has been written, or after RECORD_WAIT_MS.
 * Proceeding (navigation) and closing the tab both destroy this content
 * script, so the storage writes must finish first or the outcome is lost.
 * Bounded so a stuck storage call can never block the user.
 */
function recordSettled(recorded: void | Promise<void> | undefined): Promise<void> {
  return Promise.race([
    Promise.resolve(recorded).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, RECORD_WAIT_MS)),
  ])
}

const AI_RESPONSE_TIMEOUT_MS = 120000
const HEARTBEAT_INTERVAL_MS = 20000
const HEARTBEAT_TIMEOUT_MS = 5000

export function TrialApp(props: TrialProps) {
  const [state, dispatch] = useReducer(reduce, props.product, createInitialState)
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null)
  const [providerReady, setProviderReady] = useState<boolean>(
    props.providerStatus.kind === 'ready' || props.providerStatus.kind === 'needs-download',
  )
  const [cooldownTick, setCooldownTick] = useState<number>(0)
  const [aiTimedOut, setAiTimedOut] = useState<boolean>(false)
  const [callingAiSince, setCallingAiSince] = useState<number | null>(null)
  const [lastError, setLastError] = useState<string | null>(null)
  const [ttsSnap, setTtsSnap] = useState<TtsSubscriberState | null>(props.tts ? props.tts.snapshot() : null)
  const [textDraft, setTextDraft] = useState<string>('')
  const portRef = useRef<chrome.runtime.Port | null>(null)
  const aiTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeRequestIdRef = useRef<string | null>(null)
  const transcriptRef = useRef<ChatMessage[]>([])
  const verdictRef = useRef<Verdict | null>(null)
  // STT manager is a content-script singleton. We only need a
  // reference for the Composer (which passes it to MicButton).
  const sttManagerRef = useRef<SttManager | null>(null)
  if (sttManagerRef.current === null) {
    try {
      sttManagerRef.current = getSttManager()
    } catch {
      sttManagerRef.current = null
    }
  }

  // Keep ref in sync for the close handler.
  useEffect(() => {
    transcriptRef.current = state.transcript
  }, [state.transcript])
  useEffect(() => {
    verdictRef.current = state.verdict
  }, [state.verdict])

  // Subscribe to TTS state changes (muted, speaking, queue length).
  useEffect(() => {
    if (!props.tts) return
    return props.tts.subscribe((s: TtsSubscriberState) => setTtsSnap(s))
  }, [props.tts])

  // Cooldown countdown ticker.
  useEffect(() => {
    if (!props.existingCooldown) return
    const t = setInterval(() => setCooldownTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [props.existingCooldown])

  // Keep an always-fresh ref to the state for use inside handlePortMessage.
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const cart = props.cart ?? state.product.cart ?? null

  const handlePortMessage = (raw: unknown) => {
    const ev = raw as TrialEvent
    // Ignore events that don't match the active request, except global ones
    // (PROVIDER_STATUS, PONG, DOWNLOAD_PROGRESS).
    const evRid = (ev as any).requestId
    const activeRid = activeRequestIdRef.current
    const isTargeted = ev.type === 'PROVIDER_STATUS' || ev.type === 'PONG' || ev.type === 'DOWNLOAD_PROGRESS' ||
      !evRid || evRid === activeRid
    if (!isTargeted) return

    switch (ev.type) {
      case 'PROVIDER_STATUS': {
        if (ev.kind === 'ready' || ev.kind === 'needs-download') setProviderReady(true)
        break
      }
      case 'DOWNLOAD_PROGRESS':
        setDownloadProgress(ev.pct)
        break
      case 'PONG':
        // Heartbeat acknowledged — SW is alive.
        break
      case 'CANCELLED':
        // The user cancelled; reset state and fall back to scripted.
        console.warn('[WhyBuy] AI request cancelled by user')
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        activeRequestIdRef.current = null
        setLastError('Cancelled by user')
        feedFallbackForPhase(stateRef.current.phase)
        break
      case 'STREAM_CHUNK':
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        dispatch({ type: 'AI_STREAM', text: ev.text })
        // Feed the new text into the TTS sentence buffer. The
        // manager decides whether to actually call ElevenLabs based
        // on the voice settings + a sentence terminator.
        if (props.tts) {
          void props.tts.enqueue(ev.text)
        }
        break
      case 'STREAM_END':
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        activeRequestIdRef.current = null
        dispatch({ type: 'AI_DONE', text: ev.text, speaker: 'prosecution' })
        // Flush any final partial sentence so the AI's last words
        // are spoken too.
        if (props.tts) {
          void props.tts.flush()
        }
        break
      case 'JUDGE_REASONING_CHUNK':
        // The judge streamed a reasoning chunk. We don't display the
        // reasoning anymore (the live trace was removed) but we still
        // reset the "AI is taking too long" timer so the spinner
        // doesn't time out while the judge is making progress.
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        break
      case 'VERDICT':
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        activeRequestIdRef.current = null
        dispatch({ type: 'DELIBERATION_DONE', verdict: ev.verdict })
        break
      case 'ERROR':
        console.error('[WhyBuy] SW error:', ev.message)
        if (aiTimeoutRef.current) {
          clearTimeout(aiTimeoutRef.current)
          aiTimeoutRef.current = null
        }
        setCallingAiSince(null)
        activeRequestIdRef.current = null
        setLastError(ev.message)
        if (ev.message === 'port-failed') {
          feedFallbackForPhase(stateRef.current.phase)
        } else if (stateRef.current.phase === 'deliberation') {
          // Real AI error during verdict: fall back to scripted.
          feedFallbackForPhase(stateRef.current.phase)
        } else {
          // Real AI error during prosecution: feed a visible error bubble so
          // the user knows the call actually failed (and it's not the
          // scripted text), then advance.
          const tag = ev.message ? ` [AI error: ${ev.message}]` : ' [AI error]'
          const product = stateRef.current.product
          const liveCart = stateRef.current.product.cart ?? null
          const baseText = liveCart && liveCart.items.length > 0
            ? `The court could not reach the AI for this cart. The case against ${liveCart.itemCount} items totaling ${formatPriceFor({ price: liveCart.total, currency: liveCart.currency } as any)} must rest on what the record already shows.`
            : `The court could not reach the AI for ${product.name || 'this purchase'}. The case must rest on what the record already shows.`
          dispatch({ type: 'AI_DONE', text: baseText + tag, speaker: 'prosecution' })
        }
        break
    }
  }

  const stopHeartbeat = () => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current)
      heartbeatRef.current = null
    }
  }

  const startHeartbeat = () => {
    stopHeartbeat()
    heartbeatRef.current = setInterval(() => {
      const port = portRef.current
      const rid = activeRequestIdRef.current
      if (!port || !rid) return
      try {
        port.postMessage({ type: 'PING', requestId: rid })
      } catch {
        // Port is dead; the timeout will catch up.
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  const sendRequest = (msg: any) => {
    const requestId = (msg.requestId = msg.requestId || newRequestId())
    activeRequestIdRef.current = requestId
    startHeartbeat()
    let port = portRef.current
    const trySend = (p: chrome.runtime.Port) => {
      try {
        p.postMessage(msg)
        return true
      } catch {
        return false
      }
    }
    if (!port || !trySend(port)) {
      try {
        port?.disconnect()
      } catch {}
      try {
        port = chrome.runtime.connect({ name: TRIAL_PORT })
      } catch {
        port = null
      }
      if (port) {
        portRef.current = port
        port.onMessage.addListener(handlePortMessage)
        if (!trySend(port)) port = null
      }
      if (!port) {
        stopHeartbeat()
        activeRequestIdRef.current = null
        handlePortMessage({ type: 'ERROR', message: 'port-failed' })
      }
    }
  }

  /**
   * Abort the in-flight AI call. The SW cancels its fetch; we then
   * fall back to the scripted provider so the trial still progresses.
   */
  const cancelInFlight = () => {
    const port = portRef.current
    const rid = activeRequestIdRef.current
    if (!port || !rid) return
    try {
      port.postMessage({ type: 'CANCEL', requestId: rid })
    } catch {}
    // The SW will respond with CANCELLED; we don't need to do anything
    // here — handlePortMessage routes that to the fallback.
  }

  // Open port to background and start the trial.
  useEffect(() => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connect({ name: TRIAL_PORT })
    } catch (e) {
      console.error('[WhyBuy] port connect failed:', e)
      setTimeout(() => feedFallbackForPhase('opening'), 400)
      return
    }
    portRef.current = port
    port.onMessage.addListener(handlePortMessage)

    port.postMessage({ type: 'GET_PROVIDER_STATUS' })

    const introTimer = setTimeout(() => {
      dispatch({ type: 'INTRO_DONE' })
    }, 1400)

    return () => {
      clearTimeout(introTimer)
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current)
      stopHeartbeat()
      try {
        port.disconnect()
      } catch {}
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // When phase changes to opening, request the opening statement.
  useEffect(() => {
    if (state.phase !== 'opening') return
    setCallingAiSince(Date.now())
    sendRequest({ type: 'OPENING', product: state.product, cart })
    armAiTimeout('opening')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // When phase changes to a prosecution response, request the turn.
  useEffect(() => {
    if (
      state.phase !== 'prosecution_1' &&
      state.phase !== 'prosecution_2' &&
      state.phase !== 'prosecution_3'
    )
      return
    setCallingAiSince(Date.now())
    sendRequest({ type: 'PROSECUTION_TURN', product: state.product, cart, transcript: state.transcript })
    armAiTimeout(state.phase)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  // When phase enters deliberation, request the judge verdict.
  useEffect(() => {
    if (state.phase !== 'deliberation') return
    const t = setTimeout(() => {
      setCallingAiSince(Date.now())
      sendRequest({ type: 'JUDGE', product: state.product, cart, transcript: state.transcript })
      armAiTimeout('deliberation')
    }, 1400)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase])

  const armAiTimeout = (phase: Phase) => {
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current)
    aiTimeoutRef.current = setTimeout(() => {
      console.warn('[WhyBuy] AI response timed out after', AI_RESPONSE_TIMEOUT_MS, 'ms, feeding fallback for', phase)
      setAiTimedOut(true)
      setCallingAiSince(null)
      stopHeartbeat()
      activeRequestIdRef.current = null
      setLastError(`AI response timed out after ${AI_RESPONSE_TIMEOUT_MS / 1000}s. The model may be cold-loading (first request of the session); open settings and click Test connection to pre-warm it.`)
      feedFallbackForPhase(phase)
    }, AI_RESPONSE_TIMEOUT_MS)
  }

  /**
   * Hard fallback so the trial always progresses. Used if the AI is
   * unavailable (no Prompt API, no key, port dead, network error, etc.).
   * The fallback text is clearly tagged so the user can tell real AI from
   * the canned scaffolding.
   */
  const feedFallbackForPhase = (phase: Phase) => {
    const product = stateRef.current.product
    const liveCart = stateRef.current.product.cart ?? null
    const tag = ' [Scripted fallback — AI unavailable]'
    if (phase === 'opening') {
      const text = liveCart && liveCart.items.length > 0
        ? `The court calls this cart of ${liveCart.itemCount} items totaling ${formatPriceFor({ price: liveCart.total, currency: liveCart.currency } as any)} to the stand. What is the recurring need, and what cheaper alternatives has the defense not mentioned?`
        : `The court calls ${product.name || 'this purchase'} to the stand. The price of ${formatPriceFor(product)} deserves scrutiny before any money changes hands. What is the recurring need, and what cheaper alternatives has the defense not mentioned?`
      dispatch({ type: 'AI_DONE', text: text + tag, speaker: 'prosecution' })
    } else if (phase === 'prosecution_1' || phase === 'prosecution_2' || phase === 'prosecution_3') {
      const lastUser = [...stateRef.current.transcript].reverse().find((m) => m.role === 'defense')?.text ?? ''
      const snip = lastUser.length > 60 ? lastUser.slice(0, 57) + '…' : lastUser
      const priceStr = formatPriceFor(liveCart?.total != null ? { price: liveCart.total, currency: liveCart.currency } as any : product)
      dispatch({
        type: 'AI_DONE',
        text: `The defense argued "${snip || 'a personal need'}", but wanting is not needing. The cost of ${priceStr} must be justified against the user's other obligations, and the record is silent on that point.` + tag,
        speaker: 'prosecution',
      })
    } else if (phase === 'deliberation') {
      import('@/lib/ai/scripted').then(({ ScriptedProvider }) => {
        const p = new ScriptedProvider()
        p.judgeVerdict({
          systemPrompt: '',
          transcript: stateRef.current.transcript,
          product,
          cart: liveCart,
        }).then((v) => dispatch({ type: 'DELIBERATION_DONE', verdict: v }))
      })
    }
  }

  const handleUserSend = (text: string) => {
    // The user just took the floor — stop any in-flight AI speech
    // so the user can hear themselves type.
    props.tts?.interrupt()
    // Also cancel any in-flight STT recording so the mic stream
    // is released before the next AI turn.
    sttManagerRef.current?.cancel()
    setTextDraft('')
    dispatch({ type: 'USER_SEND', text })
  }

  const handleProceed = () => {
    if (!state.verdict) return
    props.tts?.interrupt()
    dispatch({ type: 'USER_PROCEEDS' })
    const recorded = props.onTranscript?.(state.transcript, state.verdict, 'proceeded-after-proceed')
    // onProceed re-fires the checkout click, which usually navigates and
    // destroys this script: let the history write land first.
    void recordSettled(recorded).then(() => props.onProceed?.())
  }

  const handleAcceptLoss = () => {
    if (!state.verdict) return
    props.tts?.interrupt()
    dispatch({ type: 'USER_ACCEPTS_LOSS' })
    props.onTranscript?.(state.transcript, state.verdict, 'accepted-abandon')
    props.onAbandon?.(state.verdict)
  }

  /**
   * Close the tab after a restraint verdict + "Accept the ruling"
   * countdown. Records the outcome (sets the cooldown + appends to
   * history) FIRST, then asks the background to close this tab via
   * `chrome.runtime.sendMessage`. The background calls
   * `chrome.tabs.remove(senderTab.id)` because content scripts
   * don't have the tabs permission themselves.
   */
  const handleCloseTab = () => {
    if (!state.verdict) return
    props.tts?.interrupt()
    dispatch({ type: 'USER_ACCEPTS_LOSS' })
    const recorded = props.onTranscript?.(state.transcript, state.verdict, 'accepted-abandon')
    props.onAbandon?.(state.verdict)
    void recordSettled(recorded).then(() => {
      try {
        chrome.runtime.sendMessage({ type: 'WHYBUY_CLOSE_TAB' })
      } catch (e) {
        console.warn('[WhyBuy] failed to send WHYBUY_CLOSE_TAB:', e)
      }
    })
  }

  const handleOverride = () => {
    if (!state.verdict) return
    props.tts?.interrupt()
    dispatch({ type: 'USER_OVERRIDES' })
    props.onTranscript?.(state.transcript, state.verdict, 'overridden-proceeded')
    props.onOverride?.(state.verdict)
  }

  const handleClose = () => {
    props.tts?.interrupt()
    props.onClose?.()
  }

  /**
   * Toggle the TTS mute. Persisted to settings so the choice
   * survives across trials. The voice button's onClick feeds us
   * the new desired muted state.
   */
  const handleTtsMuteToggle = async () => {
    if (!props.tts) return
    const next = !props.tts.isMuted()
    props.tts.setMuted(next)
    // Persist the new mute state.
    try {
      const raw = await chrome.storage.local.get('whybuy.settings.v1')
      const cur = raw['whybuy.settings.v1'] || {}
      const voice = cur.voice || null
      if (voice) {
        voice.muted = next
        await saveSettings({ ...cur, voice })
      }
    } catch {}
  }

  // === Render branches ===

  if (props.providerStatus.kind === 'unsupported') {
    return <UnsupportedOverlay reason={props.providerStatus.reason} onClose={handleClose} />
  }

  if ((state.phase === 'verdict' || state.phase === 'deliberation') && (state.verdict || state.phase === 'deliberation')) {
    return (
      <JudgeRoom
        verdict={state.verdict}
        product={state.product}
        cart={cart}
        onProceed={handleProceed}
        onAcceptLoss={handleAcceptLoss}
        onOverride={handleOverride}
        onCloseTab={handleCloseTab}
      />
    )
  }

  if ((state.phase as Phase) === 'loss' && state.verdict) {
    return (
      <LossScreen
        product={state.product}
        cart={cart}
        verdict={state.verdict}
        overridden={state.overridden}
        existingCooldown={props.existingCooldown}
        onClose={handleClose}
      />
    )
  }

  const isUserTurnNow =
    state.phase === 'user_1' || state.phase === 'user_2' || state.phase === 'user_3'

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      <Header
        product={state.product}
        cart={cart}
        round={state.round}
        phase={state.phase}
        totalRounds={TOTAL_ROUNDS}
        onClose={handleClose}
      />
      <ProductCardStack cart={cart} />
      <Bench
        phase={state.phase}
        downloadProgress={downloadProgress}
        providerName={props.providerName}
        callingAiSince={callingAiSince}
        lastError={lastError}
        onCancel={cancelInFlight}
      />
      <Panels
        transcript={state.transcript}
        streaming={state.streaming}
        phase={state.phase}
        product={state.product}
        cart={cart}
      />
      <Composer
        value={textDraft}
        onChange={setTextDraft}
        onSend={handleUserSend}
        round={state.round + (isUserTurnNow ? 1 : 0)}
        totalRounds={TOTAL_ROUNDS}
        enabled={isUserTurnNow}
        sttManager={sttManagerRef.current}
      />
      {state.phase === 'intro' && <IntroOverlay product={state.product} cart={cart} />}
      {props.tts && ttsSnap && (
        <VoiceButton
          snap={ttsSnap}
          onToggleMute={handleTtsMuteToggle}
        />
      )}
      {aiTimedOut && (
        <div
          style={{
            position: 'absolute',
            top: 80,
            right: 24,
            background: 'rgba(138,28,43,0.85)',
            color: '#f7eed7',
            padding: '6px 12px',
            borderRadius: 4,
            fontSize: 12,
            letterSpacing: '0.05em',
          }}
        >
          AI offline — scripted fallback
        </div>
      )}
      {props.existingCooldown && state.phase !== 'released' && (state.phase as string) !== 'loss' && (
        <CooldownGate cooldown={props.existingCooldown} tick={cooldownTick} phase={state.phase} />
      )}
    </div>
  )
}

function formatPriceFor(p: { price: number | null; currency: string | null }): string {
  if (p.price == null) return 'this price'
  const cur = p.currency ? p.currency + ' ' : ''
  return `${cur}${p.price.toFixed(2)}`
}

/**
 * Generate a UUID v4 string. Uses `crypto.randomUUID` when available
 * (secure context: https, http://localhost, http://127.0.0.1, chrome-
 * extension://), and falls back to a manual UUID v4 built from
 * `crypto.getRandomValues` otherwise. This keeps the trial working in
 * test fixtures served over `http://` on a non-secure hostname like
 * `amazon.localtest.me`.
 */
function newRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {}
  const c: any = typeof crypto !== 'undefined' ? crypto : null
  if (c && typeof c.getRandomValues === 'function') {
    const b = new Uint8Array(16)
    c.getRandomValues(b)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  // Last-resort fallback: timestamp + Math.random.
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}-${Math.random().toString(16).slice(2, 14)}`
}
