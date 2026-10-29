import { selectProvider, type AIProvider, type Cart, type ChatMessage, type JudgeCallOptions, type Product, type Verdict } from '@/lib/ai/provider.ts'
import { prosecutionSystemPrompt, judgeSystemPrompt, type PromptDetail, type JudgeMode } from '@/lib/ai/prompts.ts'
import { buildCounselOpeningUserPrompt, buildCounselRebuttalUserPrompt } from '@/lib/ai/counselUserPrompt.ts'
import { applyTranscriptOverride } from '@/lib/ai/judgeParse.ts'
import { recordAiCall } from '@/lib/ai/debug.ts'
import { TRIAL_PORT, type TrialEvent, type TrialRequest } from '@/lib/messaging/bus.ts'
import { log, warn } from '@/lib/utils/log.ts'
import { defineBackground } from 'wxt/utils/define-background'
import { loadSettings } from '@/lib/storage/settings.ts'

function getProvider(byok: import('@/lib/ai/types').ByokConfig | null = null): Promise<AIProvider> {
  // Always re-evaluate so the latest BYOK setting is honored.
  return selectProvider(byok)
}

function describeProvider(p: AIProvider): string {
  const kind = p.kind
  const name = (p as any).name ?? ''
  return `${kind}${name ? `(${name})` : ''}`
}

/**
 * Active in-flight requests keyed by requestId, with their AbortControllers
 * so the trial UI can cancel. Cleared when the request resolves or is
 * cancelled.
 */
const inflight = new Map<string, AbortController>()

export default defineBackground(() => {
  log('WhyBuy background service worker booted')

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== TRIAL_PORT) return
    port.onDisconnect.addListener(() => {
      // Cancel any in-flight requests on this port so we don't leak
      // open fetch() calls when the content script unmounts.
      for (const [id, ctrl] of inflight) {
        try { ctrl.abort() } catch {}
        inflight.delete(id)
      }
    })
    port.onMessage.addListener((msg: TrialRequest) => {
      // Heartbeat: just acknowledging keeps the SW alive.
      if (msg.type === 'PING') {
        send(port, { type: 'PONG', requestId: msg.requestId })
        return
      }
      if (msg.type === 'CANCEL') {
        const ctrl = inflight.get(msg.requestId)
        if (ctrl) {
          try { ctrl.abort() } catch {}
          inflight.delete(msg.requestId)
          send(port, { type: 'CANCELLED', requestId: msg.requestId })
        }
        return
      }
      handleRequest(msg, port).catch((err) => {
        const rid = (msg as any).requestId
        send(port, { type: 'ERROR', message: String(err), requestId: rid })
      })
    })
  })

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'WHYBUY_GET_PROVIDER_STATUS') {
      handleStatus()
        .then((status) => sendResponse(status))
        .catch((err) => sendResponse({ kind: 'unsupported', reason: String(err) }))
      return true
    }
    // Close the tab that sent this message. Used by the verdict
    // screen's "I accept the ruling" button after its 3-second
    // countdown completes. The content script doesn't have the
    // chrome.tabs permission, so it asks the background to do it.
    if (msg && msg.type === 'WHYBUY_CLOSE_TAB') {
      const tabId = sender.tab?.id
      if (tabId != null) {
        chrome.tabs.remove(tabId).catch((err) => {
          warn('WHYBUY_CLOSE_TAB: tabs.remove failed:', err)
        })
        sendResponse({ ok: true })
      } else {
        sendResponse({ ok: false, reason: 'no-tab-id' })
      }
      return false
    }
    return false
  })
})

async function handleStatus() {
  const settings = await loadSettings()
  const provider = await getProvider(settings.byok)
  const status = await provider.status()
  return { ...status, provider: provider.kind, name: (provider as any).name }
}

/**
 * Read the per-call prompt and judge options from the user's settings.
 * `promptDetail` defaults to `'minimal'` (title+price). `judgeMode`
 * defaults to `'natural'` (line-based ruling). Both are user-
 * configurable in Options.
 */
async function resolveCallOptions(): Promise<{
  detail: PromptDetail
  judgeMode: JudgeMode
}> {
  const settings = await loadSettings()
  return {
    detail: settings.promptDetail === 'rich' ? 'rich' : 'minimal',
    judgeMode: settings.judgeMode === 'structured' ? 'structured' : 'natural',
  }
}

