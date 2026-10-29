import type { AIProvider, Cart, ChatMessage, JudgeCallOptions, ProviderStatus, Verdict } from './types.ts'
import type { Product } from './types.ts'
import { parseNaturalVerdict, verdictFromNatural } from './judgeParse.ts'
import { fallbackVerdict } from './verdictHelpers.ts'
import { buildCounselSubjectLine, buildCounselOpeningUserPrompt } from './counselUserPrompt.ts'

/**
 * Adapter for Chrome's built-in Prompt API (Gemini Nano).
 *
 * Two globals may be exposed, in this order of preference:
 *   1. `LanguageModel` (newer)
 *   2. `window.ai.languageModel` (older)
 *
 * Both expose a similar factory: create / createTextSession, canCreate, etc.
 */

type Session = {
  prompt: (text: string) => Promise<string>
  promptStreaming: (text: string) => Promise<AsyncIterable<string>>
  destroy: () => void
}

type SessionFactory = {
  availability: (opts?: { systemPrompt?: string }) => Promise<
    | 'unavailable'
    | 'downloadable'
    | 'downloading'
    | 'available'
  >
  create: (opts?: {
    systemPrompt?: string
    temperature?: number
    topK?: number
    outputLanguage?: string
    monitor?: (m: any) => void
  }) => Promise<Session>
}

declare global {
  interface Window {
    ai?: {
      languageModel?: SessionFactory & { canCreateTextSession?: () => Promise<string> }
    }
  }
  // Top-level LanguageModel (newer API). `var` is required for a global
  // augmentation; `let`/`const` are not allowed here.
  var LanguageModel: (SessionFactory & { availability?: (opts?: any) => Promise<any> }) | undefined
}

function getFactory(): SessionFactory | null {
  // 1. LanguageModel (newer)
  if (typeof self !== 'undefined' && (self as any).LanguageModel) {
    const LM = (self as any).LanguageModel
    if (typeof LM.availability === 'function' && typeof LM.create === 'function') {
      return LM as SessionFactory
    }
  }
  // 2. window.ai.languageModel
  if (typeof self !== 'undefined' && self.ai?.languageModel) {
    return self.ai.languageModel as SessionFactory
  }
  return null
}

/**
 * Default judge mode for the Prompt API. `'natural'` is the safe
 * default — the on-device Gemini Nano model is small and benefits from
 * a simpler line-based prompt.
 */
const DEFAULT_JUDGE_MODE: 'natural' | 'structured' = 'natural'

export class PromptApiProvider implements AIProvider {
  readonly kind = 'prompt-api' as const
  private factory: SessionFactory | null = null
  private session: Session | null = null
  private sessionKey: string | null = null

  private async factoryOrNull(): Promise<SessionFactory | null> {
    if (this.factory) return this.factory
    this.factory = getFactory()
    return this.factory
  }

  async status(): Promise<ProviderStatus> {
    const f = await this.factoryOrNull()
    if (!f) {
      return {
        kind: 'unsupported',
        reason: 'Chrome AI (Prompt API) is not exposed in this build of Chrome.',
      }
    }
    try {
      const a = await f.availability()
      if (a === 'available') return { kind: 'ready' }
      if (a === 'downloadable' || a === 'downloading') return { kind: 'needs-download' }
      return {
        kind: 'unsupported',
        reason:
          'Chrome AI is not available on this device. The on-device Gemini Nano model is not supported on your platform or has been disabled.',
      }
    } catch (e) {
      return { kind: 'unsupported', reason: String(e) }
    }
  }

  async ensureReady(onProgress?: (pct: number) => void): Promise<void> {
    const status = await this.status()
    if (status.kind === 'ready') return
    if (status.kind === 'unsupported') {
      throw new Error(status.reason)
    }
    // needs-download: create a session with monitor to surface progress.
    const f = await this.factoryOrNull()
    if (!f) throw new Error('Prompt API not available')
    const monitor = (m: any) => {
      try {
        const event = m?.addEventListener
        if (typeof event === 'function') {
          event.call(m, 'downloadprogress', (e: any) => {
            if (typeof e?.loaded === 'number' && onProgress) {
              onProgress(e.loaded)
            }
          })
        }
      } catch {
        // Ignore monitor failures; we'll still wait.
      }
    }
    const s = await f.create({ monitor })
    // We don't keep this session — we just trigger the download.
    try {
      s.destroy?.()
    } catch {}
  }

