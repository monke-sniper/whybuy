import type { Cart, CartItem, ProductDetails } from '../ai/types'
import { warn } from '../utils/log.ts'

/**
 * Best-effort cart extraction. Returns null if no cart is detected.
 *
 * Detects:
 *   - Amazon shopping cart (`/cart`, `/gp/cart`, `/checkout/cart`)
 *   - Shopify carts (`.cart__item`, `[data-cart-item]`)
 *   - eBay cart
 *   - Generic e-commerce carts (heuristic)
 */
export function extractCart(): Cart | null {
  const url = location.href
  const domain = location.hostname

  if (!looksLikeCartPage(url)) return null

  let cart: Cart | null = null
  if (/amazon\./i.test(domain)) cart = extractAmazonCart()
  else if (/ebay\./i.test(domain)) cart = extractEbayCart()
  else cart = extractShopifyCart() ?? extractGenericCart()

  return cart
}

function looksLikeCartPage(url: string): boolean {
  try {
    const u = new URL(url)
    const path = u.pathname.toLowerCase()
    return (
      /\/cart(\/|$|\?)/.test(path) ||
      /\/basket/.test(path) ||
      /\/checkout\/cart/.test(path) ||
      /\/shopping[-_ ]?cart/.test(path) ||
      /\/gp\/cart/.test(path)
    )
  } catch {
    return false
  }
}

// === Visibility filter ===
//
// Amazon's "undo" pattern keeps a removed item in the DOM for a few
// seconds (with `display: none` and/or a `.sc-list-item-removed` class)
// so the user can still un-delete it. We must not count those rows,
// otherwise clicking "Proceed to checkout" right after removing an
// item shows the trial a stale cart.

/** Class names that mark a cart row as removed/being-removed. */
const REMOVED_ROW_CLASSES = [
  'sc-list-item-removed',
  'sc-list-item-undo',
  'is-removed',
  'removed',
]

/**
 * Returns true if the row is currently visible in the active cart. We
 * reject rows that are:
 *   - flagged with a removed class (`.sc-list-item-removed`, etc.)
 *   - flagged with `data-cart-item-state="DELETED"` (or similar)
 *   - flagged with `data-removed="true"`
 *   - hidden via `display: none` or `visibility: hidden`
 *   - detached from the layout (offsetParent null — but be lenient
 *     for SVG / fixed-position ancestors)
 */
export function isRowVisible(el: HTMLElement | null | undefined): boolean {
  if (!el) return false
  if (!el.isConnected) return false
  for (const cls of REMOVED_ROW_CLASSES) {
    if (el.classList.contains(cls)) return false
  }
  const state = el.getAttribute('data-cart-item-state')
  if (state && /^(DELETED|REMOVED|HIDDEN)$/i.test(state)) return false
  if (el.getAttribute('data-removed') === 'true') return false
  // Inline `display:none` style. Other display values (flex, block,
  // grid) are valid; we only reject the obvious "hidden" ones.
  const inlineDisplay = el.style?.display
  if (inlineDisplay === 'none') return false
  const ownerDoc = el.ownerDocument
  const win = ownerDoc?.defaultView
  if (win) {
    try {
      const cs = win.getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
    } catch {
      // Cross-frame or detached; treat as visible (lenient).
    }
  }
  return true
}

// === Amazon ===

/**
 * Hard cap: Amazon's cart page can show a *lot* of recommendation rows
 * ("frequently bought together", "customers also bought", etc.). If our
 * scoped selector returns more than this many items, something has gone
 * wrong — refuse to guess and return null so the trial falls back to the
 * product, rather than feeding the AI a hallucinated 30-item cart.
 */
const AMAZON_CART_HARD_CAP = 25

