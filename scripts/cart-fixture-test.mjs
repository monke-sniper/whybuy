// Cart fixture test.
//
// Loads scripts/fixtures/amazon-cart.html in puppeteer and verifies that
// the Amazon cart extractor returns EXACTLY 2 items (the two real ones),
// ignoring the 6 recommendation rows outside #activeCartViewForm.
//
// Run:
//   node scripts/cart-fixture-test.mjs
//
// This test will FAIL on the previous (broad-selector) extraction code
// and PASS after the active-cart-only fix.

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const fixturePath = join(__dirname, 'fixtures', 'cart', 'amazon.html')
const puppeteerChrome = resolveChrome()

if (!existsSync(fixturePath)) {
  console.error('Fixture not found:', fixturePath)
  process.exit(1)
}

// Spin up a tiny HTTP server on a random port and serve the fixture at
// a path that matches Amazon's `/gp/cart` URL pattern. We need a real
// http(s) origin so `location.hostname` is non-empty; the extractor
// dispatches on the hostname (`amazon.*` -> Amazon path).
const FIXTURE_HTML = readFileSync(fixturePath, 'utf8')
const server = createServer((req, res) => {
  if (req.url === '/gp/cart' || req.url === '/gp/cart/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(FIXTURE_HTML)
  } else if (req.url === '/favicon.ico') {
    res.writeHead(204)
    res.end()
  } else {
    res.writeHead(404)
    res.end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
// Serve on localhost. The test calls extractAmazonCart directly (not
// extractCart) so the hostname dispatch is bypassed.
const fixtureUrl = `http://127.0.0.1:${port}/gp/cart`

// The compiled extractor is bundled into the content script. For an
// isolated unit-style test we compile lib/intercept/cart.ts to a plain
// JS string via esbuild (already a project dep) and inject it into the
// page. This avoids needing to bundle the whole extension for the test.
import { build } from 'esbuild'

const compiled = await build({
  entryPoints: [join(projectRoot, 'lib', 'intercept', 'cart.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__whybuyCart',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
  absWorkingDir: projectRoot,
})

const harnessSource = `
${compiled.outputFiles[0].text}
window.__extractCart = __whybuyCart.extractCart
window.__extractAmazonCart = __whybuyCart.extractAmazonCart
`

const browser = await puppeteer.launch({
  executablePath: puppeteerChrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  timeout: 30000,
})

let exitCode = 0
try {
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))

  await page.goto(fixtureUrl, { waitUntil: 'load' })
  // Inject the cart extractor into the page.
  await page.evaluate(harnessSource)
  // Verify the IIFE exported the extractor, then mirror it onto window.
  const ready = await page.evaluate(() => {
    if (typeof __whybuyCart === 'undefined') return false
    if (typeof __whybuyCart.extractAmazonCart !== 'function') return false
    window.__extractCart = __whybuyCart.extractCart
    window.__extractAmazonCart = __whybuyCart.extractAmazonCart
    return true
  })
  if (!ready) throw new Error('extractAmazonCart was not installed on the page')

  // Call extractAmazonCart directly — the hostname dispatch in
  // extractCart would otherwise drop us into the generic path on a
  // non-amazon hostname. The Amazon extractor is the unit under test.
  const cart = await page.evaluate(() => window.__extractAmazonCart())

  console.log('\n=== Cart fixture test ===')
  console.log('Extracted cart:')
  console.log(JSON.stringify(cart, null, 2))

  // Assertions
  const fail = (msg) => {
    console.error('  ✘', msg)
    exitCode = 1
  }
  const pass = (msg) => console.log('  ✔', msg)

  if (!cart) {
    fail('extractCart returned null — the fixture is shaped like a cart, should be detected')
  } else {
    if (cart.itemCount === 2) pass('itemCount === 2 (removed item is NOT counted)')
    else fail(`itemCount should be 2, got ${cart.itemCount}`)

    if (cart.items.length === 2) pass('items.length === 2 (removed item is NOT counted)')
    else fail(`items.length should be 2, got ${cart.items.length}`)

    // Verify the removed item is not in the result.
    const allAsins = cart.items.map((i) => {
      const m = (i.url || '').match(/\/dp\/([A-Z0-9]+)/i)
      return m ? m[1] : null
    })
    if (!allAsins.includes('B0REMOVED1')) pass('removed item ASIN B0REMOVED1 is NOT in result')
    else fail(`removed item leaked into result: ASINs=${allAsins.join(',')}`)

    const allText = cart.items.map((i) => i.name).join(' ')
    if (!/Removed Item/i.test(allText)) pass('removed item title is NOT in result')
    else fail(`removed item title leaked: ${allText}`)

    // The hidden row's $999.99 must not contribute to the total.
    if (Math.abs((cart.total ?? 0) - 135.98) < 0.01) pass('total ≈ 135.98 (removed item $999.99 NOT included)')
    else fail(`total should be ≈ 135.98 (excluded $999.99 removed item), got ${cart.total}`)

    if (cart.items.length === 2) {
      const names = cart.items.map((i) => i.name)
      if (names[0]?.includes('Anker')) pass('first item is Anker USB-C Hub')
      else fail(`first item should include "Anker", got "${names[0]}"`)
      if (names[1]?.includes('Logitech')) pass('second item is Logitech MX Master 3S')
      else fail(`second item should include "Logitech", got "${names[1]}"`)

      // Make sure none of the "Recommendation X" strings leaked through.
      const allText = names.join(' ')
      if (!/Recommendation [A-F]/i.test(allText)) pass('no recommendation rows leaked into items')
      else fail(`recommendation rows leaked: ${allText}`)

      // === Rich product details ===
      const [a, b] = cart.items
      if (a.details?.brand === 'Anker') pass('Anker brand detected')
      else fail(`Anker brand should be "Anker", got "${a.details?.brand}"`)

      if (a.details?.rating === 4.7) pass('Anker rating === 4.7')
      else fail(`Anker rating should be 4.7, got ${a.details?.rating}`)

      if (a.details?.reviewCount === 12453) pass('Anker reviewCount === 12453')
      else fail(`Anker reviewCount should be 12453, got ${a.details?.reviewCount}`)

      if (a.details?.prime === true) pass('Anker is Prime')
      else fail(`Anker should be Prime, got ${a.details?.prime}`)

      if (a.details?.delivery && /Mon, Jun 16|FREE delivery/i.test(a.details.delivery)) pass('Anker delivery text captured')
      else fail(`Anker delivery should be captured, got "${a.details?.delivery}"`)

      if (a.details?.stock && /In stock/i.test(a.details.stock)) pass('Anker stock = "In stock"')
      else fail(`Anker stock should be "In stock", got "${a.details?.stock}"`)

      if (a.details?.wasPrice === 49.99) pass('Anker wasPrice === 49.99')
      else fail(`Anker wasPrice should be 49.99, got ${a.details?.wasPrice}`)

      if (a.details?.savePercent === 28) pass('Anker savePercent === 28')
      else fail(`Anker savePercent should be 28, got ${a.details?.savePercent}`)

      if (a.details?.savedText && /Save \$14/i.test(a.details.savedText)) pass('Anker savedText captured')
      else fail(`Anker savedText should be captured, got "${a.details?.savedText}"`)

      if (a.details?.asin === 'B07FZ8S74R') pass('Anker ASIN captured')
      else fail(`Anker ASIN should be B07FZ8S74R, got "${a.details?.asin}"`)

      if (a.details?.seller && /Amazon\.com/.test(a.details.seller)) pass('Anker seller = Amazon.com')
      else fail(`Anker seller should mention Amazon.com, got "${a.details?.seller}"`)

      // Logitech: no discount, has rating, has variation.
      if (b.details?.brand === 'Logitech') pass('Logitech brand detected')
      else fail(`Logitech brand should be "Logitech", got "${b.details?.brand}"`)

      if (b.details?.rating === 4.8) pass('Logitech rating === 4.8')
      else fail(`Logitech rating should be 4.8, got ${b.details?.rating}`)

      if (b.details?.reviewCount === 50214) pass('Logitech reviewCount === 50214')
      else fail(`Logitech reviewCount should be 50214, got ${b.details?.reviewCount}`)

      if (b.details?.prime === true) pass('Logitech is Prime')
      else fail(`Logitech should be Prime, got ${b.details?.prime}`)

      if (b.details?.variation && /Graphite/i.test(b.details.variation)) pass('Logitech variation = "Color: Graphite"')
      else fail(`Logitech variation should mention Graphite, got "${b.details?.variation}"`)

      if (b.details?.wasPrice == null) pass('Logitech has no wasPrice (full price)')
      else fail(`Logitech wasPrice should be null, got ${b.details?.wasPrice}`)
    }

    if (cart.source === 'amazon') pass('source === "amazon"')
    else fail(`source should be "amazon", got "${cart.source}"`)

    // The fixture is Amazon.com with bare "$" prices, so USD is correct.
    // (Commit 2d3f635 blanket-replaced this assertion to CAD; that was a
    // behavioural change, not a label change. CAD is only produced on .ca
    // domains, which 127.0.0.1 is not.)
    if (cart.currency === 'USD') pass('currency === "USD"')
    else fail(`currency should be "USD", got "${cart.currency}"`)
  }
} catch (err) {
  console.error('\n✘ Cart fixture test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  await browser.close().catch(() => {})
  server.close()
}

if (exitCode === 0) console.log('\n✔ Cart fixture test passed.')
else console.log('\n✘ Cart fixture test FAILED.')
process.exit(exitCode)