  private async getSession(systemPrompt: string): Promise<Session> {
    const f = await this.factoryOrNull()
    if (!f) throw new Error('Prompt API not available')
    if (this.session && this.sessionKey === systemPrompt) return this.session

    if (this.session) {
      try {
        this.session.destroy?.()
      } catch {}
      this.session = null
    }
    this.session = await f.create({ systemPrompt, temperature: 0.85, topK: 40, outputLanguage: 'en' })
    this.sessionKey = systemPrompt
    return this.session
  }

  private buildUserPrompt(history: ChatMessage[], product: Product, cart: Cart | null, speaker: 'prosecution' | 'defense'): string {
    const subjectLine = buildCounselSubjectLine(product, cart)
    const transcript = history
      .map((m) => {
        const tag = m.role === 'prosecution' ? 'PROSECUTION' : m.role === 'defense' ? 'DEFENSE' : 'JUDGE'
        return `${tag}: ${m.text}`
      })
      .join('\n\n')
    const turn = history.filter((m) => m.role === speaker).length + 1
    if (speaker === 'prosecution') {
      if (history.length === 0) {
        return buildCounselOpeningUserPrompt(product, cart)
      }
      // Category-first, not title-every-turn. Mirrors
      // buildCounselRebuttalUserPrompt in counselUserPrompt.ts —
      // duplicated here because the Chrome on-device path doesn't
      // reuse that builder (it composes the user message from the
      // transcript + a per-turn instruction string). The previous
      // version of this rule told the model to "use the title (or
      // its first two words) every turn", which produced robotic,
      // repetitive output. The user wanted the CATEGORY word.
      return (
        `${subjectLine}\n\n` +
        `TRANSCRIPT SO FAR:\n${transcript}\n\n` +
        `The defense just spoke. Rebut their point and introduce one new angle.\n` +
        `- Call the thing by its CATEGORY ("shoes" / "the hub" / "the mouse" / "headphones" / etc.), NOT the full brand+model title. The user is sick of hearing the full title repeated every turn.\n` +
        `- After the first mention in this turn, "it" / "this" / "that" is fine.\n` +
        `- Brand is a rare exception. For most products, NEVER mention the brand at all in this turn.\n` +
        `- 2 to 3 sentences. Punchy. This is prosecution turn ${turn}.\n` +
        `- NEVER use courtroom language. NEVER use "this product" / "this item" / "the item" / "this thing" as a noun. Say the category word, or "it".`
      )
    }
    return transcript
  }

  async counselTurn(
    args: { systemPrompt: string; history: ChatMessage[]; product: Product; cart: Cart | null; speaker: 'prosecution' | 'defense' },
    onChunk: (text: string) => void,
  ): Promise<string> {
    if (args.speaker === 'defense') {
      // Defense is the user; we never generate for them.
      return ''
    }
    const session = await this.getSession(args.systemPrompt)
    const userPrompt = this.buildUserPrompt(args.history, args.product, args.cart, args.speaker)

    // Try streaming first.
    try {
      const stream = await session.promptStreaming(userPrompt)
      let acc = ''
      for await (const chunk of stream) {
        acc += chunk
        onChunk(acc)
      }
      return acc
    } catch {
      // Fall back to non-streaming.
      const text = await session.prompt(userPrompt)
      onChunk(text)
      return text
    }
  }