export function extractAmazonCart(): Cart | null {
  const items: CartItem[] = []
  let currency: string | null = null

  // Scoped queries, in priority order. Each one targets the *active* cart
  // only — not the recommendation rails, search results, or sponsored
  // carousels that Amazon sprinkles across the page.
  const itemEls = selectAmazonActiveCartItems().filter(isRowVisible)

  for (const el of itemEls) {
    const asin = el.getAttribute('data-asin')
    if (asin && asin.length < 5) continue // skip non-product rows

    // The cart title link is the most stable place. On the redesigned
    // cart, it's the `<a>` inside `.sc-product-title` (or just an
    // `<a.a-link-normal>` with a `/dp/ASIN` href). We try in priority
    // order so we always get the cleanest possible string.
    const name =
      pickAmazonCartItemName(el) ||
      ''
    // The price div may contain BOTH a strikethrough was-price AND the
    // current price, both as `.a-offscreen`. Pick the LAST one (the
    // current price sits after the strikethrough) so we don't end up
    // charging the user the old price.
    const priceOffscreens = el.querySelectorAll('.a-price .a-offscreen')
    const priceText =
      (priceOffscreens.length > 0
        ? priceOffscreens[priceOffscreens.length - 1].textContent?.trim()
        : null) ||
      el.querySelector('.sc-price, .a-color-price')?.textContent?.trim() ||
      ''
    const { price, currency: cur } = parsePriceString(priceText)
    if (cur && !currency) currency = cur
    const qty = parseQuantity((el.querySelector('select[name="quantity"]') as HTMLSelectElement | null)?.value) || 1
    if (qty <= 0) continue
    const img = (el.querySelector('img') as HTMLImageElement | null)?.src || null
    const link = (el.querySelector('a.a-link-normal') as HTMLAnchorElement | null)?.href || null
    if (!name && price == null) continue

    // === Rich product details ===
    const details = extractAmazonItemDetails(el, asin, price)

    items.push({
      name: name || 'Item',
      price,
      currency: cur,
      imageUrl: img,
      quantity: qty,
      url: link,
      details,
    })
  }

  // Deduplicate by ASIN (or by name+price if ASIN is missing).
  const deduped = dedupeItems(items)
  if (deduped.length > AMAZON_CART_HARD_CAP) {
    warn(`Amazon cart extractor hit cap (${deduped.length} > ${AMAZON_CART_HARD_CAP}); returning null to avoid feeding hallucinated items.`)
    return null
  }

  if (deduped.length === 0) {
    // Scoped queries found nothing — the page either isn't a real cart
    // or the layout is one we don't recognize. Return null so the trial
    // falls back to the product, rather than synthesizing a phantom item.
    return null
  }

  const total =
    parsePriceString(
      document.querySelector('#subtotals-marketplace-table .a-color-price, .grand-total-price, #sc-subtotal-amount-activecart .a-color-price')?.textContent?.trim() ||
        '',
    ).price ?? sumPrices(deduped)

  return {
    items: deduped,
    total,
    currency,
    itemCount: deduped.reduce((s, i) => s + (i.quantity || 1), 0),
    source: 'amazon',
    isCheckout: /\/checkout\//i.test(location.pathname),
  }
}

/**
 * Pick the elements that are *actually* in the active cart, not Amazon's
 * recommendation rails. Three scoped selectors in priority order:
 *
 *   1. `#activeCartViewForm [data-asin]` — the active-cart form is a
 *      stable ID that wraps only real items.
 *   2. `[data-name="Active Items"] [data-asin]` — the section name
 *      Amazon uses on the redesigned cart page.
 *   3. `div[data-asin]:has(select[name="quantity"])` — only items with
 *      a quantity dropdown are real cart items; recommendations never
 *      have one.
 *
 * Returns a deduplicated NodeList-like array, scoped to the *first*
 * selector that matches (so we don't double-count if both 1 and 2 exist).
 *
 * NOTE: visibility (e.g. `.sc-list-item-removed`) is filtered *after*
 * the selector runs — see `isRowVisible` above. That way we don't
 * pre-filter rows the selector itself relies on to find the form.
 */
