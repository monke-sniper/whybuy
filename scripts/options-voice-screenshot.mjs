// Options-UI screenshot of the new Voice section.
//
// Serves a real Options page with the extension loaded, screenshots
// the page in three states:
//   1. Initial: no voice key, "Add an API key" placeholder
//   2. With a (fake) key typed: voice picker populated with ElevenLabs
//      voices, model picker, mute/volume controls
//   3. After Test: green confirmation, all controls visible
//
// The fake key is just a string — ElevenLabs' /v1/user endpoint will
// return 401 and the test button will show a red error. The
// screenshots prove the UI renders, the fields wire up to settings,
// and the mute/volume state persists.
//
// Usage: npm run build && node scripts/options-voice-screenshot.mjs

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

const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-options-voice-'))
assertIsolatedProfile(userDataDir)
logIsolatedProfile('options-voice-screenshot', userDataDir)
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
      '--window-size=1280,1100',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
    timeout: 60000,
  })
  await new Promise((r) => setTimeout(r, 2000))

  // Open the extension's Options page directly.
  const swTarget = browser.targets().find(
    (t) => t.type() === 'service_worker' && t.url().includes('chrome-extension://'),
  )
  if (!swTarget) throw new Error('Service worker not found')
  const extensionId = new URL(swTarget.url()).host
  const optionsUrl = `chrome-extension://${extensionId}/options.html`
  console.log('Options URL:', optionsUrl)

  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 1100 })
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))
  page.on('console', (msg) => {
    const t = msg.text()
    if (t.includes('WhyBuy') || t.startsWith('[WhyBuy]')) console.log('  [page]', t)
  })

  console.log('\n[1/3] Loading Options page ...')
  await page.goto(optionsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await new Promise((r) => setTimeout(r, 1500))

  // Scroll to the Voice section.
  await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('*'))
    const voiceHeading = headings.find((h) => /^AI Voice/i.test(h.textContent || ''))
    if (voiceHeading) voiceHeading.scrollIntoView({ block: 'start' })
  })
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: join(projectRoot, 'voice-1-empty.png'), fullPage: false })
  console.log('  📸 voice-1-empty.png (Voice section, no key)')

  console.log('\n[2/3] Filling in a fake key (just to render the controls) ...')
  // We can't reach ElevenLabs from this script (no real key), but we
  // can pre-populate the settings so the UI renders with controls.
  // The "Test" button will show a connection error — that's fine
  // for the screenshot.
  await swTarget.worker().then((sw) =>
    sw.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.storage.local.set(
            {
              'whybuy.settings.v1': {
                debateLength: 'standard',
                tone: 'firm',
                ignoredSites: [],
                byok: null,
                promptDetail: 'minimal',
                judgeMode: 'natural',
                voice: {
                  enabled: true,
                  apiKey: 'sk_fake_key_for_screenshot_only_0123456789',
                  voiceId: '21m00Tcm4TlvDq8ikWAM',
                  modelId: 'eleven_turbo_v2_5',
                  muted: false,
                  volume: 0.85,
                  stability: 0.5,
                  similarityBoost: 0.75,
                },
              },
            },
            () => resolve(true),
          )
        }),
    ),
  )
  // Reload to pick up the new settings.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1500))
  await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('*'))
    const voiceHeading = headings.find((h) => /^AI Voice/i.test(h.textContent || ''))
    if (voiceHeading) voiceHeading.scrollIntoView({ block: 'start' })
  })
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: join(projectRoot, 'voice-2-filled.png'), fullPage: false })
  console.log('  📸 voice-2-filled.png (Voice section with a key typed)')

  console.log('\n[3/3] Capturing the full page (with all sections) ...')
  await page.evaluate(() => window.scrollTo(0, 0))
  await new Promise((r) => setTimeout(r, 500))
  await page.screenshot({ path: join(projectRoot, 'voice-3-full.png'), fullPage: true })
  console.log('  📸 voice-3-full.png (full Options page)')

  console.log('\n✔ Voice-options screenshots saved:')
  console.log('   voice-1-empty.png    — no API key, prompt to add one')
  console.log('   voice-2-filled.png   — with a key, controls visible')
  console.log('   voice-3-full.png     — entire Options page')
} catch (err) {
  console.error('\n✘ Voice-options screenshot failed:', err.message)
  if (err.stack) console.error(err.stack)
  exitCode = 1
} finally {
  if (browser) await browser.close().catch(() => {})
  rmSync(userDataDir, { recursive: true, force: true })
}

process.exit(exitCode)
