import type { Product } from '../ai/types'
import { shortHash } from '../utils/hash.ts'

/**
 * Best-effort product metadata extraction.
 *
 * Order:
 *   1. Schema.org JSON-LD with @type:Product
 *   2. Open Graph / product meta tags
 *   3. Site-specific selectors (Amazon, Shopify, eBay, generic)
 *   4. Document heuristics
 *
 * The JSON-LD and site-specific layers are both run, then merged
 * (site-specific wins on conflicts because it has the structured
 * per-site fields like brand+rating). The OG layer is only used as
 * a final fallback for the product name when neither of the above
 * produced one.
 *
 * No form data is ever read.
 */
export function extractProduct(): Product {
  const url = location.href
  const domain = location.hostname

  // 1. JSON-LD
  const fromJsonLd = tryJsonLd()
  // 3. Site-specific (run early so it can fill brand/rating/prime
  //    even when the OG layer provides the name).
  const fromSite = trySiteSpecific(domain)

  // Merge: site-specific wins on name, brand, rating, reviewCount,
  // prime, image, price. JSON-LD wins only for fields site-specific
  // didn't fill.
  if (fromSite.name || fromJsonLd) {
    const merged: PartialProduct = {
      name: fromSite.name || fromJsonLd?.name || '',
      price: fromSite.price != null ? fromSite.price : fromJsonLd?.price ?? null,
      currency: fromSite.currency ?? fromJsonLd?.currency ?? null,
      imageUrl: fromSite.imageUrl ?? fromJsonLd?.imageUrl ?? null,
      rawTitle: fromSite.rawTitle ?? fromJsonLd?.rawTitle,
      brand: fromSite.brand ?? fromJsonLd?.brand ?? null,
      rating: fromSite.rating ?? fromJsonLd?.rating ?? null,
      reviewCount: fromSite.reviewCount ?? fromJsonLd?.reviewCount ?? null,
      prime: fromSite.prime ?? fromJsonLd?.prime ?? null,
      url,
      domain,
    }
    if (merged.name || merged.price != null || merged.imageUrl) {
      const result = finalize(merged)
      console.log('[WhyBuy] extractProduct: merged result:', {
        name: result.name,
        brand: result.brand,
        price: result.price,
        rating: result.rating,
        reviewCount: result.reviewCount,
      })
      return result
    }
  }

  // 2. OG / meta (fallback for the name)
  const fromMeta = tryMeta()
  if (fromMeta.name) {
    const result = finalize({ ...fromMeta, url, domain })
    console.log('[WhyBuy] extractProduct: meta result:', {
      name: result.name,
      brand: result.brand,
      price: result.price,
    })
    return result
  }

  // 4. Generic DOM fallback
  const result = finalize({
    name: guessNameFromDom(),
    price: null,
    currency: null,
    imageUrl: null,
    url,
    domain,
  })
  console.log('[WhyBuy] extractProduct: DOM fallback result:', {
    name: result.name,
    brand: result.brand,
    price: result.price,
  })
  return result
}

interface PartialProduct {
  name: string
  price: number | null
  currency: string | null
  imageUrl: string | null
  rawTitle?: string
  brand?: string | null
  rating?: number | null
  reviewCount?: number | null
  prime?: boolean | null
  url: string
  domain: string
}

interface ProductDetailsResult {
  brand: string | null
  rating: number | null
  reviewCount: number | null
  prime: boolean | null
}

function finalize(p: PartialProduct): Product {
  const fingerprint = shortHash(`${p.name}|${p.price ?? ''}|${p.domain}`)
  return { ...p, fingerprint }
}

/**
 * Extract rich product details (brand, rating, review count, prime)
 * for a single product page. Returns nulls for any field the page
 * didn't expose. Used by all four code paths (JSON-LD, OG, site-
 * specific, generic) so the resulting Product is fully populated
 * regardless of which one fired.
 */
function tryJsonLd(): Omit<PartialProduct, 'url' | 'domain'> | null {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')
  for (const s of Array.from(scripts)) {
    const text = s.textContent
    if (!text) continue
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      continue
    }
    const product = findProductNode(parsed)
    if (product) {
      const name = str(product.name) ?? guessNameFromDom()
      const offer = pickOffer(product.offers)
      const details = extractJsonLdDetails(product)
      return {
        name: cleanName(name),
        price: offer?.price != null ? Number(offer.price) : null,
        currency: offer?.priceCurrency ?? null,
        imageUrl: pickImage(product.image),
        rawTitle: str(product.name) ?? undefined,
        ...details,
      }
    }
  }
  return null
}

