/**
 * Buffers streaming AI text and emits complete sentences for TTS.
 *
 * The AI provider streams text in arbitrary chunks — sometimes
 * mid-sentence. We don't want to call ElevenLabs for every chunk
 * (too many requests, choppy audio) or for the whole turn at once
 * (huge latency). Instead we accumulate text and emit a sentence
 * whenever we see a clean terminator (`.`, `!`, `?`) followed by
 * whitespace, end-of-stream, or a closing quote/paren.
 *
 * IMPORTANT: the AI provider's `onChunk(acc)` callback gives the
 * FULL accumulated text on every delta (not just the new tail).
 * Without correction, pushing "I", "I want", "I want it." would
 * leave the buffer as "II wantI want it." — the whole text
 * re-pasted on every chunk. To handle that, this buffer remembers
 * the last chunk it saw and, if the new chunk is a strict
 * superstring of the old one, only the new tail is appended.
 * This works correctly for both true deltas and full-text re-emits.
 *
 * Abbreviation handling: a period that's part of an abbreviation
 * (e.g. "U.S.A.", "U.K.", "e.g.") is followed by another capital
 * letter and another period within a few chars. We look at the 4
 * chars immediately before each candidate period: if there's
 * another period in there, we're inside an abbreviation and skip.
 * This catches "U.S.A." and "U.S." but not "Mr." (a known false
 * positive — the model rarely produces "Mr." mid-sentence anyway).
 *
 * Mid-word splits: `push()` may receive a chunk that ends with
 * "Loui" and the next chunk starts with "s". The algorithm doesn't
 * hold back any tail — the next push will append and the sentence
 * boundary detector will work on the full string. Worst case is
 * a tiny delay between streaming and TTS, not garbled audio.
 *
 * Run-on sentences with no terminator: we flush after
 * `maxBufferChars` (default 200) so the user doesn't wait forever.
 * A real turn's first sentence is usually 80-150 chars; 200 is a
 * safe upper bound for TTS latency.
 */
export class SentenceBuffer {
  private buf = ''
  /** Max chars to hold before forcing a flush. */
  private readonly maxBuffer: number
  /**
   * The last chunk we received in full. Used to detect "full-text
   * re-emit" events where the new chunk contains the old one as
   * a prefix (e.g. `onChunk(acc)` from the AI provider). When we
   * see that pattern, we extract only the new tail and append it,
   * so the buffer doesn't double up.
   */
  private lastChunk = ''

  constructor(opts: { maxBufferChars?: number } = {}) {
    // 120 chars = roughly one full sentence from the prosecution.
    // Lowered from 200 so the first TTS request goes out sooner —
    // the user said the TTS was wasting time.
    this.maxBuffer = opts.maxBufferChars ?? 120
  }

  /**
   * Push a text chunk (may be empty). Returns a complete sentence
   * if one terminated in this push, else null.
   *
   * Accepts BOTH true deltas (" want" following "I") and full-text
   * re-emits ("I want" following "I"). The buffer detects which
   * kind of input it got and only appends the new content.
   */
  push(chunk: string): string | null {
    if (!chunk) return null

    let delta: string
    if (this.lastChunk && chunk === this.lastChunk) {
      // Identical chunk re-sent (e.g. duplicate event from a retry).
      // Nothing new to process.
      return null
    } else if (
      this.lastChunk &&
      chunk.length > this.lastChunk.length &&
      chunk.startsWith(this.lastChunk)
    ) {
      // Full-text re-emit: the new chunk contains the old one as a
      // prefix. Only the new tail is genuinely new content.
      delta = chunk.slice(this.lastChunk.length)
    } else {
      // True delta input (or first call / reset between turns).
      delta = chunk
    }
    this.lastChunk = chunk
    if (!delta) return null
    this.buf += delta
    return this.tryExtract()
  }

  /**
   * Flush any remaining buffered text as a single sentence. Called
   * on stream end so the AI's final words get spoken.
   */
  flush(): string {
    const rest = this.buf.trim()
    this.buf = ''
    this.lastChunk = ''
    return rest
  }

  /** Current buffer length (useful for tests). */
  get length(): number {
    return this.buf.length
  }

  private tryExtract(): string | null {
    // Walk forward to find the FIRST terminator that's safe to cut at.
    // A cut is safe if:
    //   - the char is `.`, `!`, or `?`
    //   - it's followed by end-of-buffer, whitespace, or quote/paren
    //   - it's NOT part of an abbreviation (another period in the
    //     immediately preceding 4 chars)
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i]
      if (c !== '.' && c !== '!' && c !== '?') continue
      const next = this.buf[i + 1] ?? ''
      if (next && !/[\s"'”’)\]]/.test(next)) {
        // Next char is a letter or punctuation that suggests the
        // period is mid-word / mid-abbreviation. Skip.
        continue
      }
      // Abbreviation check: another period in the last 4 chars means
      // we're inside an abbreviation like "U.S.A." or "i.e.".
      if (c === '.') {
        const lookback = this.buf.slice(Math.max(0, i - 4), i)
        const otherDots = (lookback.match(/\./g) || []).length
        if (otherDots >= 1) continue
      }
      // Found the first safe cut point.
      const sentence = this.buf.slice(0, i + 1).trim()
      this.buf = this.buf.slice(i + 1)
      if (sentence) return sentence
    }
    // No terminator found. If buffer is too long, force-flush at the
    // last whitespace before maxBuffer so TTS doesn't wait forever.
    if (this.buf.length > this.maxBuffer) {
      let cutAt = -1
      for (let i = Math.min(this.buf.length, this.maxBuffer + 20); i > 0; i--) {
        if (/\s/.test(this.buf[i - 1])) {
          cutAt = i
          break
        }
      }
      if (cutAt < 0) cutAt = Math.min(this.buf.length, this.maxBuffer + 20)
      const sentence = this.buf.slice(0, cutAt).trim()
      this.buf = this.buf.slice(cutAt)
      if (sentence) return sentence
    }
    return null
  }
}
