// Investigate the Amazon checkout page to understand the button structure.
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import puppeteer from 'puppeteer-core'
import { resolveChrome } from './chrome.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')
const puppeteerChrome = resolveChrome()

const url = process.argv[2] || 'https://www.amazon.ca/checkout/p/p-703-8999281-6162623/pay?pipelineType=Chewbacca&hasWorkingJavascript=1'
const userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-investigate-'))

let browser
try {
  browser = await puppeteer.launch({
    // Branded Chrome 137+ ignores --load-extension; install over CDP instead.
    pipe: true,
    enableExtensions: [extensionPath],
    executablePath: puppeteerChrome,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
    ],
    dumpio: false,
    timeout: 60000,
  })

  const page = await browser.newPage()
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.includes('WhyBuy') || text.startsWith('[WhyBuy]')) {
      console.log('  [page]', text)
    }
  })
  page.on('pageerror', (err) => console.log('  [pageerror]', err.message))

  console.log('Navigating to:', url)
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  } catch (e) {
    console.log('  Navigation error (continuing):', e.message.slice(0, 120))
  }
  await new Promise((r) => setTimeout(r, 3000))

  const info = await page.evaluate(() => {
    const out = {
      url: location.href,
      title: document.title,
      h1: Array.from(document.querySelectorAll('h1')).slice(0, 5).map((h) => h.textContent?.trim()).filter(Boolean),
      buttons: [],
      links: [],
      inputs: [],
    }
    document.querySelectorAll('button, input[type="submit"], input[type="button"]').forEach((el) => {
      const text = (el.textContent || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!text) return
      out.buttons.push({
        tag: el.tagName,
        type: el.getAttribute('type'),
        text,
        id: el.id,
        name: el.getAttribute('name'),
        aria: el.getAttribute('aria-label'),
      })
    })
    document.querySelectorAll('a').forEach((el) => {
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)
      if (!text) return
      const lower = text.toLowerCase()
      if (
        lower.includes('buy') ||
        lower.includes('checkout') ||
        lower.includes('order') ||
        lower.includes('pay') ||
        lower.includes('cart')
      ) {
        out.links.push({ text, href: el.getAttribute('href')?.slice(0, 100) })
      }
    })
    return out
  })

  console.log('\nURL:', info.url)
  console.log('Title:', info.title)
  console.log('H1s:', info.h1)
  console.log('\nButtons:', info.buttons.length)
  for (const b of info.buttons) console.log(' -', b.tag, b.type, JSON.stringify(b.text), b.id, b.aria)
  console.log('\nRelevant links:', info.links.length)
  for (const l of info.links) console.log(' -', JSON.stringify(l.text), '->', l.href)

  await page.screenshot({ path: join(projectRoot, 'amazon-investigate.png'), fullPage: false })
  console.log('\nScreenshot saved: amazon-investigate.png')
} catch (err) {
  console.error('Failed:', err.message)
  if (err.stack) console.error(err.stack)
} finally {
  if (browser) await browser.close().catch(() => {})
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch {}
}
