#!/usr/bin/env node
// install.mjs — one-command installer helper for WhyBuy.
//
// What it does:
//   1. If `.output/chrome-mv3/manifest.json` is missing, runs
//      `npm install` and `npm run build` (and optionally Firefox).
//   2. Detects the host platform.
//   3. Prints numbered, click-by-click instructions for installing
//      the unpacked extension into Chrome, Edge, Brave, Arc, Opera,
//      and Firefox.
//   4. Optionally opens the right extensions page in the user's
//      default browser.
//
// Usage:
//   node scripts/install.mjs                       # build + print + ask to open
//   node scripts/install.mjs --no-build            # skip the build step
//   node scripts/install.mjs --browser chrome      # open chrome://extensions
//   node scripts/install.mjs --browser firefox     # open Firefox debug page
//   node scripts/install.mjs --no-open             # never open a browser tab
//   node scripts/install.mjs --path <folder>       # use a prebuilt folder
//   node scripts/install.mjs --firefox             # also build the Firefox bundle
//   node scripts/install.mjs --help

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { platform } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout, exit } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
}
const isColor = stdout.isTTY && process.env.NO_COLOR === undefined
const c = (color, s) => (isColor ? `${ANSI[color]}${s}${ANSI.reset}` : s)

const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--')))
const nonFlags = argv.filter((a) => !a.startsWith('--'))
const help = flags.has('--help') || flags.has('-h')
const noBuild = flags.has('--no-build')
const noOpen = flags.has('--no-open')
const alsoFirefox = flags.has('--firefox')
const pathArg = flags.has('--path') ? nonFlags[nonFlags.indexOf('--path') + 1] : null
const browserArg = (() => {
  if (!flags.has('--browser')) return null
  const i = nonFlags.indexOf('--browser')
  return (nonFlags[i + 1] || '').toLowerCase() || null
})()
const positional = nonFlags.filter((a) => a !== pathArg && a !== browserArg)[0] || null

if (help) {
  console.log(
    [
      'install.mjs — one-command installer for WhyBuy',
      '',
      'Usage:',
      '  node scripts/install.mjs                       # build + print + ask to open',
      '  node scripts/install.mjs --no-build            # skip the build step',
      '  node scripts/install.mjs --browser chrome      # open chrome://extensions',
      '  node scripts/install.mjs --browser firefox     # open Firefox debug page',
      '  node scripts/install.mjs --no-open             # never open a browser tab',
      '  node scripts/install.mjs --path <folder>       # use a prebuilt folder',
      '  node scripts/install.mjs --firefox             # also build the Firefox bundle',
      '  node scripts/install.mjs --help',
      '',
      'Common invocations:',
      '  npm run install:ext                           # alias for the default flow',
      '  npm run install:ext -- --browser firefox      # build + open Firefox',
    ].join('\n'),
  )
  exit(0)
}

const host = (() => {
  switch (platform()) {
    case 'win32': return 'windows'
    case 'darwin': return 'macos'
    case 'linux':
    case 'freebsd':
    case 'openbsd': return 'linux'
    default: return 'linux'
  }
})()

const browserUrls = {
  chrome: 'chrome://extensions',
  edge: 'edge://extensions',
  brave: 'brave://extensions',
  arc: 'arc://extensions',
  opera: 'opera://extensions',
  firefox: 'about:debugging#/runtime/this-firefox',
}

function openUrl(url) {
  const args = (() => {
    if (host === 'windows') return ['cmd', ['/c', 'start', '""', url]]
    if (host === 'macos') return ['open', [url]]
    return ['xdg-open', [url]]
  })()
  try {
    const child = spawn(...args, { stdio: 'ignore', detached: true, shell: false })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts })
}

function ensureBuilt(target, { allowBuild }) {
  const dir = join(projectRoot, '.output', target)
  const manifest = join(dir, 'manifest.json')
  if (existsSync(manifest)) return { dir, manifest, built: true }
  if (!allowBuild) {
    return { dir, manifest, built: false, error: 'manifest.json missing' }
  }
  if (!existsSync(join(projectRoot, 'node_modules'))) {
    console.log(c('cyan', '› Installing npm dependencies…'))
    const r = run('npm', ['install'])
    if (r.status !== 0) {
      return { dir, manifest, built: false, error: 'npm install failed' }
    }
  }
  console.log(c('cyan', `› Building ${target}…`))
  const script = target.startsWith('firefox') ? 'build:firefox' : 'build'
  const r = run('npm', ['run', script])
  if (r.status !== 0) {
    return { dir, manifest, built: false, error: `${script} failed` }
  }
  return { dir, manifest, built: existsSync(manifest) }
}

function nodeVersionOk() {
  const m = process.version.match(/^v(\d+)\.(\d+)\./)
  if (!m) return false
  const major = Number(m[1])
  return major >= 18
}