function selectAmazonActiveCartItems(): HTMLElement[] {
  const primary = document.querySelector('#activeCartViewForm [data-asin]')
  if (primary) {
    return dedupeElements(
      Array.from(document.querySelectorAll<HTMLElement>('#activeCartViewForm [data-asin]')),
    )
  }
  const section = document.querySelector('[data-name="Active Items"] [data-asin]')
  if (section) {
    return dedupeElements(
      Array.from(document.querySelectorAll<HTMLElement>('[data-name="Active Items"] [data-asin]')),
    )
  }
  // :has() is supported in modern Chromium (it powers the SW for the
  // extension and recent Chrome on the content-script side). Fall back
  // to a manual scan if it's missing.
  if (typeof CSS !== 'undefined' && CSS.supports('selector(:has(*))')) {
    return dedupeElements(
      Array.from(document.querySelectorAll<HTMLElement>('div[data-asin]')).filter((el) =>
        el.matches('div[data-asin]:has(select[name="quantity"])'),
      ),
    )
  }
  return dedupeElements(
    Array.from(document.querySelectorAll<HTMLElement>('div[data-asin]')).filter(
      (el) => !!el.querySelector('select[name="quantity"]'),
    ),
  )
}

function dedupeElements(els: HTMLElement[]): HTMLElement[] {
  const seen = new Set<HTMLElement>()
  const out: HTMLElement[] = []
  for (const el of els) {
    if (seen.has(el)) continue
    seen.add(el)
    out.push(el)
  }
  return out
}

/**
 * Pick the visible text of the cart-item name. Amazon's cart page
 * renders the title in several places (.sc-product-title, the link
 * text, the truncated text, etc.) and some of them are doubled
 * (visible + screen-reader-only). The cleanest path is the link that
 * points to the product page — its visible text is just the title.
 */
function pickAmazonCartItemName(row: HTMLElement): string {
  const candidates = [
    '.sc-product-title a',
    '.sc-product-title',
    'a.a-link-normal[href*="/dp/"] span.a-truncate',
    'a.a-link-normal[href*="/dp/"]',
    '.a-truncate-cut',
    '.a-link-normal span.a-truncate',
    'h2',
    'h3',
  ]
  for (const sel of candidates) {
    const el = row.querySelector(sel)
    if (!el) continue
    const t = visibleTextOf(el)
    if (t && t.length >= 3) return t
  }
  return ''
}

/**
 * Return the visible (non-screen-reader-only) text of an element.
 * Mirrors the same helper in `product.ts` so both extractors strip
 * " Opens in a new tab" and other a11y-only spans.
 */
function visibleTextOf(el: Element): string {
  const clone = el.cloneNode(true) as Element
  const hidden = clone.querySelectorAll(
    '[aria-hidden="true"], .a-offscreen, .aok-hidden, ' +
      '.visually-hidden, .sr-only, .screen-reader-only, ' +
      '[style*="display: none" i], [style*="visibility: hidden" i]',
  )
  hidden.forEach((n) => n.remove())
  return (clone.textContent || '').replace(/\s+/g, ' ').trim()
}

function dedupeItems(items: CartItem[]): CartItem[] {
  const seenAsin = new Set<string>()
  const seenFallback = new Set<string>()
  const out: CartItem[] = []
  for (const it of items) {
    // Try ASIN first if we have a URL with /dp/ASIN/.
    const asin = extractAsinFromUrl(it.url)
    if (asin) {
      if (seenAsin.has(asin)) continue
      seenAsin.add(asin)
      out.push(it)
      continue
    }
    // Fallback: dedupe on name+price so two identical "Item $9.99" rows
    // don't both make it into the AI's list.
    const key = `${it.name}|${it.price ?? ''}`
    if (seenFallback.has(key)) continue
    seenFallback.add(key)
    out.push(it)
  }
  return out
}

function extractAsinFromUrl(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/)
  return m ? m[1] : null
}

/**
 * Extract rich product details (brand, rating, review count, prime, delivery,
 * stock, was-price, seller, variation) from a single Amazon cart row. Returns
 * `null` if the row has nothing beyond the basic name+price, so we don't
 * carry around a partially-populated object.
 */