  async judgeVerdict(
    args: { systemPrompt: string; transcript: ChatMessage[]; product: Product; cart: Cart | null },
    signal?: AbortSignal,
    opts?: JudgeCallOptions,
  ): Promise<Verdict> {
    const mode: 'natural' | 'structured' = opts?.judgeMode === 'structured' ? 'structured' : DEFAULT_JUDGE_MODE
    // Use a fresh session with the chosen system prompt, no streaming.
    const f = await this.factoryOrNull()
    if (!f) throw new Error('Prompt API not available')

    const session = await f.create({ systemPrompt: args.systemPrompt, temperature: 0.3, topK: 20, outputLanguage: 'en' })

    const transcript = args.transcript
      .map((m) => {
        const tag = m.role === 'prosecution' ? 'PROSECUTION' : m.role === 'defense' ? 'DEFENSE' : 'JUDGE'
        return `${tag}: ${m.text}`
      })
      .join('\n\n')

    const subjectLine = buildCounselSubjectLine(args.product, args.cart)

    const tail =
      // Both modes now use the same paragraph + ruling line shape.
      // The structured-mode option is kept for backwards compatibility
      // with stored settings; it no longer requires think/JSON.
      // The model now also emits a CONFIDENCE: 0.XX line and a
      // DECISIVE FACTORS list — see judgeParse.ts for the parser.
      'Weigh the two arguments above. Your analysis can ONLY reference arguments the prosecution or the defense ACTUALLY MADE in the transcript — do not invent facts, do not assume the user\'s motivations, do not fabricate arguments neither side made. If the defense wrote something like "I want it" and nothing else, that IS their entire argument — say so plainly. Then end your response in this order: (1) the ruling line ("I rule in favor of the purchase." or "I rule in favor of restraint.") on its own line, (2) a CONFIDENCE: 0.XX line on its own line (e.g. CONFIDENCE: 0.78), and (3) a DECISIVE FACTORS: header followed by exactly 3 bullet points, one per line, each referencing something the prosecution or defense actually said. Nothing else after the bullets. See the system prompt for the full format and the confidence calibration.'

    const userPrompt = `${subjectLine}\n\nFULL TRANSCRIPT (this is the ONLY evidence; you may not reference anything outside it):\n${transcript}\n\n${tail}`

    let text = await session.prompt(userPrompt)
    let verdict: Verdict | null = null
    const parsed = parseNaturalVerdict(text)
    verdict = verdictFromNatural(parsed, 'Prompt API returned an unparseable natural ruling')

    if (!verdict) {
      // Retry once with a stricter instruction.
      const retryUserPrompt =
        userPrompt +
        '\n\nRemember: end with EXACTLY one of these two lines, on its own line, with nothing after it: "I rule in favor of the purchase." or "I rule in favor of restraint."'
      const retry = await session.prompt(retryUserPrompt)
      text = retry
      const retryParsed = parseNaturalVerdict(retry)
      verdict = verdictFromNatural(retryParsed, 'Prompt API retry returned an unparseable natural ruling')
    }
    try {
      session.destroy?.()
    } catch {}
    if (!verdict) {
      // Final fallback: bail to a high-confidence abandon.
      return fallbackVerdict('Prompt API returned no parseable ruling after retry')
    }
    return verdict
  }
}

/**
 * Strict-JSON verdict parser. Used by the Prompt API in structured
 * mode. Mirrors the relevant subset of `byok.ts:parseStructuredVerdict`
 * but kept local to avoid dragging the BYOK implementation into the
 * Prompt API path.
 */
function tryParseStructured(raw: string): Verdict | null {
  if (!raw) return null
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()
  try {
    const obj = JSON.parse(cleaned)
    if (obj && (obj.decision === 'proceed' || obj.decision === 'abandon')) {
      const confidence = Number(obj.confidence)
        const summary = String(obj.summary ?? '')
      const factors = Array.isArray(obj.topFactors) ? obj.topFactors.slice(0, 3).map((x: any) => String(x)) : []
      if (
        typeof confidence === 'number' &&
        confidence >= 0 &&
        confidence <= 1 &&
        summary.length > 0 &&
        factors.length === 3
      ) {
        return {
          decision: obj.decision,
          confidence: Math.round(confidence * 100) / 100,
          summary,
          topFactors: factors as [string, string, string],
        }
      }
    }
  } catch {}
  return null
}

