import { clampConfidence, fallbackVerdict, normalizeDecision } from './verdictHelpers.ts'
import type { ChatMessage, Verdict } from './types.ts'

/**
 * Parser for the judge output.
 *
 * The model is asked to produce, in this exact order:
 *
 *   [3-5 sentence paragraph weighing the two arguments]
 *
 *   CONFIDENCE: 0.XX
 *   I rule in favor of the purchase.   (or: I rule in favor of restraint.)
 *
 *   DECISIVE FACTORS:
 *   - <factor 1, one short clause referencing the transcript>
 *   - <factor 2>
 *   - <factor 3>
 *
 * The parser:
 *   - finds the ruling line (case-insensitive, tolerant of trailing
 *     punctuation, tolerant of code fences / preambles via
 *     `sanitizeNaturalOutput`)
 *   - extracts CONFIDENCE from the explicit "CONFIDENCE: 0.XX" line
 *     (falls back to hedge detection if missing)
 *   - builds the verdict summary from the first 1-2 sentences of
 *     the paragraph
 *   - extracts the 3 DECISIVE FACTORS from the model output (falls
 *     back through: numbered list → derived from the paragraph →
 *     hardcoded strings as a last resort)
 *
 * The parser is idempotent and never throws. A failed parse
 * returns a `partial: true` result; the caller decides what to
 * fall back to.
 */
export interface NaturalParseResult {
  decision: 'proceed' | 'abandon' | null
  confidence: number | null
  /** The full paragraph the model wrote, sans the ruling line, CONFIDENCE line, and DECISIVE FACTORS list. */
  reasoning: string
  /** The first 1-2 sentences of the paragraph. Becomes `verdict.summary`. */
  summary: string
  /** Always exactly 3 factor strings once a decision is known. */
  factors: string[]
  /**
   * True while decision/confidence/summary/three factors are all
   * missing. The streaming loop polls this to know when to stop.
   */
  partial: boolean
}

/**
 * The exact ruling line strings the model is told to emit. We accept
 * any of these (case-insensitive) when looking for the ruling.
 */
const RULING_FOR_PURCHASE_RE = /^[ \t]*I[ \t]+rule[ \t]+in[ \t]+favor[ \t]+of[ \t]+the[ \t]+purchase\b[ \t]*[.!?]*[ \t]*$/im
const RULING_FOR_RESTRAINT_RE = /^[ \t]*I[ \t]+rule[ \t]+in[ \t]+favor[ \t]+of[ \t]+restraint\b[ \t]*[.!?]*[ \t]*$/im

/**
 * The CONFIDENCE: 0.XX line the model is told to emit. We extract
 * the first valid number after the "CONFIDENCE:" prefix.
 */
const CONFIDENCE_RE = /\bCONFIDENCE\s*:\s*(0?\.\d+|[01](?:\.0+)?)\b/i

/**
 * The DECISIVE FACTORS: header followed by a list of bullets. We
 * accept 1-5 bullets and trim to 3.
 */
const FACTORS_HEADER_RE = /\bDECISIVE\s+FACTORS\s*:\s*\n([\s\S]+?)(?:\n\s*\n|$)/i
const BULLET_RE = /^[ \t]*[-•*][ \t]+(.+)$/gm

/**
 * Parse a judge's response. Always returns a result object; never
 * throws. `partial` is true while decision/confidence/summary are
 * all missing.
 */
