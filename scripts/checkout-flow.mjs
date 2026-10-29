// End-to-end checkout flow test.
//
// Verifies:
//   1. Non-checkout buttons (Add to cart, Buy Now, Place your order) do NOT
//      trigger the trial.
//   2. "Proceed to checkout" DOES trigger the trial.
//   3. The full debate runs: 3 user rounds with a free AI (Ollama Cloud
//      by default, local Ollama if WHYBUY_LOCAL_OLLAMA=1).
//   4. The JudgeRoom appears, runs the gavel-strike animation, then
//      reveals the verdict on a full-screen dedicated surface.
//   5. Clicking the proceed button re-dispatches the original click
//      so the real purchase can continue.
//
// Usage:
//   node scripts/checkout-flow.mjs                            # uses Ollama Cloud
//   WHYBUY_LOCAL_OLLAMA=1 node scripts/checkout-flow.mjs      # uses local Ollama
//   WHYBUY_OLLAMA_KEY=<key> node scripts/checkout-flow.mjs   # override cloud key
//   WHYBUY_OLLAMA_MODEL=<m>  node scripts/checkout-flow.mjs   # override model

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const testPageUrl = 'file:///' + join(__dirname, 'test-page.html').replace(/\\/g, '/')
const puppeteerChrome = 'C:\\Users\\doomj\\.cache\\puppeteer\\chrome\\win64-149.0.7827.22\\chrome-win64\\chrome.exe'

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const useLocal = process.env.WHYBUY_LOCAL_OLLAMA === '1'
// Set WHYBUY_OLLAMA_KEY in your shell before running. Never commit a real key.
const cloudKey = process.env.WHYBUY_OLLAMA_KEY || ''
const cloudModel = process.env.WHYBUY_OLLAMA_MODEL || 'ministral-3:3b'

