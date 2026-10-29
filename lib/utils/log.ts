const ENABLED = true

export function log(...args: unknown[]): void {
  if (!ENABLED) return
  console.log('[WhyBuy]', ...args)
}

export function warn(...args: unknown[]): void {
  console.warn('[WhyBuy]', ...args)
}