function extractAmazonItemDetails(row: HTMLElement, dataAsin: string | null, currentPrice: number | null): ProductDetails | null {
  const d: ProductDetails = {}

  // --- Brand ---
  // Amazon's cart page usually shows the brand either as a leading word in
  // the title (e.g. "Anker USB-C Hub") or in a dedicated `.a-row` near the
  // title. Try several selectors; skip the result if it's too generic.
  const brandEl =
    row.querySelector('.a-row.a-size-base .a-link-normal[href*="/s?"]') ||
    row.querySelector('.a-row .po-brand .po-break-word') ||
    row.querySelector('[data-brand]') ||
    row.querySelector('.a-size-base-plus.a-text-bold')
  const brandText = brandEl?.textContent?.trim() || ''
  if (brandText && brandText.length > 1 && brandText.length < 40) {
    d.brand = brandText
  } else {
    // Fallback: take the first word of the title (e.g. "Anker" from
    // "Anker USB-C Hub"). Skip generic first-words like "The", "A", "An".
    const firstWord = (row.querySelector('.a-truncate-cut, .sc-product-title, h2, h3')?.textContent?.trim() || '').split(/\s+/, 1)[0]
    if (firstWord && !/^(the|a|an)$/i.test(firstWord) && firstWord.length > 1 && firstWord.length < 30) {
      d.brand = firstWord
    }
  }

  // --- Rating + review count ---
  // Amazon marks the rating via aria-label on the stars element
  // (e.g. "4.7 out of 5 stars"). The review count sits in a link.
  const starsEl =
    row.querySelector('i.a-icon-star-mini .a-icon-alt') ||
    row.querySelector('i.a-icon-star .a-icon-alt') ||
    row.querySelector('.a-icon-star-mini .a-icon-alt') ||
    row.querySelector('[class*="a-icon-star"] .a-icon-alt')
  const starsText = starsEl?.getAttribute('aria-label') || starsEl?.textContent?.trim() || ''
  const ratingMatch = starsText.match(/(\d+(?:\.\d+)?)\s*(?:out of|of)\s*5/i)
  if (ratingMatch) d.rating = Number(ratingMatch[1])
  const reviewLink =
    row.querySelector('a[href*="#customerReviews"]') ||
    row.querySelector('a[aria-label*="rating"]') ||
    row.querySelector('a[aria-label*="review"]')
  const reviewText = reviewLink?.textContent?.trim() || ''
  const reviewMatch = reviewText.replace(/[,\s]/g, '').match(/(\d+)/)
  if (reviewMatch) d.reviewCount = Number(reviewMatch[1])

  // --- Prime ---
  // Amazon ships the Prime badge in many shapes: `.a-icon-prime`, the
  // `aria-label` on a Prime logo, or simply the literal "Prime" text in
  // the delivery line. We accept any positive signal.
  const hasPrimeIcon = !!row.querySelector('.a-icon-prime, i.a-icon-prime, [aria-label*="Prime"]')
  const primeInText = /prime/i.test(row.textContent || '')
  if (hasPrimeIcon || primeInText) d.prime = true

  // --- Delivery ---
  // Amazon renders the delivery promise in a few ways depending on cart
  // layout. We prefer scoped matches (closest to the row) before falling
  // back to page-wide ones, because the latter can pick up a sibling
  // row's stock/success text.
  const deliveryEl =
    row.querySelector('[id*="deliveryMessage"] .a-color-base') ||
    row.querySelector('[data-csa-c-delivery]') ||
    row.querySelector('[id*="delivery-block"] .a-color-base') ||
    row.querySelector('.delivery-message') ||
    row.querySelector('.a-color-secondary:not(.a-color-state)')
  const deliveryText = deliveryEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  // Only accept text that looks like a delivery promise: starts with
  // "FREE", "Get it", or contains "delivery" / "tomorrow" / a weekday.
  if (
    deliveryText &&
    deliveryText.length > 3 &&
    deliveryText.length < 200 &&
    /^(free|get it|delivery|tomorrow|today|mon|tue|wed|thu|fri|sat|sun)/i.test(deliveryText)
  ) {
    d.delivery = deliveryText
  }

  // --- Stock ---
  // Stock info often lives in #availability or "Only N left in stock".
  const stockEl =
    row.querySelector('#availability span') ||
    row.querySelector('.a-color-state') ||
    row.querySelector('.a-color-error') ||
    row.querySelector('[id*="availability"] span')
  const stockText = stockEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (stockText && stockText.length > 1 && stockText.length < 200) d.stock = stockText

  // --- Was-price / "Saved $X" ---
  // Amazon's cart shows strikethrough pricing in `.a-text-strike` or
  // `.a-price-was .a-offscreen`. A nearby `.a-color-price` with a $ amount
  // may be the "You save" line.
  const wasPriceEl =
    row.querySelector('.a-price.a-text-strike .a-offscreen') ||
    row.querySelector('.a-text-strike .a-offscreen') ||
    row.querySelector('.a-price-was .a-offscreen')
  if (wasPriceEl) {
    const { price: wasPrice } = parsePriceString(wasPriceEl.textContent?.trim() || '')
    if (wasPrice != null) d.wasPrice = wasPrice
  }
  // "You save $X" or "Save $X (Y%)"
  const saveTextEl =
    row.querySelector('.a-color-savings') ||
    row.querySelector('[id*="savings"]') ||
    row.querySelector('#savingsCell .a-color-price')
  const saveText = saveTextEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (saveText && saveText.length < 80) d.savedText = saveText
  if (d.wasPrice != null && currentPrice != null && currentPrice > 0 && d.wasPrice > currentPrice) {
    d.savePercent = Math.round(((d.wasPrice - currentPrice) / d.wasPrice) * 100)
  }

  // --- Seller / Ships from / Sold by ---
  // Amazon shows "Ships from Amazon.com" + "Sold by X" in the cart row.
  const sellerEl =
    row.querySelector('[data-action="show-all-offers-displayname"]') ||
    row.querySelector('.a-row .a-size-mini .a-link-normal') ||
    row.querySelector('.merchant-name')
  const sellerText = sellerEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (sellerText && sellerText.length > 2 && sellerText.length < 100) d.seller = sellerText

  // --- Subscribe & Save / auto-replenish ---
  const hasSns = !!row.querySelector('.sns-popover-trigger, [id*="sns"], [aria-label*="auto-replenish" i], [aria-label*="subscribe" i]')
  if (hasSns) d.subscribeAndSave = true

  // --- Variation / option text ---
  // E.g. "Color: Black", "Size: 256GB". Amazon marks these with both
  // `.a-row` and `.a-size-mini` on the same element (or uses a dedicated
  // `.variation` class). The seller row is also a `.a-row`, so we use a
  // compound selector to avoid capturing it.
  const variationEl =
    row.querySelector('.a-row.a-size-mini:not(:has(a))') ||
    row.querySelector('.a-row.a-size-mini .a-color-secondary') ||
    row.querySelector('.variation, [data-action="variation"]')
  const variationText = variationEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (variationText && variationText.length > 1 && variationText.length < 80 && !/recommend/i.test(variationText)) {
    d.variation = variationText
  }

  // --- ASIN (already on the row's data-asin) ---
  if (dataAsin && dataAsin.length >= 5) d.asin = dataAsin

  // Return null if we have nothing useful beyond the name+price. This keeps
  // the prompt tight: if Amazon's cart page is bare, we don't carry a
  // mostly-empty details object.
  const anySignal =
    d.brand || d.rating || d.reviewCount || d.prime || d.delivery ||
    d.stock || d.wasPrice || d.savedText || d.seller || d.subscribeAndSave ||
    d.asin || d.variation
  return anySignal ? d : null
}

