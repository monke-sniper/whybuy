import type { AIProvider, Cart, ChatMessage, ByokConfig, ByokProvider, Product, ProviderStatus, Verdict } from './types.ts'
import { log, warn } from '../utils/log.ts'
import { splitThinkBlocks } from './think.ts'
import { parseNaturalVerdict, verdictFromNatural, type NaturalParseResult } from './judgeParse.ts'
import { buildCounselSubjectLine, buildCounselOpeningUserPrompt, buildCounselRebuttalUserPrompt } from './counselUserPrompt.ts'

// Re-export for tests / callers that import from byok.
export { splitThinkBlocks }
export { parseNaturalVerdict, verdictFromNatural } from './judgeParse.ts'
export { normalizeDecision, clampConfidence, fallbackVerdict } from './verdictHelpers.ts'

/**
 * BYOK (bring-your-own-key) provider. Speaks the OpenAI Chat Completions
 * protocol, which is supported by:
 *   - Google Gemini via `https://generativelanguage.googleapis.com/.../v1beta/openai/`
 *   - Groq       via `https://api.groq.com/openai/v1/`
 *   - OpenRouter via `https://openrouter.ai/api/v1/`
 *   - Ollama     via `http://localhost:11434/v1/` (no key needed)
 *
 * The streaming response is parsed line-by-line as SSE-style chunks.
 *
 * The judge always writes a line-based ruling (DECISION/CONFIDENCE/
 * REASONING/SUMMARY/FACTORS), which works on every model, including
 * non-reasoning ones like `ministral-3:8b`. The historical
 * `<think>`+JSON judge mode was retired; a stored `judgeMode: 'structured'`
 * is treated as `'natural'`.
 */

interface ChatMessageWire {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface ProviderConfig {
  baseUrl: string
  defaultModel: string
  freeTier: string
  keyUrl: string
  needsKey: boolean
}

const PROVIDERS: Record<ByokProvider, ProviderConfig> = {
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    freeTier: '15 RPM, 1M TPM, 1500 RPD — generous free tier',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    freeTier: 'Free developer tier with rate limits',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    freeTier: 'Free models with rate limits (paid models also available)',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.2',
    freeTier: 'Fully free, runs on your machine (no key required)',
    keyUrl: 'https://ollama.com/download',
    needsKey: false,
  },
  'ollama-cloud': {
    baseUrl: 'https://ollama.com/v1',
    defaultModel: 'ministral-3:3b',
    freeTier: 'Free tier with rate limits (cloud) — sign in at ollama.com',
    keyUrl: 'https://ollama.com/settings/keys',
    needsKey: true,
  },
}

interface StatusCacheEntry {
  result: Promise<ProviderStatus>
  expires: number
  pending: boolean
}

const STATUS_OK_TTL_MS = 60 * 1000
const STATUS_PROBE_TIMEOUT_MS = 10 * 1000
const STATUS_ERR_TTL_MS = 10 * 1000
const statusCache = new Map<string, StatusCacheEntry>()

/** Test hook: forget cached provider probes. */
export function clearByokStatusCache(): void {
  statusCache.clear()
}

export class BYOK implements AIProvider {
  readonly kind = 'byok' as const
  readonly name: string
  private cfg: ByokConfig

  constructor(cfg: ByokConfig) {
    this.cfg = cfg
    this.name = `${cfg.provider}${cfg.model ? ` (${cfg.model})` : ''}`
  }

  static providerInfo(p: ByokProvider) {
    return PROVIDERS[p]
  }

  private get endpoint() {
    const base = this.cfg.baseUrl || PROVIDERS[this.cfg.provider].baseUrl
    return base.replace(/\/$/, '') + '/chat/completions'
  }

  private get model(): string {
    return this.cfg.model || PROVIDERS[this.cfg.provider].defaultModel
  }