function extractJsonLdDetails(product: any): { brand: string | null; rating: number | null; reviewCount: number | null; prime: boolean | null } {
  const brand = extractJsonLdBrand(product)
  const rating = pickRating(product.aggregateRating)
  const reviewCount = pickReviewCount(product.aggregateRating)
  return { brand, rating, reviewCount, prime: null }
}

function extractJsonLdBrand(product: any): string | null {
  const b = product.brand
  if (!b) return null
  // brand can be a string, an object, or an array
  if (typeof b === 'string') return trimBrand(b)
  if (Array.isArray(b) && b.length > 0) {
    const first = b[0]
    if (typeof first === 'string') return trimBrand(first)
    if (first && typeof first === 'object' && typeof first.name === 'string') return trimBrand(first.name)
  }
  if (typeof b === 'object' && typeof b.name === 'string') return trimBrand(b.name)
  return null
}

function trimBrand(s: string): string | null {
  const cleaned = s.replace(/\s+/g, ' ').trim()
  if (!cleaned || cleaned.length < 2 || cleaned.length > 60) return null
  // Skip pure numbers, brand-less entries
  if (/^[\d.\-/]+$/.test(cleaned)) return null
  return cleaned
}

function pickRating(ar: any): number | null {
  if (!ar) return null
  const v = ar.ratingValue ?? ar.rating
  if (v == null) return null
  const n = Number(v)
  if (Number.isNaN(n) || n < 0 || n > 5) return null
  return n
}

function pickReviewCount(ar: any): number | null {
  if (!ar) return null
  const v = ar.reviewCount ?? ar.ratingCount
  if (v == null) return null
  const n = Number(v)
  if (Number.isNaN(n) || n < 0) return null
  return n
}

function findProductNode(node: any): any | null {
  if (!node) return null
  if (Array.isArray(node)) {
    for (const n of node) {
      const found = findProductNode(n)
      if (found) return found
    }
    return null
  }
  if (typeof node !== 'object') return null
  const t = node['@type']
  if (t === 'Product' || (Array.isArray(t) && t.includes('Product'))) {
    return node
  }
  if (t && typeof t === 'object' && (t as any)['@value'] === 'Product') return node
  if (Array.isArray(node['@graph'])) {
    for (const g of node['@graph']) {
      const found = findProductNode(g)
      if (found) return found
    }
  }
  return null
}

function pickOffer(offers: any): { price: number | string; priceCurrency?: string } | null {
  if (!offers) return null
  const list = Array.isArray(offers) ? offers : [offers]
  for (const o of list) {
    if (o && (o.price != null || o.lowPrice != null)) {
      return {
        price: o.price ?? o.lowPrice,
        priceCurrency: o.priceCurrency,
      }
    }
  }
  return null
}

function pickImage(image: any): string | null {
  if (!image) return null
  if (typeof image === 'string') return image
  if (Array.isArray(image)) return typeof image[0] === 'string' ? image[0] : image[0]?.url ?? null
  if (typeof image === 'object' && typeof image.url === 'string') return image.url
  return null
}

function tryMeta(): Omit<PartialProduct, 'url' | 'domain'> {
  const ogTitle = meta('og:title') || meta('twitter:title')
  const docTitle = document.title
  const name = ogTitle || docTitle
  const priceRaw = meta('product:price:amount') || meta('og:price:amount')
  const currency = meta('product:price:currency') || meta('og:price:currency') || null
  const imageUrl = meta('og:image') || meta('twitter:image') || null
  const price = priceRaw ? Number(priceRaw.replace(/[^0-9.]/g, '')) : null
  return {
    name: name ? cleanName(name) : guessNameFromDom(),
    price: price != null && !Number.isNaN(price) ? price : null,
    currency,
    imageUrl,
    rawTitle: name || undefined,
  }
}

function meta(name: string): string | null {
  const el = document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)
  return el ? el.getAttribute('content')?.trim() ?? null : null
}

