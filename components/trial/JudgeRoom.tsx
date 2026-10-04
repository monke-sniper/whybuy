import { useEffect, useState } from 'react'
import type { Cart, Product, Verdict } from '@/lib/ai/types'
import { CartSummary } from './CartSummary'
import { ProductCardStack } from './ProductCard'

/**
 * How long the "Accept the ruling" countdown waits before actually
 * closing the tab. Three seconds gives the user enough time to read
 * the warning and click "Cancel" if they clicked by accident, but
 * is short enough that the close feels immediate once they commit.
 */
const CLOSE_COUNTDOWN_SECONDS = 3

/**
 * Full-screen verdict reveal. Three internal phases:
 *   1. `deliberating` — "Court is in session" + judge mark + product stack.
 *   2. `strike`     — 900 ms gavel-strike animation.
 *   3. `revealed`   — verdict card with staggered fade-in + action buttons.
 *
 * The deliberation phase is shown while `verdict == null` (we sent the
 * JUDGE request, waiting for the JSON). Once the verdict arrives, the
 * gavel strikes and the verdict reveals.
 *
 * On a restraint verdict, the "Accept the ruling" button starts a
 * 3-second countdown that closes the tab when it reaches zero. The
 * countdown has a "Cancel" button that returns the user to the
 * verdict card without closing anything. "I disagree — proceed
 * anyway" sets a per-site bypass flag and returns the user to the
 * cart so they can navigate to /checkout themselves without
 * re-triggering the trial.
 */