export function parseNaturalVerdict(raw: string): NaturalParseResult {
  if (!raw) return empty()

  const sanitized = sanitizeNaturalOutput(raw)

  // Find the ruling line. The model is told to put it on its own
  // line at the END of the response, but be lenient if it's
  // somewhere in the middle (some models don't follow the order).
  const purchaseMatch = sanitized.match(RULING_FOR_PURCHASE_RE)
  const restraintMatch = sanitized.match(RULING_FOR_RESTRAINT_RE)

  // Use whichever ruling line comes LAST in the text — the model
  // might write "I rule in favor of restraint" inside a sentence
  // describing the alternative, then "I rule in favor of the
  // purchase" as the actual ruling.
  let decision: 'proceed' | 'abandon' | null = null
  if (purchaseMatch && restraintMatch) {
    const purchaseIdx = sanitized.indexOf(purchaseMatch[0])
    const restraintIdx = sanitized.indexOf(restraintMatch[0])
    decision = purchaseIdx > restraintIdx ? 'proceed' : 'abandon'
  } else if (purchaseMatch) {
    decision = 'proceed'
  } else if (restraintMatch) {
    decision = 'abandon'
  } else {
    // No "I rule in favor of X" line. Try the lenient body search
    // for common synonyms the model might use when it forgets the
    // exact ruling phrasing.
    decision = lenientDecisionFromBody(sanitized)
  }

  // Extract the explicit CONFIDENCE: 0.XX line if present. Falls
  // back to hedge detection below if missing.
  const confidenceMatch = sanitized.match(CONFIDENCE_RE)
  const explicitConfidence = confidenceMatch ? clampConfidence(confidenceMatch[1]) : null

  // Extract the DECISIVE FACTORS list if present. Falls back
  // through numbered-list → paragraph-derived → hardcoded below.
  const explicitFactors = extractFactors(sanitized)

  // Strip the ruling line(s), CONFIDENCE line, and DECISIVE
  // FACTORS block from the body so the rest is the paragraph-only
  // reasoning.
  const body = sanitized
    .replace(RULING_FOR_PURCHASE_RE, '')
    .replace(RULING_FOR_RESTRAINT_RE, '')
    .replace(CONFIDENCE_RE, '')
    .replace(FACTORS_HEADER_RE, '')
    .trim()

  // Derive confidence. Prefer the explicit CONFIDENCE: line; fall
  // back to hedge detection in the paragraph.
  const confidence = decision
    ? explicitConfidence != null
      ? explicitConfidence
      : confidenceFromHedges(body)
    : null

  // Build the summary: first 1-2 sentences of the paragraph.
  const summary = buildSummary(body, decision)

  // Three decisive factors. Fall back through: explicit model
  // factors → numbered list → paragraph-derived → hardcoded.
  const factors = decision
    ? (explicitFactors.length === 3
        ? explicitFactors
        : explicitFactors.length > 0
          ? padFactors(explicitFactors, body, decision)
          : deriveFactorsFromParagraph(body, decision))
    : []

  const partial = !(decision && confidence != null && summary.length > 0 && factors.length === 3)

  return { decision, confidence, reasoning: body, summary, factors, partial }
}

/**
 * Build a 1-2 sentence summary from the body. If the body is
 * empty (model only emitted the ruling line), fall back to a
 * neutral phrasing that names the decision.
 */
function buildSummary(body: string, decision: 'proceed' | 'abandon' | null): string {
  if (!body) {
    if (decision === 'proceed') return 'The defense made the stronger case for the purchase.'
    if (decision === 'abandon') return 'The prosecution made the stronger case against the purchase.'
    return ''
  }
  // Take the first two sentence-ending chunks. "Sentence" is
  // anything ending in `.`, `!`, or `?`. If the body is one giant
  // run-on sentence (common for small models that forget to add
  // sentence breaks), fall back to the whole body so the user still
  // sees the judge's full paragraph.
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const picked = sentences.slice(0, 2).join(' ')
  return picked || body
}

/**
 * Derive a confidence score from the hedging language in the
 * paragraph. We use simple keyword matches — this is intentionally
 * not a precise calibration, just a reasonable approximation that
 * "the user reads a coherent number, not a coin flip".
 */
function confidenceFromHedges(body: string): number {
  const text = body.toLowerCase()

  // Strong language — model is sure
  if (/\b(clearly|obviously|without question|undoubtedly|compellingly|conclusively)\b/.test(text)) {
    return 0.85
  }
  // The defense / prosecution was correct, etc.
  if (/\b(correctly|rightly|right to|the defense wins|the prosecution wins)\b/.test(text)) {
    return 0.8
  }
  // Hedging
  if (/\b(perhaps|maybe|i think|i believe|arguably|possibly)\b/.test(text)) {
    return 0.6
  }
  // Borderline
  if (/\b(borderline|marginal|narrowly|just barely|a coin flip|close call)\b/.test(text)) {
    return 0.55
  }
  // Default
  return 0.7
}

/**
 * Strip markdown code fences, common preambles, and inline
 * emphasis around the ruling markers so the regexes match.
 */