/**
 * Site-specific product extractors. We support a small set of well-known
 * e-commerce sites that don't always emit clean JSON-LD or OG tags.
 */
function trySiteSpecific(domain: string): Omit<PartialProduct, 'url' | 'domain'> {
  if (/amazon\./i.test(domain)) return extractAmazon()
  if (/ebay\./i.test(domain)) return extractEbay()
  // Shopify stores: many rely on the standard JSON-LD, so we only add
  // a defensive h1-based fallback if JSON-LD was missing.
  if (isShopify()) return extractShopify()
  return { name: '', price: null, currency: null, imageUrl: null }
}

function extractAmazon(): Omit<PartialProduct, 'url' | 'domain'> {
  // Amazon product title selectors, in priority order. We try the
  // canonical `#productTitle` first because it's the most stable, then
  // fall back to a chain of alternatives. The extended chain below
  // covers both legacy and redesigned Amazon pages (amazon.com and
  // amazon.ca share the same template, but the `data-feature-name`
  // attribute has been seen on the latest redesign when `#productTitle`
  // is moved into a slot).
  //
  // We use `pickFirstVisibleText` (not raw textContent) so screen-
  // reader-only spans like " Opens in a new tab" don't leak into the
  // extracted title.
  const name =
    pickFirstVisibleText([
      '#productTitle',
      'h1#title',
      'h1.a-size-large.product-title-word-break',
      'h1.a-size-large',
      '#titleSection h1',
      '[data-feature-name="productTitle"] h1',
      '[data-feature-name="productTitle"]',
      'h1#productTitle',
      'h1#titleSection',
    ]) ||
    // Last-ditch: any h1 in the main content area, also visible-only.
    pickFirstVisibleText(['#centerCol h1', '#mainContent h1', 'h1']) ||
    ''
  const priceWhole =
    document.querySelector('.a-price .a-offscreen')?.textContent?.trim() ||
    document.querySelector('#priceblock_ourprice')?.textContent?.trim() ||
    document.querySelector('#priceblock_dealprice')?.textContent?.trim() ||
    document.querySelector('.a-price-whole')?.textContent?.trim() ||
    document.querySelector('#corePrice_feature_div .a-offscreen')?.textContent?.trim() ||
    document.querySelector('[data-testid="price"] .a-offscreen')?.textContent?.trim() ||
    ''
  const { price, currency } = parsePriceString(priceWhole)
  const imageUrl =
    (document.querySelector('#landingImage') as HTMLImageElement | null)?.src ||
    (document.querySelector('#imgBlkFront') as HTMLImageElement | null)?.src ||
    (document.querySelector('#main-image') as HTMLImageElement | null)?.src ||
    (document.querySelector('img#imgTagWrapperId') as HTMLImageElement | null)?.src ||
    (document.querySelector('#imgTagWrapperId img') as HTMLImageElement | null)?.src ||
    (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content ||
    null
  const details = extractAmazonDetails(name)
  const result = {
    name: name ? cleanName(name) : guessNameFromDom(),
    price,
    currency,
    imageUrl: imageUrl ? absolutize(imageUrl) : null,
    rawTitle: name || undefined,
    ...details,
  }
  // Always log the extraction result so the debug panel can show
  // exactly what we read off the page.
  if (typeof console !== 'undefined') {
    console.log('[WhyBuy] extractAmazon:', {
      name: result.name,
      brand: result.brand,
      price: result.price,
      currency: result.currency,
      prime: result.prime,
      rating: result.rating,
      reviewCount: result.reviewCount,
    })
  }
  return result
}

/**
 * Try each CSS selector in turn and return the first non-empty
 * `textContent` (trimmed). Returns `''` if none match.
 */
function pickFirstText(selectors: string[]): string {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    const t = el?.textContent?.trim()
    if (t) return t
  }
  return ''
}

/**
 * Try each CSS selector in turn and return the first non-empty
 * `textContent` with screen-reader-only spans removed. Amazon's
 * redesigned product page renders `#productTitle` as a link that
 * contains both the visible title text and a hidden span with
 * " Opens in a new tab" for screen readers — `textContent` reads
 * both, which is what was causing the "Foo Foo Opens in a new tab"
 * duplication. We clone the node, strip sr-only descendants, and
 * read `textContent` of the clone.
 */
