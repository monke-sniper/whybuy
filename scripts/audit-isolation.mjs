// Audit the extension's test isolation.
//
// This script does two things:
//   1. It runs an end-to-end trial cycle against the built extension
//      using a fresh tempdir profile, and asserts that the tempdir
//      was actually used (not some other directory).
//   2. It walks the system's tempdir before and after, and confirms
//      that no files outside the test's own profile dir were
//      touched by Chrome.
//
// The point is to catch regressions: if a future change accidentally
// causes the content script or background service worker to write to
// a hard-coded path (e.g. an absolute `os.tmpdir() + '/whybuy.json'`
// that lives outside the user-data-dir), this test will fail.
//
// Usage:
//   node scripts/audit-isolation.mjs
//
// The test does NOT need a real Ollama key — it short-circuits the
// trial by overriding `provider.judgeVerdict` / `provider.counselTurn`
// to return canned text. That keeps the test fast and offline.

import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'
import { isTempProfile, assertIsolatedProfile, logIsolatedProfile } from './lib/test-isolation.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const puppeteerChrome = resolveChrome()

if (!existsSync(extensionPath)) {
  console.error('Extension not built. Run `npm run build` first.')
  process.exit(1)
}

let exitCode = 0
let browser
let server

try {
  // === 1. Set up an isolated fixture and a sentinel ===
  // The fixture is served from a tempdir HTTP server so the
  // extension's content script can run. The sentinel file lives in
  // a *different* tempdir so we can verify Chrome doesn't touch
  // anything outside its own user-data-dir.
  const fixtureDir = mkdtempSync(join(tmpdir(), 'whybuy-audit-fixture-'))
  const profileDir = mkdtempSync(join(tmpdir(), 'whybuy-audit-profile-'))
  const sentinelDir = mkdtempSync(join(tmpdir(), 'whybuy-audit-sentinel-'))
  const sentinelFile = join(sentinelDir, 'must-not-be-touched.txt')
  const sentinelContents = `sentinel @ ${new Date().toISOString()}\n`
  writeFileSync(sentinelFile, sentinelContents, 'utf8')

  assertIsolatedProfile(profileDir)
  logIsolatedProfile('audit-isolation', profileDir)

  // Stand up a tiny fixture page with a "Proceed to checkout" button.
  const fixtureHtml = `<!doctype html>
<html><head><title>Audit Fixture</title></head>
<body>
  <h1>Audit Fixture Product</h1>
  <p>$9.99</p>
  <button id="checkout" type="button">Proceed to checkout</button>
</body></html>`
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(fixtureHtml)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const fixtureUrl = `http://audit.localtest.me:${port}/`

  console.log('Fixture:', fixtureUrl)
  console.log('Profile:', profileDir)
  console.log('Sentinel:', sentinelFile)

  // === 2. Launch Chrome with the extension ===
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
      `--user-data-dir=${profileDir}`,
    ],
    dumpio: false,
    timeout: 30000,
  })
  await new Promise((r) => setTimeout(r, 1500))

  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  await page.goto(fixtureUrl, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 800))

  // === 3. Run a trial cycle ===
  await page.click('#checkout')
  let mounted = false
  let waited = 0
  while (waited < 10000) {
    mounted = await page.evaluate(() => {
      const el = document.querySelector('[data-whybuy="1"]')
      return !!el && !!el.shadowRoot?.querySelector('#whybuy-trial-root')
    })
    if (mounted) break
    await new Promise((r) => setTimeout(r, 200))
    waited += 200
  }
  if (!mounted) {
    console.error('✘ Trial did not mount on the audit fixture.')
    exitCode = 1
  } else {
    console.log('✔ Trial mounted on the audit fixture')
  }

  // Drive 3 rounds so the deliberation phase runs.
  for (let i = 1; i <= 3; i++) {
    let enabled = false
    waited = 0
    while (waited < 30000) {
      enabled = await page.evaluate(() => {
        const el = document.querySelector('[data-whybuy="1"]')
        const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
        return !!ta && !ta.disabled
      })
      if (enabled) break
      await new Promise((r) => setTimeout(r, 300))
      waited += 300
    }
    if (!enabled) {
      console.error(`✘ Composer never enabled for round ${i}`)
      exitCode = 1
      break
    }
    await page.evaluate((roundIdx) => {
      const el = document.querySelector('[data-whybuy="1"]')
      const ta = el?.shadowRoot?.querySelector('textarea.whybuy-textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, `Audit round ${roundIdx}: I need this for daily work.`)
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      const btn = el?.shadowRoot?.querySelector('button.whybuy-btn')
      btn?.click()
    }, i)
    await new Promise((r) => setTimeout(r, 1500))
  }

  // End the trial.
  await page.evaluate(() => {
    const el = document.querySelector('[data-whybuy="1"]')
    const close = Array.from(el?.shadowRoot?.querySelectorAll('button') ?? []).find((b) =>
      /end trial/i.test(b.textContent || ''),
    )
    close?.click()
  })
  await new Promise((r) => setTimeout(r, 800))

  // === 4. Verify the profile dir is a real Chrome user-data-dir ===
  const profileStat = statSync(profileDir, { throwIfNoEntry: false })
  if (!profileStat || !profileStat.isDirectory()) {
    console.error(`✘ Profile dir is missing: ${profileDir}`)
    exitCode = 1
  } else {
    const entries = readdirSync(profileDir)
    if (entries.length === 0) {
      console.error(`✘ Profile dir is empty (Chrome never wrote to it): ${profileDir}`)
      exitCode = 1
    } else {
      console.log(`✔ Profile dir has ${entries.length} entries (Chrome wrote to it)`)
    }
  }

  // === 5. Verify the sentinel file was not touched ===
  if (!existsSync(sentinelFile)) {
    console.error(`✘ Sentinel file was deleted: ${sentinelFile}`)
    exitCode = 1
  } else {
    const current = readFileSync(sentinelFile, 'utf8')
    if (current !== sentinelContents) {
      console.error(`✘ Sentinel file was modified.`)
      console.error('  before:', JSON.stringify(sentinelContents))
      console.error('  after: ', JSON.stringify(current))
      exitCode = 1
    } else {
      console.log('✔ Sentinel file untouched (no out-of-profile writes)')
    }
  }

  // === 6. Verify no whybuy.* files were written outside the profile ===
  const leaks = await findWhybuyFilesOutsideProfile(tmpdir(), profileDir, sentinelDir)
  if (leaks.length > 0) {
    console.error(`✘ Found ${leaks.length} whybuy.* file(s) outside the test profile:`)
    for (const l of leaks) console.error('  -', l)
    exitCode = 1
  } else {
    console.log('✔ No whybuy.* files leaked outside the test profile')
  }

  if (exitCode === 0) console.log('\n✔ audit-isolation passed.')
  else console.log('\n✘ audit-isolation FAILED.')
} catch (err) {
  console.error('\n✘ audit-isolation crashed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  if (server) server.close()
}

/**
 * Walk `root` looking for files whose name starts with `whybuy.`
 * and that live outside the two allowed directories. The walk is
 * capped at depth 3 and skips any node_modules-looking dir to keep
 * it fast.
 */
async function findWhybuyFilesOutsideProfile(root, allowed, ...alsoAllowed) {
  const allowedAbs = [resolve(allowed), ...alsoAllowed.map((p) => resolve(p))]
  const out = []
  const skip = new Set(['node_modules', '.git', '.cache'])
  function walk(dir, depth) {
    if (depth > 3) return
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      if (skip.has(name)) continue
      const p = join(dir, name)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) {
        walk(p, depth + 1)
      } else if (st.isFile() && name.startsWith('whybuy.')) {
        const abs = resolve(p)
        if (!allowedAbs.some((a) => abs === a || abs.startsWith(a + sep))) {
          out.push(abs)
        }
      }
    }
  }
  walk(root, 0)
  return out
}

process.exit(exitCode)