async function handleRequest(msg: TrialRequest, port: chrome.runtime.Port): Promise<void> {
  const settings = await loadSettings()
  const callOpts = await resolveCallOptions()
  log(
    'SW request:',
    msg.type,
    '| byok=',
    settings.byok ? `${settings.byok.provider}:${(settings.byok.model || '').slice(0, 30)}` : 'none',
    '| keySet=',
    !!settings.byok?.apiKey,
    '| detail=',
    callOpts.detail,
    '| judgeMode=',
    callOpts.judgeMode,
  )
  const provider = await getProvider(settings.byok)
  const status = await provider.status()
  log('SW provider picked:', describeProvider(provider), '| status=', status.kind)
  send(port, { type: 'PROVIDER_STATUS', ...status, provider: provider.kind } as TrialEvent)

  if (msg.type === 'GET_PROVIDER_STATUS') return

  const requestId = (msg as any).requestId as string | undefined
  const ctrl = new AbortController()
  if (requestId) inflight.set(requestId, ctrl)

  try {
    switch (msg.type) {
      case 'OPENING':
        await runCounsel(provider, msg.product, msg.cart ?? null, [], port, requestId, ctrl.signal, callOpts)
        return
      case 'PROSECUTION_TURN':
        await runCounsel(provider, msg.product, msg.cart ?? null, msg.transcript, port, requestId, ctrl.signal, callOpts)
        return
      case 'JUDGE': {
        const { verdict, reasoning } = await runJudge(
          provider,
          msg.product,
          msg.cart ?? null,
          msg.transcript,
          (text) => send(port, { type: 'JUDGE_REASONING_CHUNK', text, requestId: requestId ?? '' } as TrialEvent),
          requestId,
          ctrl.signal,
          callOpts,
        )
        log('SW runJudge reasoningLen=', reasoning.length, '| first200=', reasoning.slice(0, 200))
        send(port, { type: 'VERDICT', verdict, requestId } as TrialEvent)
        return
      }
      default:
        warn('Unknown request:', msg)
    }
  } catch (err) {
    if ((err as any)?.name === 'AbortError') {
      log('SW request aborted:', requestId)
      send(port, { type: 'CANCELLED', requestId } as TrialEvent)
      return
    }
    send(port, { type: 'ERROR', message: err instanceof Error ? err.message : String(err), requestId } as TrialEvent)
  } finally {
    if (requestId) inflight.delete(requestId)
  }
}

async function runCounsel(
  provider: AIProvider,
  product: Product,
  cart: Cart | null,
  transcript: ChatMessage[],
  port: chrome.runtime.Port,
  requestId: string | undefined,
  signal: AbortSignal,
  callOpts: { detail: PromptDetail; judgeMode: JudgeMode },
): Promise<void> {
  const systemPrompt = prosecutionSystemPrompt(product, cart, { detail: callOpts.detail })
  const cartSummary = cart
    ? `${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}: ${cart.items
        .map((i) => `${i.name}${i.price != null ? ` (${i.price})` : ''}`)
        .join(' | ')}`
    : 'no cart'
  log('SW runCounsel kind=', provider.kind, '| historyLen=', transcript.length, '| requestId=', requestId, '| subject=', cartSummary)
  let lastSent = ''
  const t0 = Date.now()
  const text = await provider.counselTurn(
    {
      systemPrompt,
      history: transcript,
      product,
      cart,
      speaker: 'prosecution',
    },
    (chunk) => {
      if (chunk !== lastSent) {
        lastSent = chunk
        send(port, { type: 'STREAM_CHUNK', text: chunk, requestId: requestId ?? '' } as TrialEvent)
      }
    },
    signal,
  )
  log('SW runCounsel done in', Date.now() - t0, 'ms | textLen=', text.length, '| first120=', text.slice(0, 120))
  const final = text || lastSent
  if (final !== lastSent) {
    send(port, { type: 'STREAM_CHUNK', text: final, requestId: requestId ?? '' } as TrialEvent)
  }
  send(port, { type: 'STREAM_END', text: final, requestId: requestId ?? '' } as TrialEvent)

  // Capture the prompt + response for the debug panel.
  recordAiCall({
    ts: Date.now(),
    kind: 'counsel',
    detail: callOpts.detail,
    systemPrompt,
    userPrompt: buildCounselUserPrompt(transcript, product, cart),
    responseText: final,
    requestId,
  })
}