export function JudgeRoom({
  product,
  cart,
  verdict,
  onProceed,
  onAcceptLoss,
  onOverride,
  onCloseTab,
}: {
  product: Product
  cart: Cart | null
  verdict: Verdict | null
  onProceed: () => void
  onAcceptLoss: () => void
  onOverride: () => void
  onCloseTab: () => void
}) {
  // phase: 'deliberating' | 'allRise' | 'strike' | 'revealed'
  //
  // Animation timeline once the verdict arrives:
  //   0.0s — verdict arrives. The bench is hidden and the room darkens.
  //   0.0s — "ALL RISE" banner slides down from the top.
  //   0.4s — judge SVG + scales rise into frame from below.
  //   1.0s — banner fades, scales centered, lights back on.
  //   1.2s — gavel arm rotates down, flash fires ("Order in the Court").
  //   2.4s — gavel returns, "The Court Rules" header materializes.
  //   2.4s+ — verdict lines reveal with stagger.
  const [phase, setPhase] = useState<'deliberating' | 'allRise' | 'strike' | 'revealed'>(
    verdict ? 'allRise' : 'deliberating',
  )

  /**
   * When non-null, the "Accept the ruling" countdown is running.
   * When `remaining` hits 0 we call `onCloseTab` (which the trial
   * app uses to record the outcome and ask the background to close
   * the tab). The user can abort by clicking "Cancel", which sets
   * this back to null and returns them to the normal verdict card.
   */
  const [closeCountdown, setCloseCountdown] = useState<{ remaining: number } | null>(null)

  useEffect(() => {
    if (!verdict) {
      setPhase('deliberating')
      return
    }
    setPhase('allRise')
    const t1 = setTimeout(() => {
      setPhase('strike')
      // Synthesized gavel thump. Skipped for prefers-reduced-motion.
      try {
        if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
          playGavelThump()
        }
      } catch {}
    }, 1200)
    const t2 = setTimeout(() => setPhase('revealed'), 2400)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [verdict])

  /**
   * Drive the "Accept the ruling" countdown. When remaining hits 0,
   * fire `onCloseTab`. The interval is set up via setTimeout (not
   * setInterval) so a re-render that bumps `remaining` doesn't pile
   * up overlapping timers.
   */
  useEffect(() => {
    if (!closeCountdown) return
    if (closeCountdown.remaining <= 0) {
      // Fire-and-forget. The trial app records the outcome and asks
      // the background to close the tab.
      try {
        onCloseTab()
      } catch (e) {
        // If the close fails for any reason, drop out of the
        // countdown so the user can still see the verdict.
        setCloseCountdown(null)
      }
      return
    }
    const t = setTimeout(() => {
      setCloseCountdown({ remaining: closeCountdown.remaining - 1 })
    }, 1000)
    return () => clearTimeout(t)
    // We intentionally do not depend on `onCloseTab` to avoid
    // re-creating the timer on every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closeCountdown])

  const isProceed = verdict?.decision === 'proceed'
  const confidencePct = verdict ? Math.round(verdict.confidence * 100) : 0
  const isCart = !!(cart && cart.items.length > 0)
  const showConfetti = phase === 'revealed' && isProceed

  return (
    <div className={`whybuy-judge-room ${phase === 'allRise' ? 'all-rise' : ''} ${phase === 'strike' ? 'strike' : ''} ${phase === 'revealed' ? 'revealed' : ''}`}>
      <div className="whybuy-gavel-flash" />

      {/* ALL RISE banner — slides in from the top during the allRise phase
          and fades out when the gavel strikes. */}
      <div
        className={`whybuy-all-rise-banner ${phase === 'revealed' ? 'is-revealed' : ''}`}
        aria-hidden={phase === 'revealed'}
      >
        <span className="whybuy-all-rise-text">All Rise</span>
        <span className="whybuy-all-rise-sub">The Court of Restraint is rendering judgment</span>
      </div>

      {/* Bench vignette — only visible during deliberation (faded out during
          the rise/strike so the room "darkens" before the gavel drops). */}
      <div className="whybuy-bench-vignette" />

      {phase !== 'revealed' && (
        <div className="whybuy-judge-spot">
          <JudgeMark />
          <div className="whybuy-judge-nameplate">The Court of Restraint</div>
          <div className="whybuy-judge-title">
            {phase === 'deliberating' ? 'The Court Is In Session' : phase === 'allRise' ? 'All Rise' : 'Order in the Court'}
          </div>
          <div className="whybuy-judge-sub">
            {phase === 'deliberating'
              ? 'The judge is reviewing the record. Stand by.'
              : phase === 'allRise'
              ? 'The court is about to render its decision.'
              : 'The judge has reached a decision.'}
          </div>
          {phase === 'deliberating' && <div className="whybuy-judge-typing">· · ·</div>}

          {phase === 'deliberating' && cart && cart.items.length > 0 && (
            <div style={{ width: 'min(720px, 96vw)', maxHeight: 220, overflowY: 'auto', margin: '12px auto 0' }}>
              <ProductCardStack cart={cart} />
            </div>
          )}
        </div>
      )}

      {phase === 'revealed' && verdict && (
        <div className="whybuy-judge-reveal">
          {showConfetti && (
            <div className="whybuy-confetti" aria-hidden="true">
              <i /><i /><i /><i /><i /><i /><i /><i /><i /><i />
            </div>
          )}
          <div className="whybuy-reveal-line">
            <div style={{ fontSize: 12, letterSpacing: '0.3em', textTransform: 'uppercase', color: '#c9a14a' }}>
              The Court Rules
            </div>
          </div>
          <div className="whybuy-reveal-line">
            <h1
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 44,
                fontWeight: 700,
                color: isProceed ? '#e6c578' : '#b3384a',
                margin: '0 0 6px',
                lineHeight: 1.1,
              }}
            >
              {isProceed
                ? isCart
                  ? 'In favor of the cart.'
                  : 'In favor of the purchase.'
                : 'In favor of restraint.'}
            </h1>
          </div>
          <div className="whybuy-reveal-line">
            <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 16, color: '#f7eed7', fontStyle: 'italic' }}>
              {isCart ? `Re: ${cart!.itemCount} items in cart` : `Re: ${product.name}`}
            </div>
          </div>
          {isCart && (
            <div className="whybuy-reveal-line" style={{ width: '100%' }}>
              <CartSummary cart={cart!} compact />
            </div>
          )}
          <div className="whybuy-reveal-line">
            <div className="whybuy-gauge" aria-label={`Confidence ${confidencePct}%`} style={{ margin: '6px auto 4px' }}>
              <div className="whybuy-gauge-fill" style={{ width: `${confidencePct}%` }} />
            </div>
            <div style={{ fontSize: 11, color: '#e6c578', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
              Confidence · {confidencePct}%
            </div>
          </div>
          <div className="whybuy-reveal-line">
            <p
              style={{
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 19,
                color: '#f7eed7',
                lineHeight: 1.55,
                margin: '0 0 4px',
              }}
            >
              {verdict.summary}
            </p>
          </div>
          <div className="whybuy-reveal-line" style={{ width: '100%' }}>
            <div className="whybuy-divider" style={{ margin: '8px 0 12px' }} />
            <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 8, textAlign: 'left' }}>
              Decisive Factors
            </div>
            <ul
              style={{
                listStyle: 'none',
                padding: 0,
                margin: 0,
                fontFamily: "'Cormorant Garamond', serif",
                fontSize: 16,
                color: '#f7eed7',
                textAlign: 'left',
              }}
            >
              {verdict.topFactors.map((f, i) => (
                <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 6 }}>
                  <span style={{ color: '#c9a14a', minWidth: 18 }}>{i + 1}.</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="whybuy-reveal-line whybuy-judge-actions">
            {isProceed ? (
              <button className="whybuy-btn" onClick={onProceed}>
                {isCart ? 'Continue to checkout' : 'Continue to purchase'}
              </button>
            ) : closeCountdown ? (
              <div
                role="alert"
                aria-live="polite"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <div
                  style={{
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: 22,
                    color: '#f7eed7',
                  }}
                >
                  Closing in <span style={{ color: '#e6c578', fontWeight: 700 }}>{closeCountdown.remaining}</span>…
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: '#c9a14a',
                    letterSpacing: '0.1em',
                  }}
                >
                  Tab will close and a cooldown will be set on this product.
                </div>
                {/* At 0 the ruling is already being recorded and the tab is closing: too late to cancel. */}
                {closeCountdown.remaining > 0 && (
                  <button
                    className="whybuy-btn-ghost whybuy-btn"
                    onClick={() => setCloseCountdown(null)}
                    style={{ background: 'transparent', color: '#e6c578' }}
                  >
                    Cancel — keep me on the verdict
                  </button>
                )}
              </div>
            ) : (
              <>
                <button
                  className="whybuy-btn"
                  onClick={() => setCloseCountdown({ remaining: CLOSE_COUNTDOWN_SECONDS })}
                >
                  Accept the ruling
                </button>
                <button
                  className="whybuy-btn-ghost whybuy-btn"
                  onClick={onOverride}
                  style={{ background: 'transparent', color: '#e6c578' }}
                >
                  I disagree — proceed anyway
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function JudgeMark() {
  return (
    <svg
      className="whybuy-judge-svg"
      viewBox="0 0 192 192"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="judge-glow" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor="#3a1f12" stopOpacity="0.8" />
          <stop offset="100%" stopColor="#120905" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="judge-robe" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2a160d" />
          <stop offset="100%" stopColor="#120905" />
        </linearGradient>
        <linearGradient id="gavel-wood" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#d6b463" />
          <stop offset="100%" stopColor="#8a6a2c" />
        </linearGradient>
      </defs>

      {/* Halo */}
      <circle cx="96" cy="96" r="92" fill="url(#judge-glow)" />
      <circle cx="96" cy="96" r="84" fill="none" stroke="#c9a14a" strokeWidth="1.5" opacity="0.7" />

      {/* Bench line */}
      <line x1="20" y1="170" x2="172" y2="170" stroke="#c9a14a" strokeWidth="2" strokeLinecap="round" />

      {/* Robe / shoulders */}
      <path
        d="M40 170 C40 130, 60 100, 96 100 C132 100, 152 130, 152 170 Z"
        fill="url(#judge-robe)"
        stroke="#c9a14a"
        strokeWidth="1.2"
      />
      {/* Collar/lapel */}
      <path d="M76 110 L96 124 L116 110" fill="none" stroke="#c9a14a" strokeWidth="1.2" />

      {/* Head */}
      <circle cx="96" cy="74" r="22" fill="#d6a849" stroke="#c9a14a" strokeWidth="1" />
      {/* Wig curls */}
      <path
        d="M74 70 Q72 56, 84 54 Q92 50, 100 54 Q112 50, 120 56 Q118 70, 116 70 L74 70 Z"
        fill="#f7eed7"
        stroke="#c9a14a"
        strokeWidth="0.8"
      />
      {/* Eyes (closed for solemnity) */}
      <path d="M86 76 Q89 79, 92 76" stroke="#1a0e08" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      <path d="M100 76 Q103 79, 106 76" stroke="#1a0e08" strokeWidth="1.4" fill="none" strokeLinecap="round" />
      {/* Mouth */}
      <path d="M90 86 Q96 88, 102 86" stroke="#1a0e08" strokeWidth="1.2" fill="none" strokeLinecap="round" />

      {/* Gavel (rotates on .strike) */}
      <g className="whybuy-gavel-arm">
        {/* Handle */}
        <line x1="96" y1="132" x2="138" y2="106" stroke="#8a6a2c" strokeWidth="3" strokeLinecap="round" />
        {/* Head */}
        <rect
          x="126"
          y="92"
          width="34"
          height="16"
          rx="3"
          fill="url(#gavel-wood)"
          stroke="#5a3f15"
          strokeWidth="1"
        />
        <line x1="130" y1="100" x2="156" y2="100" stroke="#5a3f15" strokeWidth="0.8" />
      </g>

      {/* Sound block */}
      <rect x="74" y="160" width="44" height="6" rx="2" fill="#c9a14a" />
    </svg>
  )
}

/**
 * Synthesized gavel-strike thump using the Web Audio API. No external
 * asset needed; the sound is a 60Hz low-pass-filtered noise burst with
 * a quick exponential decay, followed by a low sine "knock".
 *
 * Quiet by default (peak ~0.4 amplitude). Skipped if no AudioContext
 * is available or if the user has prefers-reduced-motion enabled.
 */
let audioCtx: AudioContext | null = null
function playGavelThump(): void {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext
    if (!Ctx) return
    const ctx: AudioContext = audioCtx ?? (new Ctx() as AudioContext)
    audioCtx = ctx
    if (ctx.state === 'suspended') void ctx.resume()

    const now = ctx.currentTime

    // Component 1: short low-pass noise burst (the impact transient).
    const noiseLen = 0.12
    const noiseBuf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * noiseLen), ctx.sampleRate)
    const data = noiseBuf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      // Brown-ish noise for a more "wood" thump.
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length)
    }
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuf
    const noiseGain = ctx.createGain()
    noiseGain.gain.setValueAtTime(0.45, now)
    noiseGain.gain.exponentialRampToValueAtTime(0.001, now + noiseLen)
    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'lowpass'
    noiseFilter.frequency.setValueAtTime(420, now)
    noiseFilter.frequency.exponentialRampToValueAtTime(140, now + noiseLen)
    noise.connect(noiseFilter).connect(noiseGain).connect(ctx.destination)
    noise.start(now)
    noise.stop(now + noiseLen)

    // Component 2: low sine "knock" (the resonance of the block).
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(120, now)
    osc.frequency.exponentialRampToValueAtTime(70, now + 0.16)
    const oscGain = ctx.createGain()
    oscGain.gain.setValueAtTime(0.0001, now)
    oscGain.gain.linearRampToValueAtTime(0.32, now + 0.005)
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18)
    osc.connect(oscGain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.2)
  } catch {
    // Audio is a nice-to-have. Never let a sound failure crash the UI.
  }
}
