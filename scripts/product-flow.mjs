// Product fixture flow test.
//
// Loads scripts/fixtures/product/amazon.html (the Anker USB-C Hub)
// in puppeteer with the built extension, clicks the "Proceed to
// checkout" button in the fixture, and captures screenshots showing:
//   - The trial with the product header showing brand + title + price
//   - The AI's response naming the product by brand + title
//   - The verdict
//
// Usage:
//   WHYBUY_OLLAMA_KEY=<key> node scripts/product-flow.mjs
//
// This is the e2e counterpart of scripts/product-fixture-test.mjs
// (which only tests extractProduct() in isolation).

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'
import { assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const fixturePath = join(__dirname, 'fixtures', 'product', 'amazon.html')
const puppeteerChrome = resolveChrome()
const cloudKey = process.env.WHYBUY_OLLAMA_KEY || ''
const cloudModel = process.env.WHYBUY_OLLAMA_MODEL || 'ministral-3:3b'

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}
if (!cloudKey) {
  console.error('Set WHYBUY_OLLAMA_KEY=<your ollama key>.')
  process.exit(1)
}
if (!existsSync(fixturePath)) {
  console.error('Fixture not found:', fixturePath)
  process.exit(1)
}

// Spin up a tiny HTTP server bound to 127.0.0.1, then visit it via
// `product.localtest.me` so the click interceptor + the cart/page
// extractors both work. (The hostname is checked in a few places:
// the content script's load order, any future `looksLikeCartPage`
// checks, etc. We use the `localtest.me` public-DNS trick so the
// browser resolves the hostname to 127.0.0.1.)
const FIXTURE_HTML = readFileSync(fixturePath, 'utf8')
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(FIXTURE_HTML)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const fixtureUrl = `http://amazon.localtest.me:${port}/dp/B07FZ8S74R`
console.log(`Fixture served at: ${fixtureUrl}`)

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-product-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('product-flow', userDataDir)
let exitCode = 0
let browser

