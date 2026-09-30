// Product fixture test.
//
// Loads three product-page fixtures in puppeteer and verifies that
// extractProduct() returns the expected brand, price, rating, and
// review count for each:
//
//   1. scripts/fixtures/product/amazon.html
//      - Anker USB-C Hub. Has a byline (#bylineInfo).
//      - Expects brand="Anker", rating=4.7, reviewCount=12453, price=35.99.
//
//   2. scripts/fixtures/product/acme-mug.html
//      - No byline. No JSON-LD. Title "Acme Mug".
//      - Expects brand="Acme" (first-word fallback).
//
//   3. scripts/fixtures/product/the-hat.html
//      - No byline. Title "The Cool Hat".
//      - Expects brand=null (skipped "The").
//
// Run:
//   node scripts/product-fixture-test.mjs

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'
import { build } from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const puppeteerChrome = resolveChrome()

const FIXTURES = [
  {
    name: 'Anker USB-C Hub (with byline)',
    path: join(__dirname, 'fixtures', 'product', 'amazon.html'),
    // Use the localtest.me trick so the cart extractor's hostname
    // dispatch fires (`/amazon\./i`). The product extractor branches
    // on `domain` matching `/amazon\./i`, and `amazon.localtest.me`
    // is a public-DNS hostname that always resolves to 127.0.0.1.
    hostname: 'amazon.localtest.me',
    url: '/dp/B07FZ8S74R',
    expect: {
      name: 'Anker USB-C Hub, 7-in-1 Adapter with 4K HDMI',
      brand: 'Anker',
      price: 35.99,
      rating: 4.7,
      reviewCount: 12453,
      currency: 'USD',
    },
  },
  {
    name: 'Acme Mug (no byline, first-word fallback)',
    path: join(__dirname, 'fixtures', 'product', 'acme-mug.html'),
    hostname: 'amazon.localtest.me',
    url: '/dp/B0ACME0001',
    expect: {
      name: 'Acme Mug',
      brand: 'Acme',
      price: 12.99,
      currency: 'USD',
    },
  },
  {
    name: 'The Cool Hat (no byline, "The" skipped)',
    path: join(__dirname, 'fixtures', 'product', 'the-hat.html'),
    hostname: 'amazon.localtest.me',
    url: '/dp/B0HAT00001',
    expect: {
      name: 'The Cool Hat',
      brand: null,
      price: 19.99,
      currency: 'USD',
    },
  },
]

for (const f of FIXTURES) {
  if (!existsSync(f.path)) {
    console.error('Fixture not found:', f.path)
    process.exit(1)
  }
}

const compiled = await build({
  entryPoints: [join(projectRoot, 'lib', 'intercept', 'product.ts')],
  bundle: true,
  format: 'iife',
  globalName: '__whybuyProduct',
  target: 'es2022',
  write: false,
  logLevel: 'silent',
  absWorkingDir: projectRoot,
})

const harnessSource = `
${compiled.outputFiles[0].text}
window.__extractProduct = __whybuyProduct.extractProduct
`

const browser = await puppeteer.launch({
  executablePath: puppeteerChrome,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
  timeout: 30000,
})

let exitCode = 0
try {
  for (const fixture of FIXTURES) {
    console.log(`\n=== ${fixture.name} ===`)
    const html = readFileSync(fixture.path, 'utf8')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const url = `http://${fixture.hostname}:${port}${fixture.url}`

    const page = await browser.newPage()
    page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.evaluate(harnessSource)
      const product = await page.evaluate(() => window.__extractProduct())
      console.log('  Extracted:')
      console.log('  ' + JSON.stringify(product, null, 2).replace(/\n/g, '\n  '))

      const fail = (msg) => {
        console.error('  ✘', msg)
        exitCode = 1
      }
      const pass = (msg) => console.log('  ✔', msg)

      if (product.name === fixture.expect.name) pass(`name === "${fixture.expect.name}"`)
      else fail(`name should be "${fixture.expect.name}", got "${product.name}"`)

      if (product.brand === fixture.expect.brand) pass(`brand === ${JSON.stringify(fixture.expect.brand)}`)
      else fail(`brand should be ${JSON.stringify(fixture.expect.brand)}, got ${JSON.stringify(product.brand)}`)

      if (product.price === fixture.expect.price) pass(`price === ${fixture.expect.price}`)
      else fail(`price should be ${fixture.expect.price}, got ${product.price}`)

      if (product.currency === fixture.expect.currency) pass(`currency === "${fixture.expect.currency}"`)
      else fail(`currency should be "${fixture.expect.currency}", got "${product.currency}"`)

      if ('rating' in fixture.expect) {
        if (product.rating === fixture.expect.rating) pass(`rating === ${fixture.expect.rating}`)
        else fail(`rating should be ${fixture.expect.rating}, got ${product.rating}`)
      }

      if ('reviewCount' in fixture.expect) {
        if (product.reviewCount === fixture.expect.reviewCount) pass(`reviewCount === ${fixture.expect.reviewCount}`)
        else fail(`reviewCount should be ${fixture.expect.reviewCount}, got ${product.reviewCount}`)
      }

      if (product.fingerprint && /^[0-9a-f]+$/.test(product.fingerprint)) pass(`fingerprint is a hex string: ${product.fingerprint}`)
      else fail(`fingerprint should be a hex string, got ${product.fingerprint}`)
    } finally {
      await page.close().catch(() => {})
      server.close()
    }
  }
} catch (err) {
  console.error('\n✘ Product fixture test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  await browser.close().catch(() => {})
}

if (exitCode === 0) console.log('\n✔ Product fixture test passed.')
else console.log('\n✘ Product fixture test FAILED.')
process.exit(exitCode)
