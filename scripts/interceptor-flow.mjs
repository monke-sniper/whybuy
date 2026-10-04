// End-to-end test of the checkout click interceptor against the REAL
// built extension. Needs no AI key: it never runs a debate, it only
// checks what happens to the user's checkout click.
//
// Regression coverage for:
//   - an ignored site must NOT leave the checkout button dead, and the
//     re-fired click must submit a checkout form exactly once
//   - a click on the page's checkout button while a trial is open must
//     stay blocked (it used to leak through to the page)
//   - a fast double-click must not replay the checkout twice
//   - a page-forged (untrusted) click must never open a trial
//   - the per-site bypass must be readable from the content script
//     (chrome.storage.session access level) and follow changes made by
//     another tab without a reload
//
// Usage: npm run build && node scripts/interceptor-flow.mjs

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'
import { assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const chromePath = resolveChrome()

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Cart</title>
<h1>Your cart</h1>
<p>Acme Mug — $12.99</p>
<a id="co-link" href="/done?via=link" style="display:inline-block;padding:12px">Proceed to checkout</a>
<form id="f" method="post" action="/submit"><button id="co-submit" type="submit">Checkout</button></form>
<button id="co-btn" type="button">Checkout</button>`

let posts = 0
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8')
  if (req.method === 'POST' && req.url === '/submit') {
    posts++
    req.resume()
    res.end('<!doctype html><title>Submitted</title><p>submitted</p>')
  } else if (req.url.startsWith('/done')) {
    res.end('<!doctype html><title>Done</title><p>done</p>')
  } else {
    res.end(PAGE)
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-interceptor-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('interceptor-flow', userDataDir)

let browser
let exitCode = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const pass = (m) => console.log('  ✔', m)
const check = (cond, m) => {
  if (!cond) throw new Error(m)
  pass(m)
}

try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    userDataDir,
    // Branded Chrome 137+ ignores --load-extension; Puppeteer installs the
    // extension over CDP instead (needs the pipe transport).
    pipe: true,
    enableExtensions: [extensionPath],
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
    timeout: 30000,
  })

  let swTarget = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'))
  if (!swTarget) swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'), { timeout: 15000 })
  const sw = await swTarget.worker()
  await sleep(500)

  const setSettings = (ignoredSites) =>
    sw.evaluate(
      (ignored) => chrome.storage.local.set({ 'whybuy.settings.v1': { ignoredSites: ignored, byok: null, promptDetail: 'minimal', judgeMode: 'natural' } }),
      ignoredSites,
    )
  const clearState = () =>
    sw.evaluate(async () => {
      await chrome.storage.local.clear()
      await chrome.storage.session.clear()
    })
  const hasTrial = (page) => page.evaluate(() => !!document.querySelector('[data-whybuy="1"]'))

  const openPage = async () => {
    const page = await browser.newPage()
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message))
    await page.goto(base + '/', { waitUntil: 'load' })
    await sleep(800) // let the content script install its listener
    return page
  }

  // === 1. Ignored site: the click is re-fired, form submitted exactly once ===
  console.log('\n=== 1. Ignored site never leaves checkout dead ===')
  await clearState()
  await setSettings(['127.0.0.1'])
  {
    posts = 0
    const page = await openPage()
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }), page.click('#co-submit')])
    check(!(await hasTrial(page)), 'no trial on an ignored site')
    check(posts === 1, `form submitted exactly once (got ${posts})`)
    await page.close()

    const page2 = await openPage()
    await Promise.all([page2.waitForNavigation({ waitUntil: 'load', timeout: 10000 }), page2.click('#co-link')])
    check(new URL(page2.url()).pathname === '/done', 'checkout link navigated on an ignored site')
    await page2.close()

    // A fast double-click is one checkout, not two.
    posts = 0
    const page3 = await openPage()
    await Promise.all([page3.waitForNavigation({ waitUntil: 'load', timeout: 10000 }), page3.click('#co-submit', { count: 2, delay: 5 })])
    await sleep(500)
    check(posts === 1, `a double-click submitted the form once (got ${posts})`)
    await page3.close()
  }

  // === 2. Trial open: page checkout clicks stay blocked ===
  console.log('\n=== 2. Page checkout clicks stay blocked while a trial is open ===')
  await clearState()
  await setSettings([])
  {
    posts = 0
    const page = await openPage()
    await page.click('#co-link')
    await sleep(1500)
    check(await hasTrial(page), 'trial opened on a checkout click')
    check(new URL(page.url()).pathname === '/', 'page did not navigate')
    // The overlay covers the page; let real mouse input reach the page
    // button underneath so this is a genuine (trusted) user click.
    await page.evaluate(() => {
      document.querySelector('[data-whybuy="1"]').style.pointerEvents = 'none'
    })
    await page.click('#co-submit')
    await sleep(800)
    check(posts === 0, 'a second page checkout click did not submit the form')
    check(new URL(page.url()).pathname === '/', 'page still did not navigate')
    await page.close()
  }

  // === 2b. Forged clicks never open a trial ===
  console.log('\n=== 2b. A page-forged click never opens a trial ===')
  await clearState()
  await setSettings([])
  {
    const page = await openPage()
    await page.evaluate(() => {
      document.getElementById('co-btn').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
      document.getElementById('co-btn').click()
    })
    await sleep(1200)
    check(!(await hasTrial(page)), 'synthetic clicks did not open the trial')
    await page.click('#co-btn')
    await sleep(1500)
    check(await hasTrial(page), 'a real click on the same button does open it')
    await page.close()
  }

  // === 3. Bypass is readable by the content script and live across tabs ===
  console.log('\n=== 3. Per-site bypass (storage.session) ===')
  await clearState()
  await setSettings([])
  const setBypass = () => sw.evaluate(() => chrome.storage.session.set({ 'whybuy.bypass.v1': { sites: ['127.0.0.1'] } }))
  {
    posts = 0
    await setBypass()
    const page = await openPage() // loads AFTER the bypass exists
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }), page.click('#co-submit')])
    check(!(await hasTrial(page)) && posts === 1, 'bypass set before load is honoured by the content script')
    await page.close()
  }
  await clearState()
  await setSettings([])
  {
    posts = 0
    const page = await openPage() // loaded BEFORE the bypass exists
    await setBypass() // "another tab" overrides
    await sleep(500)
    await Promise.all([page.waitForNavigation({ waitUntil: 'load', timeout: 10000 }), page.click('#co-submit')])
    check(!(await hasTrial(page)) && posts === 1, 'bypass added from elsewhere applies without a reload')
    await page.close()
  }

  console.log('\n✔ Interceptor flow test passed.')
} catch (err) {
  console.error('\n✘ Interceptor flow test failed:', err.message)
  exitCode = 1
} finally {
  try { await browser?.close() } catch {}
  server.close()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
  process.exit(exitCode)
}