function folderInstructions(folder, browserKey) {
  const folderLabel = c('bold', folder)
  if (browserKey === 'firefox') {
    return [
      `1. Open ${c('bold', 'about:debugging#/runtime/this-firefox')} in Firefox.`,
      `2. Click ${c('bold', '"This Firefox"')} in the left sidebar (it is the default).`,
      `3. Click ${c('bold', '"Load Temporary Add-on…"')}.`,
      `4. In the file picker, navigate into ${folderLabel} and select ${c('bold', 'manifest.json')}.`,
      `5. WhyBuy appears in the list. Click ${c('bold', '"Inspect"')} if you want to see the background console.`,
      ``,
      `   ${c('yellow', '⚠ Temporary add-ons are removed when Firefox quits. Re-add it after every restart, or sign the extension (see INSTALL.md → "Permanent Firefox install").')}`,
    ]
  }
  const url = browserUrls[browserKey] || browserUrls.chrome
  return [
    `1. Open ${c('bold', url)} in your browser.`,
    `2. Toggle ${c('bold', '"Developer mode"')} ${c('dim', '(top-right)')} on.`,
    `3a. ${c('green', 'Easiest:')} drag the ${folderLabel} folder onto the extensions page, ${c('dim', 'or')}`,
    `3b. click ${c('bold', '"Load unpacked"')} and pick the ${folderLabel} folder.`,
    `4. WhyBuy appears in the list. ${c('green', '✓ Done.')} Pin the icon to the toolbar if you want it visible.`,
  ]
}

function prebuiltBanner(folder) {
  return [
    ``,
    c('cyan', `› Using prebuilt folder: ${folder}`),
    c('dim', '  (skip the build step — make sure this folder contains a manifest.json)'),
  ]
}

function ask(question) {
  const rl = createInterface({ input: stdin, output: stdout })
  return rl.question(question).then((a) => { rl.close(); return a.trim().toLowerCase() })
}

async function main() {
  console.log()
  console.log(c('bold', 'WhyBuy installer'))
  console.log(c('dim', '──────────────────────────────────────────────'))

  if (!nodeVersionOk()) {
    console.error(c('red', `✘ Node 18+ is required for the build step (you have ${process.version}).`))
    console.error(c('dim', '  Download: https://nodejs.org/en/download'))
    if (noBuild) {
      console.error(c('dim', '  (Continuing in --no-build mode — make sure the prebuilt folder already exists.)'))
    } else {
      exit(1)
    }
  }

  let target = 'chrome-mv3'
  if (positional) {
    target = positional
  } else if (alsoFirefox || browserArg === 'firefox') {
    target = 'firefox-mv2'
  }

  let folder
  if (pathArg) {
    folder = resolve(pathArg)
    if (!existsSync(join(folder, 'manifest.json'))) {
      console.error(c('red', `✘ ${folder} does not contain a manifest.json.`))
      console.error(c('dim', '  Pass the folder that was extracted from the release zip,'))
      console.error(c('dim', '  or omit --path to build from source.'))
      exit(2)
    }
    console.log(...prebuiltBanner(folder))
  } else {
    const r = ensureBuilt(target, { allowBuild: !noBuild })
    if (!r.built) {
      console.error(c('red', `✘ Could not build ${target}: ${r.error}`))
      console.error(c('dim', '  Re-run with --no-build and --path to point at a prebuilt folder.'))
      exit(1)
    }
    folder = r.dir
    console.log(c('green', `✔ Built ${target}`))
  }

  const preferred = browserArg || (target.startsWith('firefox') ? 'firefox' : 'chrome')

  console.log()
  console.log(c('bold', 'Install into your browser'))
  console.log(c('dim', '──────────────────────────────────────────────'))
  console.log(c('dim', `Extension folder: ${folder}`))
  console.log()
  for (const line of folderInstructions(folder, preferred)) {
    console.log(' ', line)
  }
  console.log()
  console.log(c('dim', 'Other browsers:'))
  for (const key of Object.keys(browserUrls)) {
    if (key === preferred) continue
    console.log(' ', c('dim', '•'), `${key.padEnd(8)}`, c('dim', browserUrls[key]))
  }
  console.log()
  console.log(c('dim', 'Need more detail? See INSTALL.md in this repo.'))
  console.log()

  if (noOpen) return
  if (!stdin.isTTY || !stdout.isTTY) {
    console.log(c('dim', '(skipping browser prompt — non-interactive shell)'))
    return
  }

  const ans = await ask(c('cyan', `Open ${browserUrls[preferred]} in your default browser? [Y/n] `))
  if (ans === '' || ans === 'y' || ans === 'yes') {
    const ok = openUrl(browserUrls[preferred])
    if (ok) {
      console.log(c('green', `✔ Opened ${browserUrls[preferred]}`))
    } else {
      console.log(c('yellow', `! Could not auto-open. Copy this URL into your browser:`))
      console.log(' ', c('bold', browserUrls[preferred]))
    }
  } else {
    console.log(c('dim', 'Skipped. Open the URL above manually when ready.'))
  }
}

main().catch((err) => {
  console.error(c('red', `✘ ${err?.message || err}`))
  exit(1)
})
