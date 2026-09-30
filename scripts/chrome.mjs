// Resolve a Chrome/Chromium binary for the Puppeteer E2E scripts.
//
// Order of preference:
//   1. WHYBUY_CHROME / PUPPETEER_EXECUTABLE_PATH env var (explicit override)
//   2. Extra candidates a caller passes in (e.g. a known-good local path)
//   3. A system install (macOS, Linux, Windows)
//
// Kept cross-platform on purpose: these scripts previously hardcoded one
// contributor's Windows cache path, which broke every E2E run elsewhere.

import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

/** Candidate system installs for the current platform. */
function systemCandidates() {
  const home = homedir()
  switch (platform()) {
    case 'darwin':
      return [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ]
    case 'win32':
      return [
        join(
          process.env.PROGRAMFILES || 'C:\\Program Files',
          'Google/Chrome/Application/chrome.exe',
        ),
        join(
          process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
          'Google/Chrome/Application/chrome.exe',
        ),
        join(
          process.env.LOCALAPPDATA || '',
          'Google/Chrome/Application/chrome.exe',
        ),
      ]
    default:
      return [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',
      ]
  }
}

/**
 * Returns a Chrome executable path, or exits with a helpful message.
 * @param {string[]} [extraCandidates] additional paths to try first
 * @returns {string}
 */
export function resolveChrome(extraCandidates = []) {
  const env = process.env.WHYBUY_CHROME || process.env.PUPPETEER_EXECUTABLE_PATH
  const candidates = [env, ...extraCandidates, ...systemCandidates()].filter(
    Boolean,
  )

  for (const p of candidates) {
    if (existsSync(p)) return p
  }

  console.error('✘ Chrome not found. Tried:')
  for (const p of candidates) console.error('  -', p)
  console.error(
    '\nSet WHYBUY_CHROME=/path/to/chrome to point at your browser.',
  )
  process.exit(1)
}