function pickFirstVisibleText(selectors: string[]): string {
  for (const sel of selectors) {
    const el = document.querySelector(sel)
    if (!el) continue
    const t = visibleTextOf(el)
    if (t) return t
  }
  return ''
}

/**
 * Return the visible (non-screen-reader-only) text of an element.
 * Clones the node, removes all visually-hidden / sr-only descendants,
 * and reads the clone's `textContent`. The original DOM is untouched.
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

/**
 * Best-effort rich details from a product page (Amazon, primarily).
 * Mirrors the per-row cart extractor: brand, rating, review count,
 * prime. We do NOT pull delivery/stock from product pages — those
 * come from the cart row.
 */
function extractAmazonDetails(name: string): ProductDetailsResult {
  // Brand: Amazon's byline (e.g. "Visit the Anker Store" or
  // "Brand: Anker"), with the first word of the title as fallback.
  const byline = document.querySelector('#bylineInfo')?.textContent?.trim() || ''
  const brand = extractAmazonBrand(byline, name)

  // Rating: "4.7 out of 5 stars" on the rating popover or
  // `#averageCustomerReviews .a-icon-alt`.
  const starsText =
    document.querySelector('#acrPopover')?.getAttribute('title') ||
    document.querySelector('#averageCustomerReviews .a-icon-alt')?.getAttribute('aria-label') ||
    document.querySelector('#averageCustomerReviews .a-icon-alt')?.textContent ||
    ''
  let rating: number | null = null
  const rm = starsText.match(/(\d+(?:\.\d+)?)\s*(?:out\s*of|of)\s*5/i)
  if (rm) rating = Number(rm[1])

  // Review count: "12,453 ratings" in `#acrCustomerReviewText`.
  const reviewText = document.querySelector('#acrCustomerReviewText')?.textContent?.trim() || ''
  const rcm = reviewText.replace(/[,\s]/g, '').match(/(\d+)/)
  const reviewCount = rcm ? Number(rcm[1]) : null

  // Prime: any positive signal on the page (icon or text).
  const hasPrimeIcon = !!document.querySelector(
    '.a-icon-prime, i.a-icon-prime, [aria-label*="Prime" i], [class*="prime"]',
  )
  const primeInText = /prime\s*(eligible|delivery)/i.test(document.body.textContent || '')
  const prime = hasPrimeIcon || primeInText ? true : null

  return { brand, rating, reviewCount, prime }
}

