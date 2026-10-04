/**
 * In-flight AI requests, grouped per connected port (one per trial tab)
 * and keyed by requestId, with their AbortControllers.
 *
 * Scoping by port means a port disconnecting (tab closed) aborts only
 * its own requests, and two tabs that happen to use the same requestId
 * can never cancel each other.
 */
export class InflightRegistry<P extends object> {
  private byPort = new WeakMap<P, Map<string, AbortController>>()
  private anonymousSeq = 0

  private mapFor(port: P): Map<string, AbortController> {
    let m = this.byPort.get(port)
    if (!m) {
      m = new Map()
      this.byPort.set(port, m)
    }
    return m
  }

  /**
   * Track a request. A request without an id still gets an entry so a
   * port disconnect aborts it. Returns the key to pass to `release`.
   */
  register(port: P, requestId: string | undefined, ctrl: AbortController): string {
    const key = requestId ?? `anon-${++this.anonymousSeq}`
    this.mapFor(port).set(key, ctrl)
    return key
  }

  /**
   * Forget a finished request. Only removes the entry if it is still
   * `ctrl`'s, so a late finish of an old request that reused an id can
   * never drop the newer request's entry.
   */
  release(port: P, key: string, ctrl: AbortController): void {
    const m = this.byPort.get(port)
    if (m?.get(key) === ctrl) m.delete(key)
  }

  /** Abort one request. Returns false if this port has no such request. */
  cancel(port: P, requestId: string): boolean {
    const m = this.byPort.get(port)
    const ctrl = m?.get(requestId)
    if (!m || !ctrl) return false
    try { ctrl.abort() } catch {}
    m.delete(requestId)
    return true
  }

  /** Abort every request that belongs to `port`. */
  abortAll(port: P): void {
    const m = this.byPort.get(port)
    if (!m) return
    for (const ctrl of m.values()) {
      try { ctrl.abort() } catch {}
    }
    m.clear()
  }
}