  /** The model used for the judge. Falls back to the counsel model. */
  private get judgeModel(): string {
    return this.cfg.judgeModel || this.model
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.cfg.apiKey) {
      h['Authorization'] = `Bearer ${this.cfg.apiKey}`
    }
    return h
  }

  /**
   * Provider readiness. The network probe is a real (billable,
   * rate-limited) one-token completion, so the result is cached per
   * endpoint+model+key and concurrent callers share one in-flight probe.
   * Pass `{ fresh: true }` for an explicit "Test connection".
   */
  async status(opts: { fresh?: boolean } = {}): Promise<ProviderStatus> {
    if (PROVIDERS[this.cfg.provider].needsKey && !this.cfg.apiKey) {
      return { kind: 'needs-key' }
    }
    const key = `${this.endpoint}|${this.model}|${this.cfg.apiKey ?? ''}`
    if (opts.fresh) statusCache.delete(key)
    const hit = statusCache.get(key)
    if (hit && (hit.pending || Date.now() < hit.expires)) return hit.result
    const entry: StatusCacheEntry = { result: this.probe(), expires: 0, pending: true }
    statusCache.set(key, entry)
    const result = await entry.result
    entry.pending = false
    entry.expires = Date.now() + (result.kind === 'ready' ? STATUS_OK_TTL_MS : STATUS_ERR_TTL_MS)
    return result
  }

  private async probe(): Promise<ProviderStatus> {
    try {
      // Lightweight ping: ask the model to echo one token.
      const r = await fetch(this.endpoint, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
        // A hung probe must settle, or every later status check would share it.
        signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        return { kind: 'error', reason: `Provider returned ${r.status}: ${text.slice(0, 200)}` }
      }
      return { kind: 'ready' }
    } catch (e) {
      return { kind: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
  }

  async ensureReady(): Promise<void> {
    const s = await this.status()
    if (s.kind === 'error' || s.kind === 'needs-key') {
      throw new Error(s.kind === 'needs-key' ? 'API key required' : s.reason)
    }
  }

  async counselTurn(
    args: { systemPrompt: string; history: ChatMessage[]; product: Product; cart: Cart | null; speaker: 'prosecution' | 'defense' },
    onChunk: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (args.speaker === 'defense') return ''

    const messages: ChatMessageWire[] = [{ role: 'system', content: args.systemPrompt }]
    for (const m of args.history) {
      messages.push({
        role: m.role === 'prosecution' ? 'assistant' : 'user',
        content: m.text,
      })
    }
    // The product title is baked INTO the user message (not just the
    // system prompt) so small / non-reasoning models like
    // `ministral-3:8b` actually see it at the point of generation.
    const turn = args.history.filter((m) => m.role === 'prosecution').length + 1
    const userMsg =
      args.history.length === 0
        ? buildCounselOpeningUserPrompt(args.product, args.cart)
        : buildCounselRebuttalUserPrompt(args.product, args.cart, turn)
    messages.push({ role: 'user', content: userMsg })

    return this.streamChat(messages, onChunk, signal, { tag: 'counsel' })
  }

  private buildSubjectLine(product: Product, cart: Cart | null): string {
    return buildCounselSubjectLine(product, cart)
  }

  async judgeVerdict(
    args: { systemPrompt: string; transcript: ChatMessage[]; product: Product; cart: Cart | null },
    signal?: AbortSignal,
  ): Promise<Verdict> {
    const messages = this.buildJudgeMessages(args)
    const text = await this.nonStreamChat(messages, signal, { modelOverride: this.judgeModel })
    // Both 'natural' and 'structured' judge modes use the same
    // paragraph + ruling line shape now.
    const parsed = parseNaturalVerdict(text)
    return verdictFromNatural(parsed, 'judge returned no ruling')
  }

  /**
   * Stream the judge's verdict.
   *
   * Two output modes:
   *
   * - `'natural'` (default): the model streams a line-based ruling. On
   *   every chunk we re-parse the running accumulator and push the
   *   `REASONING:` body to the `onReasoning` callback. When the parser
   *   sees a complete ruling (decision + confidence + summary + three
   *   factors) we resolve with `{ verdict, reasoning }`.
   *
   * - `'structured'`: the model streams a `<think>...</think>` block
   *   followed by a JSON verdict. The `onReasoning` callback receives
   *   the running think-block body; we parse the JSON on completion.
   *   If the stream comes back empty (Ollama Cloud `gpt-oss:20b`
   *   quirk) we fall back to non-streaming and re-use the response's
   *   `reasoning` field.
   */
  async streamJudgeVerdict(
    args: { systemPrompt: string; transcript: ChatMessage[]; product: Product; cart: Cart | null },
    onReasoning: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{ verdict: Verdict; reasoning: string }> {
    const messages = this.buildJudgeMessages(args)
    const t0 = Date.now()
    // Both 'natural' and 'structured' judge modes use the same
    // paragraph + ruling line shape now (the structured path was
    // removed because small / non-reasoning models couldn't follow
    // it, and reasoning models wasted their tokens on internal
    // chain-of-thought the user couldn't act on).
    return this.streamJudgeNatural(messages, onReasoning, signal, t0)
  }

  /**
   * Natural-mode streaming: the parser is a state machine, but because
   * the labels are line-anchored we can re-parse the whole accumulator
   * on every chunk. The cost is O(n) per chunk and is negligible for
   * typical verdict sizes (<4 KB).
   */
  private async streamJudgeNatural(
    messages: ChatMessageWire[],
    onReasoning: (text: string) => void,
    signal: AbortSignal | undefined,
    t0: number,
  ): Promise<{ verdict: Verdict; reasoning: string }> {
    let acc = ''
    let lastReasoning = ''
    let lastResult: NaturalParseResult = { decision: null, confidence: null, reasoning: '', summary: '', factors: [], partial: true }
    let resolved: { verdict: Verdict; reasoning: string } | null = null

    const onDelta = (delta: string) => {
      acc += delta
      const parsed = parseNaturalVerdict(acc)
      if (parsed.reasoning !== lastReasoning) {
        lastReasoning = parsed.reasoning
        onReasoning(lastReasoning)
      }
      lastResult = parsed
      if (
        !resolved &&
        parsed.decision &&
        parsed.confidence != null &&
        parsed.summary.length > 0 &&
        parsed.factors.length === 3
      ) {
        resolved = {
          verdict: verdictFromNatural(parsed),
          reasoning: parsed.reasoning,
        }
      }
    }

    try {
      await this.streamRaw(messages, signal, { tag: 'judge-natural', onDelta, modelOverride: this.judgeModel, temperature: 0.3 })
    } catch (e) {
      if (!resolved) throw e
      // We've already got a complete verdict; swallow any post-ruling
      // error (e.g. the user aborted) so the caller still gets the
      // verdict rather than an exception.
    }

    // Resolve from whatever we have. If we never got a complete ruling
    // (model ran out of tokens, was cut off, etc.), still produce a
    // best-effort verdict from the partial result.
    const result = resolved ?? {
      verdict: verdictFromNatural(lastResult, 'natural judge stream ended without a complete ruling'),
      reasoning: lastResult.reasoning,
    }
    log(
      'BYOK streamJudgeNatural done in',
      Date.now() - t0,
      'ms | decision=',
      result.verdict.decision,
      '| conf=',
      result.verdict.confidence,
      '| summary=',
      result.verdict.summary.slice(0, 120),
    )
    return result
  }

  /**
   * Build the chat-message payload for the judge. The transcript is
   * rendered as a single user message; the system prompt is generated
   * by `judgeSystemPrompt(product, cart, { judgeMode })`.
   */
  private buildJudgeMessages(args: {
    systemPrompt: string
    transcript: ChatMessage[]
    product: Product
    cart: Cart | null
  }): ChatMessageWire[] {
    const messages: ChatMessageWire[] = [{ role: 'system', content: args.systemPrompt }]
    const transcript = args.transcript
      .map((m) => {
        const tag = m.role === 'prosecution' ? 'PROSECUTION' : m.role === 'defense' ? 'DEFENSE' : 'JUDGE'
        return `${tag}: ${m.text}`
      })
      .join('\n\n')
    const tail = 'Weigh the two arguments above. Your analysis can ONLY reference arguments the prosecution or the defense ACTUALLY MADE in the transcript — do not invent facts, do not assume the user\'s motivations, do not fabricate arguments neither side made. If the defense wrote something like "I want it" and nothing else, that IS their entire argument — say so plainly. Then end your response in this order: (1) the ruling line ("I rule in favor of the purchase." or "I rule in favor of restraint.") on its own line, (2) a CONFIDENCE: 0.XX line on its own line (e.g. CONFIDENCE: 0.78), and (3) a DECISIVE FACTORS: header followed by exactly 3 bullet points, one per line, each referencing something the prosecution or defense actually said. Nothing else after the bullets. See the system prompt for the full format and the confidence calibration.'
    messages.push({ role: 'user', content: `FULL TRANSCRIPT (this is the ONLY evidence; you may not reference anything outside it):\n${transcript}\n\n${tail}` })
    return messages
  }

  private async streamChat(messages: ChatMessageWire[], onChunk: (t: string) => void, signal?: AbortSignal, opts: { tag: string } = { tag: 'chat' }): Promise<string> {
    return this.streamRaw(messages, signal, { ...opts, onChunk })
  }

  /**
   * Generic streaming helper. Returns the full accumulated text. If
   * `onChunk` is given, it's called with the running text on every delta
   * (suitable for the counsel panels). For the judge, the caller can
   * pass nothing here and split `<think>` blocks out of the returned
   * string.
   */
  private async streamRaw(
    messages: ChatMessageWire[],
    signal: AbortSignal | undefined,
    opts: { tag: string; onChunk?: (text: string) => void; onDelta?: (delta: string) => void; modelOverride?: string; temperature?: number },
  ): Promise<string> {
    const model = opts.modelOverride || this.model
    log('BYOK fetch', this.cfg.provider, model, '->', this.endpoint, '| tag=', opts.tag, '| msgs=', messages.length, '| keySet=', !!this.cfg.apiKey)
    const t0 = Date.now()
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.85,
      }),
      signal,
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      warn('BYOK stream failed (', r.status, '):', errText.slice(0, 300))
      throw new Error(`BYOK stream failed (${r.status}): ${errText.slice(0, 200)}`)
    }
    const tOpened = Date.now() - t0
    log('BYOK stream opened in', tOpened, 'ms (tag=', opts.tag, ')')
    const reader = r.body?.getReader()
    if (!reader) throw new Error('BYOK: no response body')

    const decoder = new TextDecoder()
    let acc = ''
    let buffer = ''
    let chunks = 0
    let tFirstChunk: number | null = null
    let lastLog = Date.now()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (tFirstChunk == null) {
        tFirstChunk = Date.now() - t0
        log('BYOK first chunk in', tFirstChunk, 'ms (open=', tOpened, 'ms)')
      }
      chunks++
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const obj = JSON.parse(payload)
          const delta = obj.choices?.[0]?.delta?.content
          if (typeof delta === 'string' && delta.length > 0) {
            acc += delta
            opts.onChunk?.(acc)
            opts.onDelta?.(delta)
          }
        } catch {
          // ignore parse errors on partial lines
        }
      }
      // Heartbeat log every 5s during a long stream.
      if (Date.now() - lastLog > 5000) {
        log('BYOK streaming: chunks=', chunks, '| bytes_so_far=', acc.length, '| tag=', opts.tag)
        lastLog = Date.now()
      }
    }
    log('BYOK stream done: chunks=', chunks, '| total=', Date.now() - t0, 'ms | textLen=', acc.length, '| tag=', opts.tag)
    return acc
  }

  private async nonStreamChat(
    messages: ChatMessageWire[],
    signal?: AbortSignal,
    opts: { modelOverride?: string; temperature?: number } = {},
  ): Promise<string> {
    const data = await this.nonStreamChatRaw(messages, signal, opts)
    return (data?.choices?.[0]?.message?.content ?? '') as string
  }

  /**
   * Like `nonStreamChat` but returns the full parsed JSON response, so
   * callers can read non-standard fields like `reasoning` (used by
   * Ollama Cloud for thinking models that expose reasoning out-of-band
   * of the OpenAI-compat spec).
   */
  private async nonStreamChatRaw(
    messages: ChatMessageWire[],
    signal?: AbortSignal,
    opts: { modelOverride?: string; temperature?: number } = {},
  ): Promise<any> {
    const model = opts.modelOverride || this.model
    const t0 = Date.now()
    const r = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.3,
      }),
      signal,
    })
    const tEnd = Date.now() - t0
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      warn('BYOK chat failed (', r.status, ') in', tEnd, 'ms:', errText.slice(0, 300))
      throw new Error(`BYOK chat failed (${r.status}): ${errText.slice(0, 200)}`)
    }
    const data = await r.json()
    log('BYOK non-stream done in', tEnd, 'ms | model=', model, '| textLen=', data.choices?.[0]?.message?.content?.length ?? 0)
    return data
  }
}
