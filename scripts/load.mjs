// Launch Chrome (or reload if already running) with the WhyBuy extension
// pre-loaded as an unpacked extension.
//
// Test isolation: by default the script uses a fresh tempdir as the
// user-data-dir, which is wiped on Chrome exit. If a profile path is
// passed via `process.argv[2]` or the `WHYBUY_PROFILE` env var, the
// script verifies it lives under `os.tmpdir()` — otherwise the
// extension's storage state (settings, history, cooldowns) would
// land on the user's real Chrome profile and could conflict with their
// day-to-day browsing. The verification can be bypassed with
// `WHYBUY_ALLOW_REAL_PROFILE=1` for the rare case where the user
// genuinely wants to load the extension on top of an existing profile.
//
// Usage:
//   node scripts/load.mjs                          # fresh tempdir
//   node scripts/load.mjs /path/to/tempdir         # specific tempdir
//   WHYBUY_PROFILE=/path/to/tempdir node scripts/load.mjs
//   WHYBUY_ALLOW_REAL_PROFILE=1 node scripts/load.mjs /path/to/real/profile

import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdtempSync } from 'node:fs'
import { join, dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { resolveChrome } from './chrome.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const extensionPath = join(projectRoot, '.output', 'chrome-mv3')

if (!existsSync(join(extensionPath, 'manifest.json'))) {
  console.error('✘ Extension not built.')
  console.error('  Run `npm run build` first, then `npm run load`.')
  process.exit(1)
}

const requestedProfile = process.argv[2] || process.env.WHYBUY_PROFILE || null

// Test isolation: a real (non-tempdir) profile would let the
// extension's storage state pollute the user's day-to-day Chrome.
// Refuse unless explicitly allowed.
const isTempProfile = (p) => {
  if (!p) return false
  const abs = resolve(p)
  const tmp = resolve(tmpdir())
  // The profile path must be a descendant of os.tmpdir().
  return abs === tmp || abs.startsWith(tmp + sep)
}

let userDataDir
if (requestedProfile) {
  if (isTempProfile(requestedProfile)) {
    userDataDir = requestedProfile
  } else if (process.env.WHYBUY_ALLOW_REAL_PROFILE === '1') {
    console.warn(`⚠ Using non-temp profile: ${requestedProfile}`)
    console.warn('  WHYBUY_ALLOW_REAL_PROFILE=1 was set. State will persist across runs.')
    userDataDir = requestedProfile
  } else {
    console.error('✘ Refusing to use a non-temp profile.')
    console.error(`  Requested: ${requestedProfile}`)
    console.error('  It does not live under os.tmpdir(), so the extension')
    console.error('  would write to your real Chrome storage state.')
    console.error('')
    console.error('  Fix:')
    console.error('    - Omit the profile argument (a fresh tempdir is used).')
    console.error('    - Or pass a path under your temp dir.')
    console.error(`    - Or set WHYBUY_ALLOW_REAL_PROFILE=1 to override.`)
    process.exit(2)
  }
} else {
  userDataDir = mkdtempSync(join(tmpdir(), 'whybuy-profile-'))
}

// Find Chrome (env override first, then a cross-platform system install).
const chromePath = resolveChrome()

console.log('Chrome:', chromePath)
console.log('Profile:', userDataDir)
console.log('Extension:', extensionPath)
console.log()
console.log('Chrome will open with the WhyBuy extension already loaded.')
console.log('Close this terminal to terminate Chrome.')

const args = [
  `--user-data-dir=${userDataDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
]

const child = spawn(chromePath, args, { stdio: 'inherit' })
child.on('exit', (code) => process.exit(code ?? 0))

// Clean shutdown on Ctrl+C.
process.on('SIGINT', () => {
  child.kill()
  process.exit(0)
})