function sanitizeNaturalOutput(raw: string): string {
  let s = raw
  // Strip opening code fence (``` or ```text) on its own line
  s = s.replace(/^[ \t]*```(?:[a-zA-Z0-9_-]*)?[ \t]*\r?\n/gm, '')
  // Strip closing code fence on its own line
  s = s.replace(/\r?\n[ \t]*```[ \t]*$/gm, '')
  // Strip common preambles on the first ~3 lines
  s = s.replace(
    /^(?:sure[,.!]?\s+here(?:\s+is)?\s+(?:the\s+)?(?:my\s+)?(?:final\s+)?ruling[:.]?\s*|here(?:'s|\s+is)\s+(?:the\s+)?(?:my\s+)?(?:final\s+)?ruling[:.]?\s*|ruling[:.]?\s*|final\s+ruling[:.]?\s*|my\s+ruling[:.]?\s*|verdict[:.]?\s*|the\s+ruling\s+is\s+as\s+follows[:.]?\s*|after\s+reviewing[,.]\s*)+/i,
    '',
  )
  // Strip markdown emphasis around the ruling markers. We have to
  // match both with and without a trailing colon because the
  // ruling line has no colon (just the phrase + period).
  s = s.replace(
    /^[ \t]*[*_]{1,3}(I rule in favor of the purchase|restraint)[*_]{1,3}[ \t]*[.!]?[ \t]*$/gim,
    '$1',
  )
  s = s.replace(
    /^[ \t]*[*_]{1,3}(I rule in favor of the purchase|restraint)[*_]{1,3}[ \t]*[.!]?[ \t]*/gim,
    '$1',
  )
  return s
}

/**
 * Build a `Verdict` from a `NaturalParseResult`. Returns a fallback if
 * the result is still partial or has missing required fields. The
 * `summary` fallback uses the reasoning body so the user still sees
 * something meaningful on the verdict card.
 */
export function verdictFromNatural(result: NaturalParseResult, fallbackReason = 'judge returned no ruling'): Verdict {
  if (
    result.decision &&
    result.confidence != null &&
    result.summary.length > 0 &&
    result.factors.length === 3
  ) {
    return {
      decision: result.decision,
      confidence: result.confidence,
      summary: result.summary,
      topFactors: [result.factors[0], result.factors[1], result.factors[2]],
    }
  }
  // Partial result with at least a decision — surface a summary
  // built from what we have so the user is never left with a
  // default ruling when the model did try.
  if (result.decision) {
    const fallbackSummary =
      result.summary ||
      result.reasoning ||
      `The court reached a decision with ${Math.round((result.confidence ?? 0.6) * 100)}% confidence.`
    const factors =
      result.factors.length === 3
        ? (result.factors as [string, string, string])
        : (fallbackFactors(result.decision) as [string, string, string])
    return {
      decision: result.decision,
      confidence: result.confidence ?? 0.6,
      summary: fallbackSummary,
      topFactors: factors,
    }
  }
  return fallbackVerdict(fallbackReason)
}

function fallbackFactors(decision: 'proceed' | 'abandon'): [string, string, string] {
  if (decision === 'proceed') {
    return ['User addressed concerns', 'Price justified by use', 'No cheaper alternative established']
  }
  return ['Concerns not addressed', 'Cost not justified', 'Safer to wait']
}

/**
 * Extract the DECISIVE FACTORS bullet list from the model output.
 * Accepts the explicit "DECISIVE FACTORS:" header + "- bullet" lines,
 * OR a standalone numbered list ("1. X\n2. Y\n3. Z") as a fallback.
 *
 * Each bullet is sanitized to a single short clause (max ~200 chars,
 * stripped of leading/trailing punctuation and markdown). The list is
 * truncated to 3 entries (the UI's hard requirement).
 *
 * Returns an empty array if no bullet list is found — the caller
 * then falls through to `deriveFactorsFromParagraph`.
 */
export function extractFactors(text: string): string[] {
  if (!text) return []

  // Pass 1: explicit "DECISIVE FACTORS:" header + bullets.
  const headerMatch = text.match(FACTORS_HEADER_RE)
  if (headerMatch) {
    const block = headerMatch[1]
    const bullets: string[] = []
    let m
    BULLET_RE.lastIndex = 0
    while ((m = BULLET_RE.exec(block)) !== null) {
      const cleaned = sanitizeBullet(m[1])
      if (cleaned) bullets.push(cleaned)
      if (bullets.length >= 3) break
    }
    if (bullets.length > 0) return bullets
  }

  // Pass 2: numbered list (1. X / 2. Y / 3. Z) anywhere in the text.
  const numbered: string[] = []
  const numberedRe = /^[ \t]*\d+[.)][ \t]+(.+)$/gm
  let nm
  while ((nm = numberedRe.exec(text)) !== null) {
    const cleaned = sanitizeBullet(nm[1])
    if (cleaned) numbered.push(cleaned)
    if (numbered.length >= 3) break
  }
  return numbered.slice(0, 3)
}

/**
 * Sanitize a single bullet/numbered factor string:
 *   - cap at 200 chars (UI requirement + safety against model
 *     injection of long markdown / scripts)
 *   - strip surrounding markdown emphasis
 *   - trim punctuation
 *   - collapse internal whitespace
 */
function sanitizeBullet(raw: string): string {
  let s = raw.replace(/^[\s*_~`]+|[\s*_~`]+$/g, '').replace(/`+/g, '').trim()
  s = s.replace(/^[\s"'`*_~>]+|[\s"'`*_~<]+$/g, '')
  s = s.replace(/\s+/g, ' ')
  // Strip bold/italic markers that flank a single word at the
  // start of the bullet (e.g. "**bold** factor" -> "bold
  // factor", "*italic* factor" -> "italic factor",
  // `"quoted" factor` -> "quoted factor"). The marker on the
  // closing side is in the middle of the string (right after the
  // word), not at the end, so we match it specifically.
  s = s.replace(/^[*_~`]+/, '').replace(/[*_~`]+(\s|$)/, '$1')
  s = s.replace(/^"([^"]+?)"\s+/, '$1 ').replace(/\s+"$/, '')
  s = s.replace(/^'([^']+?)'\s+/, "$1 ").replace(/\s+'$/, '')
  // Also strip any remaining internal closing markers from
  // patterns like "**bold** factor" where both markers are
  // adjacent to a single word.
  s = s.replace(/(\w)\*\*\s+(\w)/g, '$1 $2').replace(/(\w)\*\s+(\w)/g, '$1 $2')
  s = s.replace(/(\w)"\s+(\w)/g, '$1 $2').replace(/(\w)'\s+(\w)/g, '$1 $2')
  s = s.replace(/\*+/g, '').replace(/`/g, '')
  if (s.length > 200) s = s.slice(0, 197) + '...'
  return s
}

/**
 * Pad a partial factor list to 3 entries by deriving the missing
 * ones from the paragraph. Falls back to the hardcoded 3-string
 * list as a last resort.
 */
function padFactors(
  existing: string[],
  body: string,
  decision: 'proceed' | 'abandon',
): [string, string, string] {
  const derived = deriveFactorsFromParagraph(body, decision)
  const out: string[] = [...existing]
  for (const f of derived) {
    if (out.length >= 3) break
    if (!out.some((e) => e.toLowerCase() === f.toLowerCase())) out.push(f)
  }
  while (out.length < 3) {
    const fb = fallbackFactors(decision)
    const candidate = fb[out.length]
    if (!out.some((e) => e.toLowerCase() === candidate.toLowerCase())) out.push(candidate)
    else out.push(candidate) // accept the duplicate as last resort
  }
  return [out[0], out[1], out[2]]
}

/**
 * Derive 3 short factors from the paragraph itself when the model
 * didn't produce an explicit factor list. Strategy:
 *   - Split the paragraph into sentences
 *   - Prefer sentences that name a side (prosecution / defense /
 *     user) or contain "specific" / "need" / "want" / "concern" / "counter"
 *   - Truncate each to ~100 chars
 *   - If we don't have 3, pad with the existing hardcoded 3-string
 *     list as a last resort
 */
function deriveFactorsFromParagraph(
  body: string,
  decision: 'proceed' | 'abandon',
): [string, string, string] {
  if (!body) return fallbackFactors(decision)
  const sentences = body
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

  // Score each sentence: prefer ones that name a side or contain
  // a "decisive" keyword.
  const scored = sentences.map((s) => {
    const lower = s.toLowerCase()
    let score = 0
    if (/\b(prosecution|defense|user|judge|record)\b/.test(lower)) score += 3
    if (/\b(specific|need|want|concern|counter|address|overcome)\b/.test(lower)) score += 2
    if (/\b(argue|claim|stated|reason|point|objection)\b/.test(lower)) score += 1
    return { s, score }
  })
  scored.sort((a, b) => b.score - a.score)

  const picked: string[] = []
  for (const { s } of scored) {
    const trimmed = s.length > 120 ? s.slice(0, 117) + '...' : s
    if (!picked.some((p) => p.toLowerCase() === trimmed.toLowerCase())) picked.push(trimmed)
    if (picked.length >= 3) break
  }
  // Pad with hardcoded if we couldn't find 3 distinct sentences.
  while (picked.length < 3) {
    const fb = fallbackFactors(decision)
    const candidate = fb[picked.length]
    if (!picked.some((p) => p.toLowerCase() === candidate.toLowerCase())) picked.push(candidate)
    else picked.push(candidate)
  }
  return [picked[0], picked[1], picked[2]]
}

function empty(): NaturalParseResult {
  return { decision: null, confidence: null, reasoning: '', summary: '', factors: [], partial: true }
}

/**
 * Lenient body search for the decision when the model forgot the
 * "I rule in favor of X" phrasing. Looks for common synonyms as
 * whole-word substrings. Falls back to `normalizeDecision` (which
 * does an exact trimmed match against its known phrases).
 */
function lenientDecisionFromBody(body: string): 'proceed' | 'abandon' | null {
  const t = body.toLowerCase()
  if (/\bprosecution wins\b/.test(t)) return 'abandon'
  if (/\bdefense wins\b/.test(t)) return 'proceed'
  if (/\bprosecution loses\b/.test(t)) return 'proceed'
  if (/\bdefense loses\b/.test(t)) return 'abandon'
  if (/\brejected\b/.test(t) || /\bdenied\b/.test(t) || /\bno\b/.test(t)) return 'abandon'
  if (/\bapproved\b/.test(t) || /\bgranted\b/.test(t) || /\byes\b/.test(t)) return 'proceed'
  if (/\bin favor of restraint\b/.test(t)) return 'abandon'
  if (/\bin favor of (the )?(purchase|cart)\b/.test(t)) return 'proceed'
  return normalizeDecision(body)
}

// =====================================================================
// TRANSCRIPT-PATTERN OVERRIDE
// =====================================================================
//
// The user reported: "I said I needed it, and the verdict was
// restraint at 65% confidence." Despite the "DEFAULT POSITION:
// TRUST THE USER" block, the DEFAULT POSITION: TRUST THE USER +
// DECISION TABLE, the reframe of the top role from "check on
// impulse" to "reflection session", and the explicit "WHEN IN
// DOUBT, LEAN PROCEED" footer — the model still defaults to
// restraint when the user has shown a concrete need.
//
// This is a prompt-level fix on the model's residual
// restraint-bias. It is not a parser problem. To GUARANTEE
// that any concrete need the user articulates results in a
// PURCHASE verdict, we add a deterministic post-processor
// in code. The model is the input; the user's intent is
// the output.
//
// The override:
//   1. Scans the transcript for concrete-need patterns in the
//      user's messages (role === 'defense').
//   2. If a pattern matches AND the verdict is 'abandon',
//      forces the verdict to 'proceed' at 0.85+ confidence.
//   3. The override factors are explicit: "User: stated a
//      concrete, specific use case", "Override: real need
//      detected", "Record: 0.85+ in favor of purchase".
//
// Conservative: the override does NOT fire on bare "I want it",
// "I need new tech", "it's on sale", or other vague signals.
// Those are the ~50/50 case and the model's verdict stands.

/**
 * Pattern set for detecting a concrete, specific use case the
 * user has articulated anywhere in the trial. All case-insensitive.
 * Each pattern is matched against ANY user message (defense turn).
 *
 * Conservative — only clear, unambiguous needs. Vague wants
 * ("I want it", "I need new tech", "it's on sale") do NOT match.
 */
const CONCRETE_NEED_PATTERNS: RegExp[] = [
  // Possessive + broken/fell apart/stopped working/dead (the most
  // common phrasing). Allows up to 4 words between "my" and the
  // broken-state verb (e.g. "my current pair of headphones broke").
  /\bmy\s+\w+(\s+\w+){0,4}\s+(broke|broken|fell apart|stopped working|is dead|died|is ruined|cracked|shattered|won't (charge|turn on|work|hold a charge))\b/i,
  // Subject-verb-broken: "I broke my X", "I lost my X"
  /\bI\s+(broke|lost|destroyed|damaged)\s+my\b/i,
  // Time-bound event: "I have a meeting tomorrow", "I have a
  // deadline Friday", "I have a trip next week"
  /\bI\s+have\s+(a|an|my)\s+(meeting|presentation|trip|interview|exam|deadline|event|project|wedding|vacation|flight|conference|class|appointment)\b/i,
  // Work-related
  /\bI\s+work\s+(from|at|as)\b/i,
  // Physical activity with frequency: "I run 30 miles a week",
  // "I run 5k daily"
  /\bI\s+run\s+\d+\s*(miles?|km|kilometers?)\b/i,
  /\bI\s+run\s+\d+\s*(times?\s+)?a\s+(week|day|month)\b/i,
  // Recreation with frequency
  /\bI\s+(do|play)\s+\w+\s+\d+\s*(times?|hours|a\s+week|a\s+day|weekly|daily)\b/i,
  // Savings / planning: "I've been saving for 6 months"
  /\bI'?ve\s+been\s+saving\s+for\s+\d+\s+(months?|years?|weeks?)\b/i,
  // Replacement language: "this is a replacement for my X",
  // "I'm replacing my X"
  /\b(replacement|replacing)\s+(for|my)\b/i,
  // Specific need: "I need this for work", "I need this for a
  // project", "I need this for a trip"
  /\bI\s+need\s+this\s+for\s+(work|school|college|a\s+project|a\s+trip|a\s+meeting|a\s+presentation|a\s+class|my\s+job|an?\s+event|a\s+deadline|an?\s+interview|an?\s+exam|an?\s+appointment)\b/i,
  // For a dependent: "for my kid", "for my wife", "for my dog"
  /\bfor\s+(my\s+(kid|child|son|daughter|wife|husband|mom|dad|mother|father|dog|cat|pet|baby|grandma|grandpa|mum))\b/i,
  // Recurring use: "I use it every day", "I wear it daily"
  /\bI\s+(use|wear)\s+(it|this|these|them)\s+(every|each|per|daily|weekly)\b/i,
  // Budgeted / planned: "I budgeted for this", "I planned for this"
  /\b(budgeted|planned)\s+(for|to)\b/i,
]

/**
 * Returns true if any user message in the transcript contains a
 * concrete-need pattern. Conservative — only clear, unambiguous
 * needs. The ~50/50 case ("I want it" alone) and the vague case
 * ("I need new tech") do NOT match.
 */
export function hasConcreteNeed(transcript: ChatMessage[]): boolean {
  if (!transcript || transcript.length === 0) return false
  const userMessages = transcript.filter((m) => m.role === 'defense')
  if (userMessages.length === 0) return false
  for (const msg of userMessages) {
    if (!msg.text) continue
    for (const pattern of CONCRETE_NEED_PATTERNS) {
      if (pattern.test(msg.text)) return true
    }
  }
  return false
}

/**
 * Post-processor override: when the model returns a restraint
 * verdict but the user has stated a concrete need in the
 * transcript, force the verdict to PURCHASE at 0.85+.
 *
 * This is the user's explicit guarantee: "It should let you
 * purchase if it identifies any sense of actual need." The model
 * still has a residual restraint bias even with the
 * reframe-to-reflection-session fix; this override is the
 * code-level guarantee that the user's articulated need is
 * respected regardless of what the model does.
 *
 * The override factors are explicit so the user can SEE in the
 * UI that the override kicked in: "User: stated a concrete,
 * specific use case", "Override: real need detected", "Record:
 * 0.85+ in favor of purchase".
 */
export function applyTranscriptOverride(
  verdict: Verdict,
  transcript: ChatMessage[],
): Verdict {
  // Only override if the model said restraint (or fallback). If
  // the model already said purchase, trust it.
  if (verdict.decision !== 'abandon') return verdict
  if (!hasConcreteNeed(transcript)) return verdict

  // Override: real need detected, force PURCHASE at 0.85+.
  // The summary is preserved from the model's output (so the
  // user still sees the model's reasoning). The factors are
  // replaced to make the override VISIBLE in the UI.
  return {
    decision: 'proceed',
    confidence: 0.85,
    summary: verdict.summary,
    topFactors: [
      'User: stated a concrete, specific use case in the transcript',
      'Override: real need detected, defaulting to purchase',
      'Record: 0.85+ confidence in favor of purchase',
    ] as [string, string, string],
  }
}