function extractAmazonBrand(byline: string, productName: string): string | null {
  // "Visit the Anker Store"
  let m = byline.match(/visit\s+the\s+([\w][\w\s&-'.]{1,40}?)\s+store/i)
  if (m) return trimBrand(m[1])
  // "Brand: Anker"
  m = byline.match(/brand\s*[:-]\s*([\w][\w\s\-&'.]{1,40}?)(?:[,\n]|$)/i)
  if (m) return trimBrand(m[1])
  // "by Anker"
  m = byline.match(/\bby\s+([\w][\w\s\-&'.]{1,40}?)(?:[,\n]|$)/i)
  if (m) return trimBrand(m[1])
  // Fallback: first word of the title.
  const firstWord = (productName || '').split(/\s+/, 1)[0] || ''
  if (
    firstWord &&
    firstWord.length > 1 &&
    firstWord.length < 30 &&
    !/^(the|a|an)$/i.test(firstWord)
  ) {
    return firstWord
  }
  return null
}

function extractEbay(): Omit<PartialProduct, 'url' | 'domain'> {
  const name = (
    document.querySelector('h1.x-item-title__mainTitle')?.textContent?.trim() ||
    document.querySelector('h1#itemTitle')?.textContent?.trim() ||
    document.querySelector('h1.product-title')?.textContent?.trim() ||
    ''
  )
  const priceText =
    document.querySelector('div.x-price-primary')?.textContent?.trim() ||
    document.querySelector('#prcIsum')?.textContent?.trim() ||
    document.querySelector('#mm-saleDscPrc')?.textContent?.trim() ||
    ''
  const { price, currency } = parsePriceString(priceText)
  const imageUrl =
    (document.querySelector('#icImg') as HTMLImageElement | null)?.src ||
    (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content ||
    null
  const brand = extractEbayBrand()
  return {
    name: name ? cleanName(name) : guessNameFromDom(),
    price,
    currency,
    imageUrl,
    rawTitle: name || undefined,
    brand,
  }
}

function extractEbayBrand(): string | null {
  const el = document.querySelector('[itemprop="brand"]')?.textContent?.trim()
  if (el) return trimBrand(el)
  return null
}

function isShopify(): boolean {
  return !!(
    document.querySelector('meta[name="shopify-checkout-api-token"]') ||
    document.querySelector('script[src*="cdn.shopify.com"]')
  )
}

function extractShopify(): Omit<PartialProduct, 'url' | 'domain'> {
  const name =
    document.querySelector('h1.product__title')?.textContent?.trim() ||
    document.querySelector('h1.product-title')?.textContent?.trim() ||
    document.querySelector('h1[itemprop="name"]')?.textContent?.trim() ||
    ''
  const priceText =
    document.querySelector('[itemprop="price"]')?.getAttribute('content') ||
    document.querySelector('.product__price')?.textContent?.trim() ||
    document.querySelector('.price__current')?.textContent?.trim() ||
    ''
  const { price, currency } = parsePriceString(priceText)
  const imageUrl =
    (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content || null
  return {
    name: name ? cleanName(name) : guessNameFromDom(),
    price,
    currency,
    imageUrl,
    rawTitle: name || undefined,
  }
}

export function parsePriceString(
  raw: string,
  domain?: string,
): { price: number | null; currency: string | null } {
  if (!raw) return { price: null, currency: null }
  const cleaned = raw.replace(/\s+/g, ' ').trim()
  // Currency detection: leading symbol or 3-letter code.
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
  // Price: digits with optional thousand separators and decimal.
  const numMatch = cleaned.match(/(\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/)
  let price: number | null = null
  if (numMatch) {
    const numStr = numMatch[1].replace(/[,\s]/g, '')
    const n = Number(numStr)
    if (!Number.isNaN(n)) price = n
  }
  return { price, currency }
}

function absolutize(url: string): string {
  try {
    return new URL(url, location.href).toString()
  } catch {
    return url
  }
}

function guessNameFromDom(): string {
  const h1 = document.querySelector('h1')?.textContent?.trim()
  if (h1) return cleanName(h1)
  return cleanName(document.title || location.hostname)
}

export function cleanName(name: string): string {
  if (!name) return ''
  let s = name
  // Strip trailing site suffix like "| Amazon.com" / " - Amazon.ca"
  s = s.replace(/\s+[|—–-]\s+(?:amazon\.[a-z.]+|www\.[^\s]+)\s*$/i, '')
  // Strip trailing " - Amazon.com" without a leading separator (rare, but
  // Amazon's mobile layout sometimes renders " - Amazon.com" directly)
  s = s.replace(/\s+-\s+Amazon\.[a-z.]+\s*$/i, '')
  // Strip trailing " Opens in a new tab" / "(opens in a new tab)" — this
  // is Amazon's screen-reader-only text that leaks into `textContent`
  // when the title link is rendered with both visible and a11y text.
  s = s.replace(/\s*[(\s]?opens?\s+in\s+a\s+new\s+tab[)\s]?\s*$/i, '')
  // Collapse runs of whitespace
  s = s.replace(/\s+/g, ' ').trim()
  // Dedupe a doubled title where the exact same string appears twice
  // in a row (Amazon's redesigned product page renders the title in
  // both the visible <a> and an aria-describedby reference, so
  // textContent reads "Foo Foo").
  if (s.length > 8) {
    const half = s.slice(0, Math.floor(s.length / 2))
    const other = s.slice(Math.floor(s.length / 2))
    if (half === other) s = half
    // Also dedupe when the second half *starts with* the first half
    // followed by extra (e.g. "FooFoo bar" — not half-and-half).
    if (other.startsWith(half)) s = half
  }
  return s.slice(0, 200)
}

function str(v: any): string | null {
  if (typeof v === 'string') return v
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0]
  if (v && typeof v === 'object' && typeof v['@value'] === 'string') return v['@value']
  if (v && typeof v === 'object' && typeof v.name === 'string') return v.name
  return null
}