async function runJudge(
  provider: AIProvider,
  product: Product,
  cart: Cart | null,
  transcript: ChatMessage[],
  onReasoning: (text: string) => void,
  requestId: string | undefined,
  signal: AbortSignal,
  callOpts: { detail: PromptDetail; judgeMode: JudgeMode },
): Promise<{ verdict: Verdict; reasoning: string }> {
  const systemPrompt = judgeSystemPrompt(product, cart, { judgeMode: callOpts.judgeMode })
  const cartSummary = cart
    ? `${cart.itemCount} item${cart.itemCount === 1 ? '' : 's'}: ${cart.items
        .map((i) => `${i.name}${i.price != null ? ` (${i.price})` : ''}`)
        .join(' | ')}`
    : 'no cart'
  log(
    'SW runJudge kind=',
    provider.kind,
    '| judgeMode=',
    callOpts.judgeMode,
    '| transcriptLen=',
    transcript.length,
    '| requestId=',
    requestId,
    '| subject=',
    cartSummary,
  )
  const t0 = Date.now()

  const opts: JudgeCallOptions = { judgeMode: callOpts.judgeMode }
  let result: { verdict: Verdict; reasoning: string }
  if (typeof (provider as any).streamJudgeVerdict === 'function') {
    result = await (provider as any).streamJudgeVerdict(
      { systemPrompt, transcript, product, cart },
      onReasoning,
      signal,
      opts,
    )
  } else {
    const verdict = await provider.judgeVerdict({ systemPrompt, transcript, product, cart }, signal, opts)
    result = { verdict, reasoning: verdict.summary ?? '' }
  }
  // Apply transcript-pattern override: when the user has stated a
  // concrete, specific use case anywhere in the trial AND the model
  // ruled restraint, force PURCHASE at 0.85+. This is the user's
  // explicit guarantee: "It should let you purchase if it identifies
  // any sense of actual need." The model still has a residual
  // restraint bias even with the reflection-session reframe; this
  // code-level post-processor is the guarantee. See applyTranscriptOverride
  // in lib/ai/judgeParse.ts for the pattern set and conservative rules.
  result = { ...result, verdict: applyTranscriptOverride(result.verdict, transcript) }
  log(
    'SW runJudge done in',
    Date.now() - t0,
    'ms | decision=',
    result.verdict.decision,
    '| conf=',
    result.verdict.confidence,
    '| summary=',
    result.verdict.summary.slice(0, 120),
  )

  recordAiCall({
    ts: Date.now(),
    kind: 'judge',
    judgeMode: callOpts.judgeMode,
    systemPrompt,
    userPrompt: buildJudgeUserPrompt(transcript, callOpts.judgeMode),
    responseText: result.reasoning + '\n\n' + result.verdict.summary,
    verdict: result.verdict,
    requestId,
  })

  return result
}

/**
 * Build the user-prompt body for a counsel turn, mirrored from the
 * provider's `counselTurn` body. Captured for the debug panel so the
 * user can see exactly what was sent to the model.
 */
function buildCounselUserPrompt(transcript: ChatMessage[], product: Product, cart: Cart | null): string {
  const turn = transcript.filter((m) => m.role === 'prosecution').length + 1
  if (transcript.length === 0) {
    return buildCounselOpeningUserPrompt(product, cart)
  }
  return buildCounselRebuttalUserPrompt(product, cart, turn)
}

function buildJudgeUserPrompt(transcript: ChatMessage[], mode: JudgeMode): string {
  const t = transcript
    .map((m) => {
      const tag = m.role === 'prosecution' ? 'PROSECUTION' : m.role === 'defense' ? 'DEFENSE' : 'JUDGE'
      return `${tag}: ${m.text}`
    })
    .join('\n\n')
  const tail =
    mode === 'natural'
      ? 'Write your ruling in the DECISION/CONFIDENCE/REASONING/SUMMARY/FACTORS shape. No prose before or after the ruling.'
      : 'Write your step-by-step analysis in a single <think>...</think> block, then deliver your verdict as strict JSON.'
  return `FULL TRANSCRIPT:\n${t}\n\n${tail}`
}

function send(port: chrome.runtime.Port, ev: TrialEvent): void {
  try {
    port.postMessage(ev)
  } catch (e) {
    warn('Failed to post message to port:', e)
  }
}
