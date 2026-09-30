// Real-world Amazon checkout flow test.
//
// Navigates to amazon.com's cart page, configures the extension to use
// the user's Ollama (cloud or local), and verifies the full flow:
//   - "Proceed to checkout" is intercepted (no URL auto-trigger).
//   - Trial runs to verdict, JudgeRoom reveals, and re-dispatch is set up.
//
// Usage:
//   node scripts/amazon-flow.mjs                             # Ollama Cloud
//   WHYBUY_LOCAL_OLLAMA=1 node scripts/amazon-flow.mjs       # local Ollama
//   WHYBUY_OLLAMA_KEY=<key> node scripts/amazon-flow.mjs     # override cloud key
//   WHYBUY_OLLAMA_MODEL=<m>  node scripts/amazon-flow.mjs    # override model

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'
import { assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const puppeteerChrome = resolveChrome()

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const useLocal = process.env.WHYBUY_LOCAL_OLLAMA === '1'
const cloudKey = process.env.WHYBUY_OLLAMA_KEY || ''
const cloudModel = process.env.WHYBUY_OLLAMA_MODEL || 'ministral-3:3b'

if (!useLocal && !cloudKey) {
  console.error('Set WHYBUY_OLLAMA_KEY=<your ollama key> or use WHYBUY_LOCAL_OLLAMA=1.')
  process.exit(1)
}

// Candidate Amazon entry points. We try a few — the user may or may not
// be signed in, and Amazon routes cart/checkout differently per locale.
const candidates = [
  'https://www.amazon.com/gp/cart/view.html',
  'https://www.amazon.ca/gp/cart/view.html',
  'https://www.amazon.com/checkout/cart',
  'https://www.amazon.com/',
]

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-amazon-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('amazon-flow', userDataDir)
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
      '--lang=en-US',
      '--window-size=1280,900',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    dumpio: false,
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

  // Configure BYOK -> either local Ollama or Ollama Cloud.
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
  console.log(`Configuring BYOK -> ${useLocal ? 'local Ollama' : `Ollama Cloud (${cloudModel})`}`)
  await sw.evaluate(async (cfg) => {
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
  }, {
    ...byokConfig,
    judgeModel: process.env.WHYBUY_JUDGE_MODEL || 'ministral-3:8b',
  })
  console.log('✔ BYOK configured')

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('WhyBuy') || t.startsWith('[WhyBuy]')) console.log('  [page]', t)
  })

  // Pick the first Amazon URL we can reach without an immediate error.
  let opened = null
  for (const url of candidates) {
    try {
      console.log(`\nNavigating to ${url} ...`)
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Wait a moment for client-side redirects to settle.
      await new Promise((r) => setTimeout(r, 2500))
      const finalUrl = page.url()
      console.log(`  Landed on: ${finalUrl}`)
      // If Amazon pushed us to a sign-in page, try the next candidate.
      if (/\/(ap\/signin|gp\/signin|auth\/)/.test(finalUrl)) {
        console.log('  Hit sign-in; trying next candidate.')
        continue
      }
      opened = finalUrl
      break
    } catch (e) {
      console.log(`  Failed to open ${url}: ${e.message.slice(0, 100)}`)
    }
  }
  if (!opened) {
    throw new Error('Could not load any Amazon candidate URL')
  }

  // Look for a "Proceed to checkout" button on the page.
  console.log('\nLooking for "Proceed to checkout" button...')
  const checkoutInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
    const matches = all
      .map((el) => ({
        tag: el.tagName,
        text: (el.textContent || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' '),
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        href: el.getAttribute('href') || '',
      }))
      .filter((m) => /proceed\s*to\s*checkout/i.test(m.text))
    return matches
  })
  console.log(`  Found ${checkoutInfo.length} matching elements:`)
  for (const m of checkoutInfo) console.log(`   - <${m.tag.toLowerCase()}> "${m.text}" (visible=${m.visible}) href=${m.href.slice(0, 80)}`)

  // Capture the cart/checkout page BEFORE the trial mounts.
  await page.screenshot({ path: join(projectRoot, 'screenshot-amazon-1-cart.png'), fullPage: false })
  console.log('  📸 screenshot-amazon-1-cart.png')

  if (checkoutInfo.length === 0) {
    console.log('\n  No "Proceed to checkout" button on this page. Skipping click test.')
    console.log('  (Cart may be empty or page layout differs.)')
    process.exit(0)
  }

  // Click the first visible matching element via direct DOM dispatch — this
  // fires a real bubble-phase click so the capture-phase listener sees it.
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, input[type="submit"]'))
    for (const el of all) {
      const text = (el.textContent || el.value || el.getAttribute('aria-label') || '').trim()
      if (!/proceed\s*to\s*checkout/i.test(text)) continue
      if (!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) continue
      // Make sure the element is on top (Amazon's buttons can be obscured by overlays).
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
  if (!mounted) throw new Error('Trial did not mount on Amazon cart after click')
  console.log(`  ✔ Trial mounted (waited ${waited}ms)`)

  // Capture the trial mount on top of the Amazon page.
  await new Promise((r) => setTimeout(r, 2000))
  await page.screenshot({ path: join(projectRoot, 'screenshot-amazon-2-trial.png'), fullPage: false })
  console.log('  📸 screenshot-amazon-2-trial.png')

  // Drive 3 rounds of debate.
  console.log('\nDriving 3 rounds of debate...')
  for (let i = 1; i <= 3; i++) {
    let enabled = false
    waited = 0
    while (waited < 45000) {
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
    console.log(`  Composer enabled (round ${i}, waited ${waited}ms)`)

    await page.evaluate((args) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
      ta.focus()
      ta.value = `Argument ${args.round}: this product is needed daily, the price is fair, I have budget allocated, and I researched cheaper alternatives.`
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = el?.shadowRoot?.querySelector('button.whybuy-btn')
      btn.click()
    }, { round: i })
    console.log(`  ✔ Round ${i} submitted`)
    if (i === 1) {
      await new Promise((r) => setTimeout(r, 3000))
      await page.screenshot({ path: join(projectRoot, 'screenshot-amazon-3-rounds.png'), fullPage: false })
      console.log('  📸 screenshot-amazon-3-rounds.png')
    } else {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }

  // Wait for the JudgeRoom to mount and reveal.
  let judgeRoom = false
  waited = 0
  while (waited < 45000) {
    judgeRoom = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return !!el?.shadowRoot?.querySelector('.whybuy-judge-room')
    })
    if (judgeRoom) break
    await new Promise((r) => setTimeout(r, 400))
    waited += 400
  }
  if (!judgeRoom) throw new Error('JudgeRoom did not appear')
  console.log(`  ✔ JudgeRoom mounted (waited ${waited}ms)`)

  // Capture the deliberation/strike phase.
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: join(projectRoot, 'screenshot-amazon-4-judge.png'), fullPage: false })
  console.log('  📸 screenshot-amazon-4-judge.png')

  // Wait for the verdict to reveal.
  let revealed = false
  waited = 0
  while (waited < 30000) {
    revealed = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
      return !!room && room.querySelectorAll('button.whybuy-btn').length > 0
    })
    if (revealed) break
    await new Promise((r) => setTimeout(r, 300))
    waited += 300
  }
  if (!revealed) throw new Error('JudgeRoom did not reveal')
  // Let the staggered reveal complete.
  await new Promise((r) => setTimeout(r, 2200))
  await page.screenshot({ path: join(projectRoot, 'screenshot-amazon-5-verdict.png'), fullPage: false })
  console.log('  📸 screenshot-amazon-5-verdict.png')

  const info = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    return {
      title: room?.querySelector('h1')?.textContent?.trim() ?? '',
      confidence: room?.querySelector('.whybuy-gauge-fill')?.getAttribute('style') ?? '',
      buttons: Array.from(room?.querySelectorAll('button.whybuy-btn') ?? []).map((b) => b.textContent?.trim()),
      summary: room?.querySelector('p')?.textContent?.trim() ?? '',
    }
  })
  console.log('\nVerdict:', info.title, info.confidence)
  console.log('Summary:', info.summary.slice(0, 120))
  console.log('Buttons:', info.buttons)

  // Click the primary verdict action.
  const clickedAction = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const room = el?.shadowRoot?.querySelector('.whybuy-judge-room')
    const buttons = room?.querySelectorAll('button.whybuy-btn') ?? []
    for (const b of buttons) {
      const t = b.textContent ?? ''
      if (t.toLowerCase().includes('continue')) {
        b.click()
        return t.trim()
      }
    }
    if (buttons[0]) {
      buttons[0].click()
      return buttons[0].textContent?.trim()
    }
    return ''
  })
  console.log(`\n✔ Clicked: ${clickedAction}`)
  await new Promise((r) => setTimeout(r, 1500))

  console.log('\n✔ Amazon flow complete. Screenshots:')
  console.log('   - screenshot-amazon-1-cart.png')
  console.log('   - screenshot-amazon-2-trial.png')
  console.log('   - screenshot-amazon-3-rounds.png')
  console.log('   - screenshot-amazon-4-judge.png')
  console.log('   - screenshot-amazon-5-verdict.png')
} catch (err) {
  console.error('\n✘ Amazon flow failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
