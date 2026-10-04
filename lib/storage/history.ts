import type { Cart, TrialRecord } from '../ai/types'

const KEY = 'whybuy.history.v1'

export async function loadHistory(): Promise<TrialRecord[]> {
  const raw = (await chrome.storage.local.get(KEY))[KEY]
  if (!Array.isArray(raw)) return []
  return raw as TrialRecord[]
}

export async function appendHistory(record: TrialRecord): Promise<void> {
  const all = await loadHistory()
  all.unshift(record)
  // Cap to last 200 to keep storage reasonable.
  const trimmed = all.slice(0, 200)
  await chrome.storage.local.set({ [KEY]: trimmed })
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(KEY)
}

export interface HistoryStats {
  trials: number
  abandoned: number
  proceeded: number
  savedAmount: number
  /** Currency code if all prices share one, else 'MIXED'. */
  currency: string | null
}

export async function computeStats(): Promise<HistoryStats> {
  const all = await loadHistory()
  let abandoned = 0
  let proceeded = 0
  let savedAmount = 0
  let currency: string | null = null
  for (const t of all) {
    const amount = t.cart ? t.cart.total : t.product.price
    const cur = t.cart ? t.cart.currency : t.product.currency
    // Only an accepted ruling saves money. An override means the user
    // went ahead and bought anyway, so it counts as proceeded.
    if (t.outcome === 'accepted-abandon') {
      abandoned++
      if (amount != null) savedAmount += amount
    } else {
      proceeded++
    }
    if (cur) {
      if (currency == null) currency = cur
      else if (currency !== cur) currency = 'MIXED'
    }
  }
  return {
    trials: all.length,
    abandoned,
    proceeded,
    savedAmount,
    currency,
  }
}
