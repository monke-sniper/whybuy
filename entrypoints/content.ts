import { installClickInterceptor } from '@/lib/intercept/trigger'
import { classifyElement } from '@/lib/intercept/selectors'
import { extractProduct } from '@/lib/intercept/product'
import { extractCart } from '@/lib/intercept/cart'
import { selectProvider } from '@/lib/ai/provider'
import type { Cart, Product, ProviderStatus, Verdict, ByokConfig } from '@/lib/ai/types'
import { appendHistory } from '@/lib/storage/history'
import { setCooldown, getCooldown, getCooldownFingerprint } from '@/lib/storage/cooldowns'
import { loadSettings } from '@/lib/storage/settings'
import { isBypassedSync, loadBypass, setBypass } from '@/lib/storage/bypass'
import { log, warn } from '@/lib/utils/log'
import { mountTrial, type TrialController } from '@/components/trial/mount'
import { defineContentScript } from 'wxt/utils/define-content-script'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: false,

  async main(ctx: any) {
    try {
      log('WhyBuy content script loaded on', location.hostname)

      await waitForBody()

      // Load the per-site bypass set so the click interceptor can
      // ask "is this site bypassed right now?" synchronously.
      await loadBypass()

      // Set up the click interceptor. Trial fires only when the user
      // explicitly clicks a "Checkout" / "Proceed to checkout" button.
      // No URL auto-trigger.
      //
      // `consumeBypass` runs BEFORE target matching and BEFORE
      // preventDefault: it lets every checkout click through on a site
      // the user has overridden ("I disagree — proceed anyway"). Our own
      // re-dispatched click needs no special case because the
      // interceptor ignores untrusted (synthetic) clicks.
      const removeInterceptor = installClickInterceptor(
        (result) => {
          void openTrial({
            ...extractSubject(result.product),
            event: result.event,
            // The matched element itself: `event.target` is retargeted
            // (or cleared) once dispatch ends, so it can't be trusted later.
            target: result.match.element,
          })
        },
        {
          consumeBypass: () => isBypassedSync(location.hostname),
        },
      )

      ctx.onInvalidated(() => {
        removeInterceptor()
      })
    } catch (e) {
      console.error('[WhyBuy] main() crashed:', e)
    }
  },
})

async function waitForBody(): Promise<void> {
  if (document.body) return
  await new Promise<void>((resolve) => {
    const obs = new MutationObserver(() => {
      if (document.body) {
        obs.disconnect()
        resolve()
      }
    })
    obs.observe(document.documentElement, { childList: true })
    setTimeout(() => {
      obs.disconnect()
      resolve()
    }, 5000)
  })
}

let activeController: TrialController | null = null
/** True while openTrial is between "click intercepted" and "overlay mounted". */
let opening = false
/**
 * True from the moment reDispatch is scheduled until the synthetic click
 * has fired. A fast second click in that window is a duplicate of the
 * one being replayed and must not schedule another replay (that would
 * submit a checkout form twice).
 */
let redispatchPending = false
/** Bumped on every trial open; used to ignore stale callbacks. */
let trialEpoch = 0
/**
 * Fingerprints of products/carts whose trial the user already resolved
 * by going ahead (proceed or override) on this page. The trial is a
 * "gate" (one-time check), not a "wall" (permanent block), so a repeat
 * checkout click for the same subject passes straight through.
 */
const trialShownThisSession = new Set<string>()

async function openTrial(args: {
  product: Product
  cart: Cart | null
  event: MouseEvent
  target: Element
}): Promise<void> {
  const { product, cart, event, target } = args

  // The interceptor already cancelled this click. A second click while
  // a trial is mounted (or mounting) is just a duplicate: swallow it.
  if (activeController || opening || redispatchPending) {
    activeController?.focus()
    return
  }

  opening = true
  try {
    // Every path below either mounts the trial or re-fires the click,
    // so a cancelled checkout click is never silently lost.
    const settings = await loadSettings()
    if (settings.ignoredSites.includes(location.hostname)) {
      log('Ignoring intercepted site:', location.hostname)
      reDispatch(event, target, product)
      return
    }

    // Cooldown check: scoped to the *product group* (cart items or single
    // product), not the page. Different carts (hat vs groceries) have
    // independent cooldowns.
    const cooldownFp = getCooldownFingerprint(product, cart)
    if (trialShownThisSession.has(cooldownFp)) {
      log('Trial already resolved for this product/cart, letting through:', cooldownFp)
      reDispatch(event, target, product)
      return
    }
    const existing = await getCooldown(cooldownFp)
    const status = await resolveProviderStatus(settings.byok)

    const epoch = ++trialEpoch
    activeController = await mountTrial({
      product,
      cart,
      existingCooldown: existing,
      providerStatus: status,
      onProceed: () => {
        trialShownThisSession.add(cooldownFp)
        if (epoch !== trialEpoch) return
        reDispatch(event, target, product)
      },
      onAbandon: (_verdict) => {
        // Recording is handled by the `onTranscript` callback (which
        // carries the full transcript). This callback exists so the
        // trial app can also surface "user accepted the ruling" in
        // the activity log without double-recording.
      },
      onOverride: (_verdict) => {
        trialShownThisSession.add(cooldownFp)
        if (epoch !== trialEpoch) return
        // Recording is handled by the `onTranscript` callback. This
        // callback owns the side effects the `onTranscript` path
        // can't: closing the trial overlay and setting the per-site
        // bypass so the next "Continue to checkout" click passes
        // through to /checkout naturally (without re-triggering the
        // trial). The user is returned to the cart; they click the
        // real "Continue to checkout" button themselves, so we do NOT
        // re-dispatch the original click here.
        void setBypass(location.hostname).then(() => {
          log('Override: bypass set for', location.hostname)
        })
        const c = activeController
        activeController = null
        c?.close()
      },
      onClose: () => {
        if (epoch !== trialEpoch) return
        const c = activeController
        activeController = null
        c?.close()
      },
      onTranscript: (transcript, verdict, outcome) => {
        if (epoch !== trialEpoch) return
        // Returned so "accept the ruling" can wait for the writes before closing the tab.
        return recordOutcome(product, cart, verdict, outcome === 'overridden-proceeded', transcript)
      },
    })
  } catch (e) {
    // Extension context invalidated, storage failure, etc. Fail open:
    // never leave the user with a dead checkout button.
    warn('openTrial failed, letting the click through:', e)
    activeController = null
    reDispatch(event, target, product)
  } finally {
    opening = false
  }
}