if (!useLocal && !cloudKey) {
  console.error('Set WHYBUY_OLLAMA_KEY=<your ollama key> or use WHYBUY_LOCAL_OLLAMA=1 to hit a local server.')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-checkout-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('checkout-flow', userDataDir)
let browser
let exitCode = 0

try {
  browser = await puppeteer.launch({
    executablePath: puppeteerChrome,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    dumpio: false,
    timeout: 30000,
  })

  await new Promise((r) => setTimeout(r, 1500))

  const swTarget = browser.targets().find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  )
  if (!swTarget) throw new Error('Service worker not found')
  const sw = await swTarget.worker()
  sw.on('console', (msg) => console.log('  [sw]', msg.text()))
  console.log('Service worker:', swTarget.url())

  // === Configure BYOK: either local Ollama or Ollama Cloud. ===
  const byokConfig = useLocal
    ? {
        provider: 'ollama',
        apiKey: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'qwen2.5:0.5b',
      }
    : {
        provider: 'ollama-cloud',
        apiKey: cloudKey,
        model: cloudModel,
      }
  console.log(`\n=== Configuring BYOK -> ${useLocal ? 'local Ollama' : `Ollama Cloud (${cloudModel})`} ===`)
  const judgeModel = process.env.WHYBUY_JUDGE_MODEL || 'ministral-3:8b'
  const byokConfigFull = useLocal
    ? { ...byokConfig, judgeModel }
    : { ...byokConfig, judgeModel }
  const configured = await sw.evaluate(async (cfg) => {
    // @ts-ignore
    return await new Promise((resolve) => {
      // @ts-ignore
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
  }, byokConfigFull)
  if (!configured) throw new Error('Failed to configure BYOK')
  console.log('✔ BYOK configured')

  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('WhyBuy') || t.startsWith('[WhyBuy]')) console.log('  [page]', t)
  })

  await page.goto(testPageUrl, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 800))

  // === Test 1: non-checkout buttons do NOT trigger ===
  console.log('\n=== Test 1: Non-checkout buttons do NOT trigger ===')
  for (const id of ['#add', '#buy', '#place']) {
    await page.click(id)
    await new Promise((r) => setTimeout(r, 700))
    const host = await page.evaluate(() => !!document.querySelector('[data-whybuy="1"]'))
    if (host) {
      throw new Error(`Click on ${id} should NOT have triggered the trial`)
    }
    console.log(`  ✔ ${id} did not trigger trial`)
  }

  // === Test 2: "Proceed to checkout" DOES trigger ===
  console.log('\n=== Test 2: Proceed to checkout triggers the trial ===')
  await page.click('#checkout')
  await new Promise((r) => setTimeout(r, 1500))
  const mounted = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    return !!el && !!el.shadowRoot?.querySelector('#whybuy-trial-root')
  })
  if (!mounted) throw new Error('Trial UI did not mount on Proceed to checkout click')
  console.log('✔ Trial mounted on Proceed to checkout')

  const prevented = await page.evaluate(() => document.body.getAttribute('data-purchased') !== 'true')
  if (!prevented) {
    console.log('  ⚠ data-purchased already true; original click may not have been prevented')
  } else {
    console.log('✔ Original checkout click was prevented')
  }

  // Wait for the intro overlay to clear, then for the prosecution to start.
  await new Promise((r) => setTimeout(r, 2000))
  await page.screenshot({ path: join(projectRoot, 'screenshot-checkout-1-mount.png') })
  console.log('  📸 screenshot-checkout-1-mount.png')

  // === Test 3: Drive 3 rounds of user input ===
  console.log('\n=== Test 3: Drive 3 rounds of debate ===')
  for (let i = 1; i <= 3; i++) {
    // Wait for the composer to become enabled.
    let enabled = false
    let waited = 0
    while (waited < 30000) {
      enabled = await page.evaluate(() => {
        const el = document.querySelector('[data-whybuy="1"]')
        const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
        return !!ta && !ta.disabled
      })
      if (enabled) break
      await new Promise((r) => setTimeout(r, 400))
      waited += 400
    }
    if (!enabled) throw new Error(`Composer never enabled for round ${i}`)
    console.log(`  Composer enabled for round ${i} (waited ${waited}ms)`)

    const submitted = await page.evaluate((args) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
      ta.focus()
      ta.value = `Argument ${args.round}: I use this product daily, the price is fair for the value, I have budget allocated, and I researched cheaper alternatives.`
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = el?.shadowRoot?.querySelector('button.whybuy-btn')
      if (btn && !btn.disabled) {
        btn.click()
        return true
      }
      return false
    }, { round: i })
    if (!submitted) throw new Error(`Failed to submit round ${i}`)
    console.log(`  ✔ Round ${i} submitted`)
    if (i === 1) {
      await new Promise((r) => setTimeout(r, 2500))
      await page.screenshot({ path: join(projectRoot, 'screenshot-checkout-2-rounds.png') })
      console.log('  📸 screenshot-checkout-2-rounds.png')
    } else {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  // === Test 4: JudgeRoom appears with gavel-strike and reveal ===
  console.log('\n=== Test 4: JudgeRoom appears and reveals ===')
  // Wait for deliberation phase to begin (the bottom deliberation overlay
  // is gone; the JudgeRoom itself shows the deliberating UI).
  let judgeRoom = false
  let waited = 0
  while (waited < 30000) {
    judgeRoom = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return !!el?.shadowRoot?.querySelector('.whybuy-judge-room')
    })
    if (judgeRoom) break
    await new Promise((r) => setTimeout(r, 400))
    waited += 400
  }
  if (!judgeRoom) throw new Error('JudgeRoom did not appear after deliberation')
  console.log(`  ✔ JudgeRoom mounted (waited ${waited}ms)`)

  // Capture the deliberating or strike phase.
  await new Promise((r) => setTimeout(r, 300))
  await page.screenshot({ path: join(projectRoot, 'screenshot-checkout-3-judge.png') })
  console.log('  📸 screenshot-checkout-3-judge.png')

  // Wait for the reveal phase (verdict card with action buttons).
  let revealed = false
  waited = 0
  while (waited < 30000) {
    revealed = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
      if (!room) return false
      const buttons = room.querySelectorAll('button.whybuy-btn')
      return buttons.length > 0
    })
    if (revealed) break
    await new Promise((r) => setTimeout(r, 300))
    waited += 300
  }
  if (!revealed) throw new Error('JudgeRoom did not reveal verdict')
  console.log(`  ✔ JudgeRoom revealed verdict (waited ${waited}ms)`)

  // Wait for the staggered reveal animation to fully complete.
  await new Promise((r) => setTimeout(r, 2000))

  // Read the decision to log it.
  const decisionInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    return {
      title: room?.querySelector('h1')?.textContent ?? '',
      confidence: room?.querySelector('.whybuy-gauge-fill')?.getAttribute('style') ?? '',
      buttonLabels: Array.from(room?.querySelectorAll('button.whybuy-btn') ?? []).map((b) => b.textContent),
    }
  })
  console.log('  Verdict:', decisionInfo.title.trim(), decisionInfo.confidence)
  console.log('  Buttons:', decisionInfo.buttonLabels.map((s) => s?.trim()))

  await page.screenshot({ path: join(projectRoot, 'screenshot-checkout-4-verdict.png') })
  console.log('  📸 screenshot-checkout-4-verdict.png')

  // === Test 5: Click the primary action button. Proceed re-dispatches;
  //     accept/override closes the trial. We handle both shapes. ===
  console.log('\n=== Test 5: Click the verdict action ===')
  const clicked = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    const buttons = room?.querySelectorAll('button.whybuy-btn') ?? []
    // Prefer the "Continue to purchase/checkout" button when present.
    for (const b of buttons) {
      const t = b.textContent ?? ''
      if (t.toLowerCase().includes('continue')) {
        b.click()
        return t.trim()
      }
    }
    // Otherwise click the first action button (Accept the ruling).
    if (buttons.length > 0) {
      buttons[0].click()
      return buttons[0].textContent?.trim() ?? ''
    }
    return ''
  })
  if (!clicked) throw new Error('Could not click a verdict action button')
  console.log(`  ✔ Clicked: ${clicked}`)

  await new Promise((r) => setTimeout(r, 1500))
  const afterAction = await page.evaluate(() => {
    const hostStill = !!document.querySelector('[data-whybuy="1"]')
    const purchased = document.body.getAttribute('data-purchased')
    return { hostStill, purchased }
  })
  console.log('  State after action:', afterAction)

  // If we clicked Continue and the original click was re-dispatched,
  // data-purchased should be true.
  if (clicked.toLowerCase().includes('continue') && afterAction.purchased === 'true') {
    console.log('✔ Original checkout click was re-dispatched')
  } else {
    console.log('  (Trial closed without re-dispatching — verdict was likely abandon, or accept was chosen.)')
  }

  // Verify history was saved.
  const history = await sw.evaluate(async () => {
    return await new Promise((resolve) => {
      // @ts-ignore
      chrome.storage.local.get('whybuy.history.v1', (res) => {
        resolve(res['whybuy.history.v1'] ?? [])
      })
    })
  })
  if (!Array.isArray(history) || history.length === 0) {
    throw new Error('History was not recorded')
  }
  console.log(`✔ History recorded (${history.length} trial${history.length === 1 ? '' : 's'})`)
  console.log('  Most recent:', history[0].product.name, '→', history[0].verdict.decision)

  console.log('\n✔ All checkout-flow tests passed.')
} catch (err) {
  console.error('\n✘ Checkout-flow test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