// === Shopify ===

function extractShopifyCart(): Cart | null {
  const items: CartItem[] = []
  let currency: string | null = null

  const itemEls = Array.from(
    document.querySelectorAll<HTMLElement>('.cart__item, [data-cart-item], .cart-item, line-item'),
  ).filter(isRowVisible)
  for (const el of itemEls) {
    const name =
      el.querySelector('.cart__item-name, .cart-item__name, [data-cart-item-name], .product-title')?.textContent?.trim() ||
      el.querySelector('a')?.textContent?.trim() ||
      ''
    const priceText =
      el.querySelector('.cart__item-price, .cart-item__price, [data-cart-item-price], .product-price')?.textContent?.trim() ||
      ''
    const { price, currency: cur } = parsePriceString(priceText)
    if (cur && !currency) currency = cur
    const qty = parseQuantity(
      el.querySelector('input[name="quantity"], input[data-quantity-input]')?.getAttribute('value') ||
        el.querySelector('quantity-input input')?.getAttribute('value'),
    ) || 1
    const img = (el.querySelector('img') as HTMLImageElement | null)?.src || null
    const link = (el.querySelector('a') as HTMLAnchorElement | null)?.href || null
    if (!name && price == null) continue
    const details = extractShopifyItemDetails(el)
    items.push({
      name: name || 'Item',
      price,
      currency: cur,
      imageUrl: img,
      quantity: qty,
      url: link,
      details,
    })
  }

  if (items.length === 0) return null

  const totalText =
    document.querySelector('.cart__total, .cart-total, [data-cart-total]')?.textContent?.trim() || ''
  const { price: total, currency: tcur } = parsePriceString(totalText)
  if (tcur) currency = tcur

  return {
    items,
    total: total ?? sumPrices(items),
    currency,
    itemCount: items.reduce((s, i) => s + (i.quantity || 1), 0),
    source: 'shopify',
    isCheckout: /\/checkout/.test(location.pathname),
  }
}

