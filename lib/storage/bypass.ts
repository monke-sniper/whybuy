/**
 * Session-scoped bypass for the trial interceptor.
 *
 * When the user clicks "I disagree — proceed anyway" on the verdict
 * screen, we add the current site to this set. For the rest of the
 * browser session, every checkout click on that site is allowed to
 * pass through to /checkout without triggering a new trial. The user
 * gets exactly one bypass per override, but the bypass lasts for the
 * rest of the session (not just the next click) so they can browse,
 * come back, and click checkout again without seeing the trial.
 *
 * Storage: `chrome.storage.session` is shared by every tab, NOT synced,
 * and cleared when the browser closes. The bypass survives navigation,
 * page reloads and other tabs on the same site, but doesn't persist
 * across browser restarts (the user has to actively opt in via the
 * override button each session).
 *
 * NOTE: `storage.session` is only reachable from content scripts after
 * the background worker calls `enableBypassStorageForContentScripts()`
 * (the default access level is trusted contexts only). Without that
 * call every read/write below fails and the bypass would live only in
 * the page's memory.
 *
 * Reads use an in-memory cache so the synchronous click handler
 * can ask "is this site bypassed right now?" without awaiting an
 * async storage call. The cache is refreshed on startup, on every
 * override, and whenever another tab changes the stored set.
 */

const KEY = 'whybuy.bypass.v1'

interface BypassState {
  sites: string[]
}

const EMPTY: BypassState = { sites: [] }

let cache: BypassState = EMPTY
let loaded = false
let watching = false

/**
 * Called from the background worker on every start: lets content scripts
 * read and write `chrome.storage.session`. No-op where the API is
 * missing (older Chrome, Firefox).
 */
export async function enableBypassStorageForContentScripts(): Promise<void> {
  try {
    await chrome.storage.session?.setAccessLevel?.({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  } catch {
    // Unsupported: the bypass degrades to per-page memory.
  }
}

function sanitizeSites(raw: unknown): string[] {
  const sites = (raw as BypassState | undefined)?.sites
  return Array.isArray(sites) ? sites.filter((s) => typeof s === 'string' && s.length > 0) : []
}

/** Keep the sync cache current when another tab/frame changes the set. */
function watchBypass(): void {
  if (watching) return
  try {
    const onChanged = chrome.storage.onChanged
    // No onChanged (test contexts): the cache is refreshed on load/set only.
    if (!onChanged) return
    onChanged.addListener((changes, area) => {
      if (area !== 'session' || !(KEY in changes)) return
      cache = { sites: sanitizeSites(changes[KEY].newValue) }
      loaded = true
    })
    watching = true
  } catch {
    // Same: fall back to explicit refreshes.
  }
}

/**
 * Load the current bypass state from `chrome.storage.session`.
 * Idempotent — subsequent calls return the cached value. Call
 * `refreshBypass()` to force a re-read.
 */
export async function loadBypass(): Promise<BypassState> {
  try {
    watchBypass()
    const raw = (await chrome.storage.session.get(KEY))[KEY]
    cache = !raw || typeof raw !== 'object' ? EMPTY : { sites: sanitizeSites(raw) }
  } catch {
    // storage.session is unavailable in some test contexts; fall back
    // to the in-memory cache (which is the empty default).
    cache = EMPTY
  }
  loaded = true
  return cache
}

/**
 * Force a re-read from `chrome.storage.session`. Used by the content
 * script after a `setBypass()` call so the click handler's cache is
 * up to date without waiting for the next page load.
 */
export async function refreshBypass(): Promise<BypassState> {
  loaded = false
  return loadBypass()
}

/**
 * Add `site` to the bypass set. Idempotent — calling twice with the
 * same site is a no-op. Refreshes the in-memory cache before
 * returning so the next click sees the new state.
 */
export async function setBypass(site: string): Promise<void> {
  if (!site) return
  const cur = loaded ? cache : await loadBypass()
  if (cur.sites.includes(site)) {
    cache = cur
    return
  }
  const next: BypassState = { sites: [...cur.sites, site] }
  try {
    await chrome.storage.session.set({ [KEY]: next })
  } catch {}
  cache = next
}

/**
 * Synchronous check used by the click interceptor. Returns true if
 * the given site is currently in the bypass set. The cache is
 * populated by `loadBypass()` at startup; for correctness, the
 * content script should call `loadBypass()` once before installing
 * the interceptor, and `refreshBypass()` after every `setBypass()`.
 */
export function isBypassedSync(site: string): boolean {
  if (!loaded) return false
  return cache.sites.includes(site)
}

/**
 * Remove `site` from the bypass set. Exposed for tests + a future
 * "re-enable trial for this site" affordance. Not currently used
 * by the content script — the bypass is intentionally sticky for
 * the session.
 */
export async function clearBypass(site: string): Promise<void> {
  const cur = loaded ? cache : await loadBypass()
  if (!cur.sites.includes(site)) {
    cache = cur
    return
  }
  const next: BypassState = { sites: cur.sites.filter((s) => s !== site) }
  try {
    await chrome.storage.session.set({ [KEY]: next })
  } catch {}
  cache = next
}
