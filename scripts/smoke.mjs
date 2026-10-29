// Smoke test: load the extension into a real Chrome instance and verify
// the purchase interceptor fires when a "Buy Now" button is clicked.
//
// Usage: node scripts/smoke.mjs

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-test-'))
const puppeteerChrome = 'C:\\Users\\doomj\\.cache\\puppeteer\\chrome\\win64-149.0.7827.22\\chrome-win64\\chrome.exe'
const fileUrl = 'file:///' + join(__dirname, 'test-page.html').replace(/\\/g, '/')

console.log('Launching Chrome with extension from', extensionPath)
console.log('Test page URL:', fileUrl)

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

  console.log('Browser launched.')

  // === Test 1: Content script + trial flow ===
  console.log('\n=== Test 1: Trial flow with proceed verdict ===')

  // Wait for the extension's service worker to register.
  await new Promise((r) => setTimeout(r, 1500))

  const swTarget = browser.targets().find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  )
  if (!swTarget) throw new Error('Service worker not found')
  const sw = await swTarget.worker()
  console.log('Service worker:', swTarget.url())

  // Open the test page.
  const page = await browser.newPage()
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('WhyBuy') || text.startsWith('[WhyBuy]')) {
      console.log('  [page]', text)
    }
  })
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  sw.on('console', (msg) => console.log('  [sw]', msg.text()))

  await page.goto(fileUrl, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 1500))

  await page.click('#buy')
  await new Promise((r) => setTimeout(r, 2000))

  // Verify trial mounted.
  const hostCheck = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    return !!el && !!el.shadowRoot?.querySelector('#whybuy-trial-root')
  })
  if (!hostCheck) throw new Error('Trial UI did not mount')
  console.log('✔ Trial UI mounted')

  const prevented = await page.evaluate(() => document.body.getAttribute('data-purchased') !== 'true')
  if (!prevented) throw new Error('Original click was not prevented')
  console.log('✔ Original click was prevented')

  // Take a screenshot of the trial intro / opening.
  await page.screenshot({ path: join(projectRoot, 'screenshot-1-trial.png'), fullPage: false })
  console.log('  Screenshot saved: screenshot-1-trial.png')

  // Drive 3 rounds of user input.
  await new Promise((r) => setTimeout(r, 3500))
  for (let i = 1; i <= 3; i++) {
    const ok = await page.evaluate((args) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const shadow = el?.shadowRoot
      const ta = shadow?.querySelector('textarea.whybuy-textarea')
      if (!ta) return false
      ta.focus()
      ta.value = `Argument ${args.round}: I use this product daily, the price is fair, and I have budget allocated.`
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = shadow?.querySelector('button.whybuy-btn')
      if (btn && !btn.disabled) {
        btn.click()
        return true
      }
      return false
    }, { round: i })
    if (!ok) throw new Error(`Failed to submit round ${i}`)
    console.log(`✔ Round ${i} submitted`)
    await new Promise((r) => setTimeout(r, 3500))
  }

  // Wait for verdict.
  await new Promise((r) => setTimeout(r, 5000))

  const hasVerdict = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    return !!el?.shadowRoot?.querySelector('.whybuy-verdict-card')
  })
  if (!hasVerdict) throw new Error('Verdict did not render')
  console.log('✔ Verdict rendered')

  await page.screenshot({ path: join(projectRoot, 'screenshot-2-verdict.png'), fullPage: false })
  console.log('  Screenshot saved: screenshot-2-verdict.png')

  // Click "Continue to purchase" to release the page.
  const proceeded = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    const btns = shadow?.querySelectorAll('button.whybuy-btn') ?? []
    for (const b of btns) {
      if (b.textContent?.includes('Continue to purchase')) {
        b.click()
        return true
      }
    }
    return false
  })
  if (!proceeded) throw new Error('Could not click Continue to purchase')
  console.log('✔ Clicked Continue to purchase')

  // Verify the host was removed and the click went through.
  await new Promise((r) => setTimeout(r, 800))
  const purchased = await page.evaluate(() => document.body.getAttribute('data-purchased'))
  if (purchased !== 'true') throw new Error('Purchase click did not re-dispatch')
  console.log('✔ Purchase click re-dispatched')

  // Verify history was saved. We need to ask the service worker since
  // chrome.storage is not exposed in the page's main world.
  // Send a custom message to the SW via a one-off port.
  const history = await sw.evaluate(async () => {
    return await new Promise((resolve) => {
      // @ts-ignore — chrome is available in service worker
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

  // === Test 2: Popup renders ===
  console.log('\n=== Test 2: Popup renders ===')
  const popupTarget = browser.targets().find(
    (t) => t.type() === 'page' && t.url().includes('popup.html'),
  )
  if (popupTarget) {
    const popupPage = await popupTarget.page()
    if (popupPage) {
      await new Promise((r) => setTimeout(r, 500))
      const popupText = await popupPage.evaluate(() => document.body.textContent?.slice(0, 200))
      console.log('  Popup text:', popupText?.replace(/\s+/g, ' ').trim().slice(0, 120))
      await popupPage.screenshot({ path: join(projectRoot, 'screenshot-3-popup.png') })
      console.log('  Screenshot saved: screenshot-3-popup.png')
    }
  } else {
    // Open the popup via JS.
    const extensionId = swTarget.url().match(/chrome-extension:\/\/([a-z]+)/)?.[1]
    if (extensionId) {
      const popupPage = await browser.newPage()
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`)
      await new Promise((r) => setTimeout(r, 800))
      const popupText = await popupPage.evaluate(() => document.body.textContent?.slice(0, 200))
      console.log('  Popup text:', popupText?.replace(/\s+/g, ' ').trim().slice(0, 120))
      await popupPage.screenshot({ path: join(projectRoot, 'screenshot-3-popup.png') })
      console.log('  Screenshot saved: screenshot-3-popup.png')
    }
  }

  // === Test 3: Options page renders ===
  console.log('\n=== Test 3: Options page renders ===')
  const extensionId = swTarget.url().match(/chrome-extension:\/\/([a-z]+)/)?.[1]
  if (extensionId) {
    const optsPage = await browser.newPage()
    await optsPage.goto(`chrome-extension://${extensionId}/options.html`)
    await new Promise((r) => setTimeout(r, 800))
    const optsText = await optsPage.evaluate(() => document.body.textContent?.slice(0, 200))
    console.log('  Options text:', optsText?.replace(/\s+/g, ' ').trim().slice(0, 120))
    await optsPage.screenshot({ path: join(projectRoot, 'screenshot-4-options.png'), fullPage: true })
    console.log('  Screenshot saved: screenshot-4-options.png')
  }

  console.log('\n✔ All smoke tests passed.')
} catch (err) {
  console.error('\n✘ Smoke test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
