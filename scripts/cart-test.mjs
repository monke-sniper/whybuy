// Cart-display smoke test: navigate to a cart-like page and verify that
// the trial UI extracts and shows the cart contents.

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const puppeteerChrome = 'C:\\Users\\doomj\\.cache\\puppeteer\\chrome\\win64-149.0.7827.22\\chrome-win64\\chrome.exe'
const cartUrl = 'file:///' + join(__dirname, 'cart-page.html').replace(/\\/g, '/')

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-cart-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('cart-test', userDataDir)
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

  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))

  console.log('Navigating to cart page...')
  await page.goto(cartUrl, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 1500))

  // The trial should auto-trigger on the cart page (early checkout step).
  const hostPresent = await page.evaluate(() => !!document.querySelector('[data-whybuy="1"]'))
  if (!hostPresent) throw new Error('Trial did not auto-trigger on cart page')

  await new Promise((r) => setTimeout(r, 3000))
  console.log('✔ Trial auto-triggered on cart page')

  // Wait for the prosecution to start talking.
  let waited = 0
  while (waited < 8000) {
    const text = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return el?.shadowRoot?.querySelector('header')?.textContent ?? ''
    })
    if (text.includes('Cart') || text.includes('3 items')) break
    await new Promise((r) => setTimeout(r, 250))
    waited += 250
  }
  console.log(`  Waited ${waited}ms for cart display`)

  const headerText = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    return el?.shadowRoot?.querySelector('header')?.textContent ?? ''
  })
  console.log('  Header text:', headerText.slice(0, 200))

  // Verify cart info is shown.
  if (!headerText.includes('Cart')) {
    throw new Error('Header does not show "Cart"')
  }
  if (!headerText.includes('3') && !headerText.includes('4')) {
    throw new Error('Header does not show item count')
  }
  if (!headerText.includes('174.97')) {
    throw new Error('Header does not show cart total')
  }
  console.log('✔ Header shows cart label, item count, and total')

  // Wait for the prosecution's first response.
  await new Promise((r) => setTimeout(r, 4000))
  const prosecutionText = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const prosecution = el?.shadowRoot?.querySelectorAll('section')[0]
    return prosecution?.textContent ?? ''
  })
  console.log('  Prosecution text:', prosecutionText.slice(0, 250))
  if (prosecutionText.length < 50) {
    throw new Error('Prosecution did not produce text')
  }
  console.log('✔ Prosecution is talking about the cart')

  await page.screenshot({ path: join(projectRoot, 'screenshot-cart.png') })
  console.log('  Screenshot saved: screenshot-cart.png')

  // Drive 3 rounds of input.
  for (let i = 1; i <= 3; i++) {
    let composerEnabled = false
    waited = 0
    while (waited < 12000) {
      composerEnabled = await page.evaluate(() => {
        const el = document.querySelector('[data-whybuy="1"]')
        const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
        return !!ta && !ta.disabled
      })
      if (composerEnabled) break
      await new Promise((r) => setTimeout(r, 300))
      waited += 300
    }
    if (!composerEnabled) throw new Error(`Composer never enabled for round ${i}`)

    await page.evaluate((args) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
      ta.focus()
      ta.value = `Argument ${args.round}: I need these items for daily work, researched alternatives, and have budget.`
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = el?.shadowRoot?.querySelector('button.whybuy-btn')
      btn.click()
    }, { round: i })
    await new Promise((r) => setTimeout(r, 3500))
  }

  // Wait for verdict.
  await new Promise((r) => setTimeout(r, 5000))

  const finalState = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    const verdict = shadow?.querySelector('.whybuy-verdict-card')
    return {
      hasVerdict: !!verdict,
      hasCartInVerdict: !!(verdict && verdict.textContent.includes('Cart')),
      hasItems: !!shadow?.querySelector('li'),
    }
  })
  console.log('  Verdict state:', finalState)
  if (!finalState.hasVerdict) throw new Error('Verdict did not render')

  await page.screenshot({ path: join(projectRoot, 'screenshot-cart-verdict.png') })
  console.log('  Screenshot saved: screenshot-cart-verdict.png')

  console.log('\n✔ Cart test passed.')
} catch (err) {
  console.error('\n✘ Cart test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