/**
 * Best-effort rich details for a Shopify cart row. Most Shopify themes
 * expose variant text (e.g. "Color: Black / Size: M") but rarely the
 * rating/Prime signals Amazon has. We grab what we can.
 */
function extractShopifyItemDetails(row: HTMLElement): ProductDetails | null {
  const d: ProductDetails = {}
  const variantEl =
    row.querySelector('.cart__item-variant, .product-variant, [data-cart-item-variant]') ||
    row.querySelector('.cart-item__variant, .variant__list')
  const variantText = variantEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (variantText && variantText.length > 1 && variantText.length < 80) d.variation = variantText
  const brandEl = row.querySelector('.cart__item-brand, .product-brand, [data-cart-item-brand]')
  const brandText = brandEl?.textContent?.trim() || ''
  if (brandText && brandText.length > 1 && brandText.length < 40) d.brand = brandText
  return d.brand || d.variation ? d : null
}

// === eBay ===

function extractEbayCart(): Cart | null {
  const items: CartItem[] = []
  let currency: string | null = null

  const itemEls = Array.from(
    document.querySelectorAll<HTMLElement>('.cart-item, [data-item-id], .merch-item'),
  ).filter(isRowVisible)
  for (const el of itemEls) {
    const name =
      el.querySelector('.item-title, .merch-item-title, [data-item-title]')?.textContent?.trim() || ''
    const priceText =
      el.querySelector('.item-price, .merch-item-price, [data-item-price]')?.textContent?.trim() || ''
    const { price, currency: cur } = parsePriceString(priceText)
    if (cur && !currency) currency = cur
    const qty = parseQuantity(el.querySelector('input.qty-input')?.getAttribute('value')) || 1
    const img = (el.querySelector('img') as HTMLImageElement | null)?.src || null
    const link = (el.querySelector('a') as HTMLAnchorElement | null)?.href || null
    if (!name && price == null) continue
    const details = extractEbayItemDetails(el)
    items.push({
      name: name || 'Item',
      price,
      currency: cur,
      imageUrl: img,
      quantity: qty,
      url: link,
      details,
    })
  }

  if (items.length === 0) return null

  const totalText =
    document.querySelector('.cart-total, .total-amount, [data-cart-total]')?.textContent?.trim() || ''
  const { price: total, currency: tcur } = parsePriceString(totalText)
  if (tcur) currency = tcur

  return {
    items,
    total: total ?? sumPrices(items),
    currency,
    itemCount: items.reduce((s, i) => s + (i.quantity || 1), 0),
    source: 'ebay',
    isCheckout: /\/checkout/.test(location.pathname),
  }
}