/**
 * Provider status for the overlay. A BYOK provider is reported ready
 * without a network probe: the probe is a real completion request, and
 * the background worker runs it (cached) when the trial asks for the
 * provider status. Only the local Prompt API check runs here.
 */
async function resolveProviderStatus(byok: ByokConfig | null): Promise<ProviderStatus> {
  const provider = await selectProvider(byok)
  if (provider.kind === 'byok') return { kind: 'ready' }
  return provider.status()
}

/**
 * Determine the subject of the trial from the product the interceptor
 * already extracted. On cart pages, extract the cart (multiple items,
 * total) and attach it to the product.
 *
 * On a single-item cart we also override the product's `name` with the
 * cart item's name, because `extractProduct()` on a cart page falls
 * back to the page's h1 ("Shopping Cart", "Cart", etc.) which is not
 * a real product. The cart item is the real product; using its name
 * keeps the trial grounded in what the user is actually buying.
 */
function extractSubject(product: Product): { product: Product; cart: Cart | null } {
  const cart = extractCart()
  if (cart && cart.items.length > 0) {
    if (cart.items.length === 1 && cart.items[0].name) {
      product.name = cart.items[0].name
      if (cart.items[0].price != null) product.price = cart.items[0].price
      if (cart.items[0].currency) product.currency = cart.items[0].currency
      if (cart.items[0].details?.brand) product.brand = cart.items[0].details.brand
    }
    product.cart = cart
  }
  return { product, cart: product.cart ?? null }
}

/**
 * Re-fire the user's original "Proceed to checkout" click so the page
 * actually navigates. Used when the verdict is "proceed" and whenever
 * the trial is skipped (ignored site, already resolved, or a failure).
 *
 * The click is dispatched exactly once, on the original target, with
 * the original modifier keys (so ctrl/cmd-click still opens a new tab).
 * That runs the element's own handlers and its default action (link
 * navigation, form submit). We deliberately do NOT also call
 * `form.submit()` or assign `location.href`: the click already does
 * those, and repeating them submits a checkout form twice.
 *
 * The synthetic click is untrusted, which the interceptor ignores, so
 * it reaches the page without any suppress counter or flag that a real
 * user click could slip through.
 *
 * If the page re-rendered while the trial was open and the original
 * element is gone, we look for the current checkout button instead.
 */
function reDispatch(event: MouseEvent, original: Element, product: Product): void {
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    button: 0,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  }

  redispatchPending = true
  setTimeout(() => {
    try {
      const target = original.isConnected ? original : findCheckoutTarget()
      if (!target) {
        warn('Re-dispatch: checkout target is gone and no replacement was found for', product.name)
        return
      }
      log('Re-dispatching click for', product.name)
      target.dispatchEvent(new MouseEvent('click', init))
    } catch (e) {
      warn('Re-dispatch failed:', e)
    } finally {
      redispatchPending = false
    }
  }, 60)
}

/** Find the page's current checkout button (used when the original was removed). */
function findCheckoutTarget(): Element | null {
  const candidates = document.querySelectorAll('button, a, input[type="submit"], input[type="button"], [role="button"], [role="link"]')
  for (const el of candidates) {
    if (classifyElement(el)) return el
  }
  return null
}

async function recordOutcome(
  product: Product,
  cart: Cart | null,
  verdict: Verdict,
  overridden: boolean,
  transcript: any[],
): Promise<void> {
  try {
    // Cooldown only fires when the user *accepted* an abandon ruling.
    // An override is the user going through anyway — no cooldown
    // (otherwise the next page load would also block them).
    if (verdict.decision === 'abandon' && !overridden) {
      await setCooldown(product, cart, verdict.confidence)
    }
    await appendHistory({
      id: newRecordId(),
      ts: Date.now(),
      product,
      cart,
      transcript: transcript as any,
      verdict,
      outcome: overridden
        ? 'overridden-proceeded'
        : verdict.decision === 'abandon'
        ? 'accepted-abandon'
        : 'proceeded-after-proceed',
    })
  } catch (e) {
    warn('Failed to record trial outcome:', e)
  }
}

window.addEventListener('error', (e) => warn('window error:', e.message))
window.addEventListener('unhandledrejection', (e) => warn('unhandled rejection:', e.reason))

/**
 * Build a unique ID for a trial record. `crypto.randomUUID()` is the
 * preferred path but it is NOT always available in content-script
 * contexts — only on secure origins (https / localhost / file://) and
 * in browsers that expose the Web Crypto API in the isolated world.
 * WhyBuy runs on every http(s) page including non-secure origins, so
 * we fall back to a `Math.random()`-based ID. The collision odds for
 * the last 200 trial records are negligible (52 bits of entropy per
 * record).
 */
function newRecordId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    // crypto is a forbidden host object in some sandboxes — treat
    // it as "not available" and fall through.
  }
  return `rec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}
