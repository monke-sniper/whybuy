import { classifyElement, type ButtonMatch } from './selectors.ts'
import { extractProduct } from './product.ts'
import type { Product } from '../ai/types.ts'
import { log } from '../utils/log.ts'

export interface InterceptResult {
  product: Product
  match: ButtonMatch
  /** The original event so we can re-dispatch on a "proceed" verdict. */
  event: MouseEvent
}

export interface InterceptorOptions {
  /**
   * Synchronous check: if the current site is in the user's bypass
   * set (set when the user clicked "I disagree — proceed anyway"),
   * return true and let the click through without preventDefault.
   * The check runs BEFORE target matching and BEFORE preventDefault,
   * so the user can navigate to /checkout by clicking the real
   * "Continue to checkout" button on the cart. Sticky for the rest of
   * the browser session on the bypassed site.
   */
  consumeBypass?: () => boolean
}

/** Attribute on the trial overlay's shadow host (see components/trial/mount.tsx). */
const TRIAL_HOST_ATTR = 'data-whybuy'

/**
 * Install a capture-phase click listener on the document.
 *
 * Fires only when the click target (or one of its ancestors) is a
 * literal "Checkout" / "Proceed to checkout" button. Nothing else
 * triggers a trial.
 */
export function installClickInterceptor(
  onIntercept: (result: InterceptResult) => void,
  options: InterceptorOptions = {},
): () => void {
  const handler = (e: Event) => {
    if (e.defaultPrevented) return
    if (!(e instanceof MouseEvent)) return
    if (e.button !== 0 && e.button !== undefined) return // primary only

    // Only real user clicks start a trial. A page script (or an ad
    // iframe) can fire synthetic clicks at will; honouring them would
    // let any page open the overlay and spend the user's AI quota.
    // This is also what lets our own re-dispatched click (untrusted by
    // construction) reach the page without any bookkeeping.
    if (!e.isTrusted) return

    // EARLY-OUT for the per-site bypass. When the user clicks
    // "I disagree — proceed anyway", we add the current site to
    // the session-scoped bypass set. From then on, every checkout
    // click on this site (this browser session) is allowed to
    // pass through naturally to /checkout. The check is also
    // BEFORE target matching and BEFORE preventDefault.
    if (options.consumeBypass?.()) {
      log('Bypass active — letting checkout click through')
      return
    }

    const path = e.composedPath()
    // Clicks inside the trial overlay belong to the trial UI (it has
    // its own "Continue to checkout"-style buttons); never intercept them.
    if (path.some((n) => n instanceof Element && n.getAttribute(TRIAL_HOST_ATTR) === '1')) {
      return
    }
    for (const node of path) {
      if (!(node instanceof Element)) continue
      const match = classifyElement(node)
      if (!match) continue

      e.preventDefault()
      e.stopImmediatePropagation()
      e.stopPropagation()
      const product = extractProduct()
      onIntercept({ product, match, event: e })
      log('Intercepted checkout click:', match.label)
      return
    }
  }
  document.addEventListener('click', handler, { capture: true })
  return () => document.removeEventListener('click', handler, { capture: true })
}