try {
  browser = await puppeteer.launch({
    executablePath: puppeteerChrome,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=en-US',
      '--window-size=1280,900',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    timeout: 60000,
  })
  await new Promise((r) => setTimeout(r, 2000))

  const swTarget = browser.targets().find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  )
  if (!swTarget) throw new Error('Service worker not found')
  const sw = await swTarget.worker()
  sw.on('console', (msg) => console.log('  [sw]', msg.text()))
  console.log('Service worker:', swTarget.url())

  await sw.evaluate(async (cfg) => {
    return new Promise((resolve) => {
      chrome.storage.local.set(
        {
          'whybuy.settings.v1': {
            debateLength: 'standard',
            tone: 'firm',
            ignoredSites: [],
            promptDetail: 'minimal',
            judgeMode: 'natural',
            byok: cfg,
          },
        },
        () => resolve(true),
      )
    })
  }, {
    provider: 'ollama-cloud',
    apiKey: cloudKey,
    model: cloudModel,
    judgeModel: process.env.WHYBUY_JUDGE_MODEL || 'ministral-3:8b',
  })
  console.log(`✔ BYOK configured (model=${cloudModel}, judgeModel=${process.env.WHYBUY_JUDGE_MODEL || 'ministral-3:8b'})`)

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('WhyBuy') || t.startsWith('[WhyBuy]')) console.log('  [page]', t)
  })

  console.log(`\nNavigating to ${fixtureUrl} ...`)
  await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1500))

  await page.screenshot({ path: join(projectRoot, 'screenshot-product-1-page.png'), fullPage: false })
  console.log('  📸 screenshot-product-1-page.png')

  // Click "Proceed to checkout" via direct DOM dispatch.
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
    for (const el of all) {
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim()
      if (!/proceed\s*to\s*checkout/i.test(text)) continue
      el.scrollIntoView({ block: 'center' })
      el.click()
      return text
    }
    return null
  })
  if (!clicked) throw new Error('Could not click Proceed to checkout')
  console.log(`  ✔ Clicked "${clicked}"`)

  // Wait for the trial to mount.
  let mounted = false
  let waited = 0
  while (waited < 15000) {
    mounted = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return !!el && !!el.shadowRoot?.querySelector('#whybuy-trial-root')
    })
    if (mounted) break
    await new Promise((r) => setTimeout(r, 250))
    waited += 250
  }
  if (!mounted) throw new Error('Trial did not mount on fixture product after click')
  console.log(`  ✔ Trial mounted (waited ${waited}ms)`)
  await new Promise((r) => setTimeout(r, 2500))

  // Capture the trial header — should show "Anker" + "USB-C Hub, 7-in-1
  // Adapter with 4K HDMI" + price + rating.
  await page.screenshot({ path: join(projectRoot, 'screenshot-product-2-trial.png'), fullPage: false })
  console.log('  📸 screenshot-product-2-trial.png (product header with brand + title)')

  // Verify the trial header text shows the brand.
  const headerText = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const root = el?.shadowRoot
    return root?.querySelector('.whybuy-wood')?.textContent || ''
  })
  console.log('  Header text:', headerText.replace(/\s+/g, ' ').trim().slice(0, 200))
  if (!/Anker/.test(headerText)) {
    console.error('  ✘ Header does not show "Anker" brand')
    exitCode = 1
  } else {
    console.log('  ✔ Header shows "Anker" brand')
  }
  if (!/USB-C Hub/.test(headerText)) {
    console.error('  ✘ Header does not show product title')
    exitCode = 1
  } else {
    console.log('  ✔ Header shows product title "USB-C Hub"')
  }

  // Drive 3 rounds.
  console.log('\nDriving 3 rounds of debate...')
  for (let i = 1; i <= 3; i++) {
    let enabled = false
    waited = 0
    while (waited < 60000) {
      enabled = await page.evaluate(() => {
        const el = document.querySelector('[data-whybuy="1"]')
        const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
        return ta && !ta.disabled
      })
      if (enabled) break
      await new Promise((r) => setTimeout(r, 250))
      waited += 250
    }
    if (!enabled) throw new Error(`Composer never enabled for round ${i}`)
    console.log(`  Composer enabled for round ${i} (waited ${waited}ms)`)

    await page.evaluate((roundIdx) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
        setter.call(ta, `Round ${roundIdx} reason: I need this for daily work.`)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, i)
    await new Promise((r) => setTimeout(r, 100))
    await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const btns = Array.from(el?.shadowRoot?.querySelectorAll('button.whybuy-btn') ?? [])
      const submit = btns.find((b) => /submit/i.test(b.textContent || '') && !b.disabled)
      submit?.click()
    })
    console.log(`  ✔ Round ${i} submitted`)

    if (i === 3) {
      let prosecutionDone = false
      waited = 0
      while (waited < 60000) {
        prosecutionDone = await page.evaluate(() => {
          const el = document.querySelector('[data-whybuy="1"]')
          const root = el?.shadowRoot
          if (!root) return false
          return !!root.querySelector('.whybuy-judge-room')
        })
        if (prosecutionDone) break
        await new Promise((r) => setTimeout(r, 250))
        waited += 250
      }
      if (!prosecutionDone) throw new Error('JudgeRoom did not appear after round 3')
      console.log(`  ✔ JudgeRoom mounted (waited ${waited}ms)`)
    }
  }

  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: join(projectRoot, 'screenshot-product-3-rounds.png'), fullPage: false })
  console.log('  📸 screenshot-product-3-rounds.png (debate in progress)')

  // Wait for the verdict to reveal.
  let verdictRevealed = false
  waited = 0
  while (waited < 90000) {
    verdictRevealed = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
      return room?.classList?.contains('revealed') ||
        !!room?.querySelector('.whybuy-reveal-line h1')
    })
    if (verdictRevealed) break
    await new Promise((r) => setTimeout(r, 250))
    waited += 250
  }
  if (!verdictRevealed) throw new Error('Verdict did not reveal')
  console.log(`  ✔ Verdict revealed (waited ${waited}ms)`)
  await new Promise((r) => setTimeout(r, 1500))

  const verdict = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    return {
      title: room?.querySelector('.whybuy-reveal-line h1')?.textContent,
      summary: room?.querySelectorAll('.whybuy-reveal-line p')?.[0]?.textContent,
      buttons: Array.from(room?.querySelectorAll('button') ?? []).map((b) => b.textContent.trim()),
    }
  })
  console.log('  Verdict:', verdict.title, '|', verdict.summary?.slice(0, 200))
  console.log('  Buttons:', verdict.buttons)

  // The summary should name the product by brand or title.
  if (verdict.summary && /Anker|USB-C Hub/i.test(verdict.summary)) {
    console.log('  ✔ Verdict summary names the product by brand or title')
  } else {
    console.error('  ✘ Verdict summary does not name the product:', verdict.summary?.slice(0, 200))
    exitCode = 1
  }

  await page.screenshot({ path: join(projectRoot, 'screenshot-product-4-verdict.png'), fullPage: false })
  console.log('  📸 screenshot-product-4-verdict.png')

  console.log('\n✔ Product fixture flow complete. Screenshots:')
  console.log('   - screenshot-product-1-page.png  (raw product page)')
  console.log('   - screenshot-product-2-trial.png (trial with brand+title header)')
  console.log('   - screenshot-product-3-rounds.png (debate in progress)')
  console.log('   - screenshot-product-4-verdict.png (verdict)')
} catch (err) {
  console.error('\n✘ Product fixture flow failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
  server.close()
}

process.exit(exitCode)