function extractEbayItemDetails(row: HTMLElement): ProductDetails | null {
  const d: ProductDetails = {}
  const variantEl = row.querySelector('.item-variation, .merch-item-variation, [data-item-variation]')
  const variantText = variantEl?.textContent?.trim().replace(/\s+/g, ' ') || ''
  if (variantText && variantText.length > 1 && variantText.length < 80) d.variation = variantText
  return d.variation ? d : null
}

// === Generic fallback ===

function extractGenericCart(): Cart | null {
  // Heuristic: find groups of elements that look like cart rows.
  // A "row" is a container with a name-like text and a price-like text.
  const candidates: { name: string; price: number; currency: string | null }[] = []

  // Walk the DOM for price-like patterns.
  const priceRe = /(\$\s*\d{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+\.\d{2})/g

  // Look for elements that contain a "remove" or "trash" icon (cart-specific).
  const containers = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[class*="cart-item"], [class*="cart-row"], [class*="basket-item"], [class*="line-item"]',
    ),
  ).filter(isRowVisible)

  for (const el of containers) {
    const text = el.textContent?.trim() || ''
    const priceMatch = text.match(priceRe)
    if (!priceMatch) continue
    // First price is the line item price.
    const { price, currency } = parsePriceString(priceMatch[0])
    if (price == null) continue
    // First non-empty line of text is usually the product name.
    const firstLine = text.split('\n').map((s) => s.trim()).find((s) => s.length > 3 && s.length < 200)
    if (!firstLine) continue
    candidates.push({ name: firstLine, price, currency })
  }

  if (candidates.length === 0) return null

  const currency = candidates[0].currency
  return {
    items: candidates.map((c) => ({
      name: c.name,
      price: c.price,
      currency: c.currency,
      imageUrl: null,
      quantity: 1,
      url: null,
    })),
    total: candidates.reduce((s, c) => s + c.price, 0),
    currency,
    itemCount: candidates.length,
    source: 'generic',
    isCheckout: /\/checkout/.test(location.pathname),
  }
}

function parseQuantity(raw: string | null | undefined): number {
  if (!raw) return 0
  const n = parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function sumPrices(items: CartItem[]): number {
  return items.reduce((s, i) => s + (i.price ?? 0) * (i.quantity || 1), 0)
}

export function parsePriceString(
  raw: string,
  domain?: string,
): { price: number | null; currency: string | null } {
  if (!raw) return { price: null, currency: null }
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  let currency: string | null = null
  const symMatch = cleaned.match(/^([$€£¥]|US\s*\$|C\$|A\$|CA\$|AU\$|CDN\$)/i)
  if (symMatch) {
    const sym = symMatch[1].toUpperCase().replace(/\s/g, '')
    const map: Record<string, string> = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', 'C$': 'CAD', 'A$': 'AUD' }
    currency = map[sym] ?? sym
  } else {
    const codeMatch = cleaned.match(/\b(USD|EUR|GBP|JPY|CAD|AUD|CHF|SEK|NOK|DKK|INR|BRL|MXN)\b/i)
    if (codeMatch) currency = codeMatch[1].toUpperCase()
  }
  // On .ca domains, the page is Canadian — default to CAD even if
  // the price text shows a bare "$" or literally "USD". Amazon.ca
  // and other Canadian stores list all prices in CAD regardless of
  // which symbol or code is rendered. Domain is passed in by the
  // caller; we fall back to location.hostname so the existing call
  // sites don't need to be touched.
  const effectiveDomain =
    domain ?? (typeof location !== 'undefined' ? location.hostname : '')
  if (currency === 'USD' && /\.ca$/i.test(effectiveDomain)) {
    currency = 'CAD'
  }
  const numMatch = cleaned.match(/(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/)
  let price: number | null = null
  if (numMatch) {
    const n = Number(numMatch[1].replace(/[,\s]/g, ''))
    if (!Number.isNaN(n)) price = n
  }
  return { price, currency }
}
