// Cart fixture flow test.
//
// Loads scripts/fixtures/cart/amazon.html in puppeteer with the built
// extension, clicks the "Proceed to checkout" button in the fixture,
// and captures screenshots showing:
//   - The new rich product cards (brand, rating, prime, was-price, etc.)
//   - The judge's reasoning panel (live streaming)
//   - The verdict card
//   - The after-removal scenario: hide one item, click again, verify
//     the trial shows 1 item (not 2).
//
// Usage:
//   WHYBUY_OLLAMA_KEY=<key> node scripts/cart-flow.mjs
//
// Set WHYBUY_RUN_REMOVAL_TEST=1 to also run the removal scenario (it
// needs a second page load and adds ~10s).
//
// This complements scripts/cart-fixture-test.mjs (which only tests the
// pure extractor logic) and scripts/amazon-flow.mjs (which tests against
// real Amazon pages where the cart is often empty for unauthenticated
// sessions).

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
const fixturePath = join(__dirname, 'fixtures', 'cart', 'amazon.html')
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

// Spin up a tiny HTTP server so the extension's content script can
// inject into a real http(s) origin (it can't run on file:// URLs).
// We bind to 127.0.0.1 and use `amazon.localtest.me` as the public
// hostname — `localtest.me` is a public DNS service that always
// resolves to 127.0.0.1, and the `amazon.` prefix makes the cart
// extractor's hostname dispatch fire (`/amazon\./i`).
const FIXTURE_HTML = readFileSync(fixturePath, 'utf8')
const server = createServer((req, res) => {
  if (req.url === '/' || req.url === '/gp/cart' || req.url === '/cart') {
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
const fixtureUrl = `http://amazon.localtest.me:${port}/gp/cart`
console.log(`Fixture served at: ${fixtureUrl}`)

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-cart-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('cart-flow', userDataDir)
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

  // Configure BYOK to ollama-cloud. We also configure a judge model so
  // we can verify the new judge streaming path.
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

  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-1-page.png'), fullPage: false })
  console.log('  📸 screenshot-cart-1-page.png')

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
  if (!mounted) throw new Error('Trial did not mount on fixture cart after click')
  console.log(`  ✔ Trial mounted (waited ${waited}ms)`)
  await new Promise((r) => setTimeout(r, 2500))

  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-2-trial.png'), fullPage: false })
  console.log('  📸 screenshot-cart-2-trial.png (rich product cards visible)')

  // Drive 3 rounds (standard length) so we reach the deliberation phase.
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
        setter.call(ta, `My reason for round ${roundIdx} is that I need this for daily work and the brand is well-known.`)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }
    }, i)
    // Let React's onInput fire and the Submit button become enabled.
    await new Promise((r) => setTimeout(r, 100))
    await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      // The Submit button is the only enabled `.whybuy-btn` in the composer
      // when the trial is in a user_turn phase. Find by adjacent text.
      const btns = Array.from(el?.shadowRoot?.querySelectorAll('button.whybuy-btn') ?? [])
      const submit = btns.find((b) => /submit/i.test(b.textContent || '') && !b.disabled)
      submit?.click()
    })
    console.log(`  ✔ Round ${i} submitted`)

    // After round 3, wait for the prosecution closing (prosecution_3) to
    // finish before moving on; that's what triggers the deliberation
    // phase and the JudgeRoom mount.
    if (i === 3) {
      let prosecutionDone = false
      waited = 0
      while (waited < 60000) {
        prosecutionDone = await page.evaluate(() => {
          const el = document.querySelector('[data-whybuy="1"]')
          const root = el?.shadowRoot
          if (!root) return false
          // The "Speak" button on the bench is gone when AI is done; or
          // the composer is no longer there (user_3 was the last turn).
          // Simpler: wait for the JudgeRoom class to appear.
          return !!root.querySelector('.whybuy-judge-room')
        })
        if (prosecutionDone) break
        await new Promise((r) => setTimeout(r, 250))
        waited += 250
      }
      if (!prosecutionDone) throw new Error('Prosecution closing + JudgeRoom did not appear after round 3')
      console.log(`  ✔ Prosecution closing + JudgeRoom mounted (waited ${waited}ms)`)
    }
  }

  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-3-rounds.png'), fullPage: false })
  console.log('  📸 screenshot-cart-3-rounds.png (debate in progress)')

  // Wait for the JudgeRoom to appear.
  let inJudgeRoom = false
  waited = 0
  while (waited < 90000) {
    inJudgeRoom = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return !!el?.shadowRoot?.querySelector('.whybuy-judge-room')
    })
    if (inJudgeRoom) break
    await new Promise((r) => setTimeout(r, 250))
    waited += 250
  }
  if (!inJudgeRoom) throw new Error('JudgeRoom did not mount')
  console.log(`  ✔ JudgeRoom mounted (waited ${waited}ms)`)

  // Capture the deliberation screen with the reasoning panel.
  await new Promise((r) => setTimeout(r, 1500))
  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-4-judge.png'), fullPage: false })
  console.log('  📸 screenshot-cart-4-judge.png (deliberation screen with reasoning panel)')

  // Capture the ALL RISE moment (briefly, ~0.6s into the rise phase).
  // We poll the page for the .all-rise class on the judge room.
  let capturedAllRise = false
  const start = Date.now()
  while (Date.now() - start < 60000) {
    const isRising = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
      return !!room?.classList?.contains('all-rise')
    })
    if (isRising) {
      await new Promise((r) => setTimeout(r, 500))
      await page.screenshot({ path: join(projectRoot, 'screenshot-cart-4b-allrise.png'), fullPage: false })
      console.log('  📸 screenshot-cart-4b-allrise.png (ALL RISE banner + bench rising)')
      capturedAllRise = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!capturedAllRise) console.log('  (ALL RISE phase was too brief to capture, skipping)')

  // Wait for the verdict to reveal.
  let verdictRevealed = false
  waited = 0
  while (waited < 60000) {
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

  // Read the verdict text for the test log.
  const verdict = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    return {
      title: room?.querySelector('.whybuy-reveal-line h1')?.textContent,
      summary: room?.querySelectorAll('.whybuy-reveal-line p')?.[0]?.textContent,
      buttons: Array.from(room?.querySelectorAll('button') ?? []).map((b) => b.textContent.trim()),
    }
  })
  console.log('  Verdict:', verdict.title, '|', verdict.summary?.slice(0, 120))
  console.log('  Buttons:', verdict.buttons)

  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-5-verdict.png'), fullPage: false })
  console.log('  📸 screenshot-cart-5-verdict.png (verdict with product cards + reasoning)')

  // === Removal scenario (gated) ===
  // After clicking "Proceed to checkout", close the trial, simulate
  // removing an item from the cart, click "Proceed to checkout"
  // again, and verify the trial now shows 1 item (not 2).
  if (process.env.WHYBUY_RUN_REMOVAL_TEST === '1') {
    console.log('\n=== Removal scenario ===')
    // Close the current trial (verdict screen).
    await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const root = el?.shadowRoot
      const closeBtn = Array.from(root?.querySelectorAll('button') ?? []).find((b) =>
        /end trial/i.test(b.textContent || ''),
      )
      closeBtn?.click()
    })
    await new Promise((r) => setTimeout(r, 1000))

    // Reload the fixture and then hide one of the two real items
    // before clicking "Proceed to checkout".
    console.log(`  Reloading ${fixtureUrl} ...`)
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await new Promise((r) => setTimeout(r, 1000))

    // Hide the Anker row (1st real item).
    const hidden = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#activeCartViewForm [data-asin]'))
      const anker = rows.find((el) => el.getAttribute('data-asin') === 'B07FZ8S74R')
      if (!anker) return false
      anker.style.display = 'none'
      anker.classList.add('sc-list-item-removed')
      return true
    })
    if (!hidden) throw new Error('Could not find Anker row to hide')
    console.log('  ✔ Hid the Anker row (display:none + sc-list-item-removed)')
    await new Promise((r) => setTimeout(r, 250))

    // Click "Proceed to checkout" again.
    const clicked2 = await page.evaluate(() => {
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
    if (!clicked2) throw new Error('Could not click Proceed to checkout (2nd time)')
    console.log(`  ✔ Clicked "${clicked2}"`)

    // Wait for the new trial to mount.
    let mounted2 = false
    waited = 0
    while (waited < 15000) {
      mounted2 = await page.evaluate(() => {
        const el = document.querySelector('[data-whybuy="1"]')
        const root = el?.shadowRoot
        if (!root) return false
        return !!root.querySelector('.whybuy-wood')
      })
      if (mounted2) break
      await new Promise((r) => setTimeout(r, 250))
      waited += 250
    }
    if (!mounted2) throw new Error('Trial did not mount after removal')
    await new Promise((r) => setTimeout(r, 2000))

    // The trial header should say "1 item" (the Logitech mouse).
    const subText = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const root = el?.shadowRoot
      return root?.querySelector('.whybuy-wood')?.textContent || ''
    })
    const cleaned = subText.replace(/\s+/g, ' ')
    if (/1 item/.test(cleaned) && !/2 items/.test(cleaned)) {
      console.log('  ✔ Header shows "1 item" (Anker correctly excluded)')
    } else {
      console.error('  ✘ Header does not show 1 item:', cleaned.slice(0, 200))
      exitCode = 1
    }
    if (!/Anker/.test(cleaned)) {
      console.log('  ✔ Hidden Anker item is NOT in the trial')
    } else {
      console.error('  ✘ Hidden Anker item still in the trial')
      exitCode = 1
    }
    if (/Logitech/.test(cleaned)) {
      console.log('  ✔ Visible Logitech item IS in the trial')
    } else {
      console.error('  ✘ Visible Logitech item missing from the trial')
      exitCode = 1
    }

    await page.screenshot({ path: join(projectRoot, 'screenshot-cart-6-after-remove.png'), fullPage: false })
    console.log('  📸 screenshot-cart-6-after-remove.png (1 item, Anker removed)')
  } else {
    console.log('  (skipping removal scenario; set WHYBUY_RUN_REMOVAL_TEST=1 to enable)')
  }

  console.log('\n✔ Cart fixture flow complete. Screenshots:')
  console.log('   - screenshot-cart-1-page.png  (raw fixture)')
  console.log('   - screenshot-cart-2-trial.png (trial with rich product cards)')
  console.log('   - screenshot-cart-3-rounds.png (debate in progress)')
  console.log('   - screenshot-cart-4-judge.png (judge reasoning streaming)')
  console.log('   - screenshot-cart-5-verdict.png (verdict with products + reasoning)')
} catch (err) {
  console.error('\n✘ Cart fixture flow failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
  server.close()
}

process.exit(exitCode)
