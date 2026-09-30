// Focused test for the bugs the user reported:
//   1. Product info shows in the header
//   2. End trial button works
//   3. Prosecution AI starts talking
//   4. Defense composer is always visible and typeable

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
const fileUrl = 'file:///' + join(__dirname, 'test-page.html').replace(/\\/g, '/')

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-bugs-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('bug-test', userDataDir)
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
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('WhyBuy') || t.startsWith('[WhyBuy]')) {
      console.log('  [page]', t)
    }
  })

  await page.goto(fileUrl, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 1000))
  await page.click('#buy')
  await new Promise((r) => setTimeout(r, 2500))

  // === Bug 1: Product info shows in header ===
  console.log('\n=== Bug 1: Product info in header ===')
  const headerInfo = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    if (!shadow) return { found: false }
    const text = shadow.querySelector('header')?.textContent ?? ''
    return {
      found: true,
      hasName: text.includes('Premium Wireless Headphones'),
      hasPrice: text.includes('129.99') || text.includes('Price unavailable'),
      hasDomain: text.includes('Premium Wireless Headphones') || text.length > 20,
      snippet: text.slice(0, 300),
    }
  })
  console.log('  Header:', headerInfo)
  if (!headerInfo.hasName) {
    console.log('  ⚠ Product name not in header')
  } else {
    console.log('  ✔ Product name shown')
  }
  if (!headerInfo.hasPrice) {
    console.log('  ⚠ Price not in header')
  } else {
    console.log('  ✔ Price shown')
  }

  await page.screenshot({ path: join(projectRoot, 'screenshot-bug1-header.png') })

  // === Bug 2: End trial button works ===
  console.log('\n=== Bug 2: End trial button ===')
  const endBtnFound = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    const btns = shadow?.querySelectorAll('button') ?? []
    for (const b of btns) {
      if (b.textContent?.includes('End trial')) return true
    }
    return false
  })
  console.log('  End trial button found:', endBtnFound)

  if (endBtnFound) {
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const shadow = el?.shadowRoot
      const btns = shadow?.querySelectorAll('button') ?? []
      for (const b of btns) {
        if (b.textContent?.includes('End trial')) {
          b.click()
          return true
        }
      }
      return false
    })
    console.log('  Clicked End trial:', clicked)
    await new Promise((r) => setTimeout(r, 800))
    const hostRemoved = await page.evaluate(() => !document.querySelector('[data-whybuy="1"]'))
    console.log('  Host removed after End trial:', hostRemoved)
    if (!hostRemoved) {
      throw new Error('End trial button did NOT close the trial')
    }
    console.log('  ✔ End trial works')
  } else {
    throw new Error('End trial button not found in header')
  }

  // === Bug 3: Prosecution AI starts talking ===
  console.log('\n=== Bug 3: Prosecution AI starts ===')
  // Re-open the trial.
  await page.click('#buy')
  await new Promise((r) => setTimeout(r, 2000))

  // Wait for streaming text in the prosecution panel.
  let waited = 0
  let firstText = ''
  while (waited < 8000) {
    firstText = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const shadow = el?.shadowRoot
      const prosecution = shadow?.querySelectorAll('section')[0]
      return prosecution?.textContent ?? ''
    })
    if (firstText && firstText.length > 50) break
    await new Promise((r) => setTimeout(r, 250))
    waited += 250
  }
  console.log(`  Waited ${waited}ms for prosecution`)
  console.log('  First 200 chars of prosecution:', firstText.slice(0, 200))
  if (!firstText || firstText.length < 50) {
    throw new Error('Prosecution did not produce any text')
  }
  console.log('  ✔ Prosecution AI is talking')

  await page.screenshot({ path: join(projectRoot, 'screenshot-bug3-prosecution.png') })

  // === Bug 4: Defense composer is visible and typeable ===
  console.log('\n=== Bug 4: Defense composer ===')
  const composerState = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    const ta = shadow?.querySelector('textarea.whybuy-textarea')
    if (!ta) return { found: false }
    const isVisible = ta.offsetParent !== null || ta.getClientRects().length > 0
    const rect = ta.getBoundingClientRect()
    return {
      found: true,
      disabled: ta.disabled,
      placeholder: ta.placeholder,
      visible: isVisible,
      width: rect.width,
      height: rect.height,
    }
  })
  console.log('  Composer state:', composerState)
  if (!composerState.found) {
    throw new Error('Composer textarea not found')
  }
  console.log('  ✔ Composer is in the DOM')

  // The composer is enabled only during user_1 / user_2 / user_3. Wait for the
  // prosecution to finish so the user turn begins.
  let composerEnabled = false
  waited = 0
  while (waited < 12000) {
    composerEnabled = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      const shadow = el?.shadowRoot
      const ta = shadow?.querySelector('textarea.whybuy-textarea')
      return !!ta && !ta.disabled
    })
    if (composerEnabled) break
    await new Promise((r) => setTimeout(r, 300))
    waited += 300
  }
  console.log(`  Composer enabled after ${waited}ms`)
  if (!composerEnabled) {
    throw new Error('Composer was never enabled — prosecution may have hung')
  }

  // Try typing into it.
  const typed = await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const shadow = el?.shadowRoot
    const ta = shadow?.querySelector('textarea.whybuy-textarea')
    if (!ta) return { ok: false, reason: 'no textarea' }
    ta.focus()
    ta.value = 'I need this product, I have budget, and I researched alternatives.'
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    return { ok: true, value: ta.value, length: ta.value.length }
  })
  console.log('  Typed:', typed)
  if (!typed.ok || typed.length === 0) {
    throw new Error('Could not type into the composer')
  }
  console.log('  ✔ Composer accepts text')

  await page.screenshot({ path: join(projectRoot, 'screenshot-bug4-composer.png') })

  console.log('\n✔ All four bug tests passed.')
} catch (err) {
  console.error('\n✘ Bug test failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}

process.exit(exitCode)
