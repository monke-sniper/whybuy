import { useEffect, useState } from 'react'
import { selectProvider, type AIProvider, type ByokConfig, type ByokProvider, type ProviderStatus } from '@/lib/ai/provider.ts'
import { PromptApiProvider } from '@/lib/ai/promptApi.ts'
import { BYOK, clearByokStatusCache } from '@/lib/ai/byok.ts'
import {
  loadSettings,
  saveSettings,
  defaultVoiceConfig,
  defaultSttConfig,
  type Settings,
  type DebateLength,
  type Tone,
  type VoiceConfig,
  type SttConfig,
} from '@/lib/storage/settings.ts'
import {
  loadCooldowns,
  clearAllCooldowns,
  getCooldownsBySite,
  clearCooldownsForSite,
  type CooldownEntry,
} from '@/lib/storage/cooldowns.ts'
import { loadHistory, clearHistory } from '@/lib/storage/history.ts'
import { clearDebugCalls, loadDebugCalls, type DebugCallEntry } from '@/lib/ai/debug.ts'
import type { JudgeMode, PromptDetail } from '@/lib/ai/types.ts'
import { elevenLabsUserTier, elevenLabsVoices, type Voice, DEFAULT_VOICE_ID, DEFAULT_MODEL_ID } from '@/lib/tts/elevenLabs.ts'

type StatusReport = {
  status: ProviderStatus
  provider: 'prompt-api' | 'scripted' | 'byok'
  name?: string
}

const WARMUP_KEY = 'whybuy.warmup.v1'
const WARMUP_KEY_JUDGE = 'whybuy.warmup.judge.v1'
const WARMUP_TTL_MS = 5 * 60 * 1000 // 5 min

type WarmupState = {
  provider: string
  model: string
  at: number
  durationMs: number
}

function loadWarmup(key: string): WarmupState | null {
  try {
    const raw = (typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null)
    if (!raw) return null
    const parsed = JSON.parse(raw) as WarmupState
    if (!parsed?.at || !parsed?.provider) return null
    if (Date.now() - parsed.at > WARMUP_TTL_MS) return null
    return parsed
  } catch {
    return null
  }
}

function saveWarmup(key: string, s: WarmupState | null) {
  try {
    if (typeof localStorage === 'undefined') return
    if (s) localStorage.setItem(key, JSON.stringify(s))
    else localStorage.removeItem(key)
  } catch {}
}

/**
 * Suggested judge models per provider. The first entry of each list is the
 * default. We pre-warm the chosen judge model on options save so the
 * deliberation phase is fast on first trial.
 *
 * NOTE: `gpt-oss:20b` on Ollama Cloud is the highest-quality reasoning
 * option but the OpenAI-compat streaming endpoint returns empty content
 * for it. We list it as a choice but the default is `ministral-3:8b`,
 * which streams reliably. The user can pick `gpt-oss:20b` and rely on
 * the non-streaming fallback (verdict still works, just no live
 * typewriter).
 */
const JUDGE_MODEL_PRESETS: Record<ByokProvider, { id: string; label: string; description: string }[]> = {
  'ollama-cloud': [
    { id: 'ministral-3:8b', label: 'ministral-3:8b (recommended)', description: 'Streams reliably, 8B reasoning-capable. The judge prompt asks it to write a <think>...</think> analysis before the JSON verdict.' },
    { id: 'ministral-3:3b', label: 'ministral-3:3b (fast, no think)', description: 'Smallest, fastest. Does not emit explicit think blocks but still produces good verdicts.' },
    { id: 'ministral-3:14b', label: 'ministral-3:14b', description: '14B Mistral reasoning. Slower but stronger.' },
    { id: 'gpt-oss:20b', label: 'gpt-oss:20b (no live stream)', description: 'Highest quality reasoning. Streams empty on Ollama Cloud OpenAI-compat — falls back to non-streaming. Verdict still works.' },
    { id: 'kimi-k2-thinking', label: 'kimi-k2-thinking', description: 'Moonshot Kimi with thinking mode.' },
    { id: 'qwen3-next:80b', label: 'qwen3-next:80b', description: 'Qwen3 reasoning (large).' },
  ],
  gemini: [
    { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash (default)', description: 'Fast, capable. Default for Gemini.' },
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash', description: 'Newer, with thinking support.' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (default)', description: 'Strong general reasoning.' },
  ],
  openrouter: [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'llama-3.3-70b (free)', description: 'Default for OpenRouter.' },
  ],
  ollama: [
    { id: 'qwen3:4b', label: 'qwen3:4b (local reasoning)', description: 'Local reasoning model.' },
    { id: 'llama3.2', label: 'llama3.2 (default)', description: 'Default small local model.' },
  ],
}

const PROVIDER_INFO: Array<{
  id: ByokProvider
  name: string
  description: string
  freeTier: string
  keyUrl: string
  needsKey: boolean
  defaultModel: string
}> = [
  {
    id: 'gemini',
    name: 'Google Gemini (recommended)',
    description: 'Google AI Studio. Generous free tier, very capable model.',
    freeTier: '15 RPM · 1M TPM · 1500 RPD — free',
    keyUrl: 'https://aistudio.google.com/apikey',
    needsKey: true,
    defaultModel: 'gemini-2.0-flash',
  },
  {
    id: 'groq',
    name: 'Groq',
    description: 'Blazing fast inference. Llama 3.3 70B and others.',
    freeTier: 'Free developer tier with rate limits',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
    defaultModel: 'llama-3.3-70b-versatile',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'Many free models (Llama, DeepSeek, etc.) with one API key.',
    freeTier: 'Free models with rate limits',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    description: 'Runs entirely on your machine. No key, fully private, fully free. Install Ollama then run `ollama pull llama3.2`.',
    freeTier: 'Free, on-device, no key',
    keyUrl: 'https://ollama.com/download',
    needsKey: false,
    defaultModel: 'llama3.2',
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud (free)',
    description: 'Hosted Ollama — sign in to ollama.com and grab a key. The smallest free cloud model (ministral-3:3b) runs out of the box.',
    freeTier: 'Free tier with rate limits (cloud)',
    keyUrl: 'https://ollama.com/settings/keys',
    needsKey: true,
    defaultModel: 'ministral-3:3b',
  },
]

export function Options() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [report, setReport] = useState<StatusReport | null>(null)
  const [cooldownCount, setCooldownCount] = useState(0)
  const [cooldownsBySite, setCooldownsBySite] = useState<Record<string, CooldownEntry[]>>({})
  const [historyCount, setHistoryCount] = useState(0)
  const [message, setMessage] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const [warming, setWarming] = useState(false)
  const [warmingJudge, setWarmingJudge] = useState(false)
  const [warmup, setWarmup] = useState<WarmupState | null>(null)
  const [warmupJudge, setWarmupJudge] = useState<WarmupState | null>(null)
  const [warmupAgoSec, setWarmupAgoSec] = useState(0)
  const [warmupJudgeAgoSec, setWarmupJudgeAgoSec] = useState(0)
  const [debugCalls, setDebugCalls] = useState<DebugCallEntry[]>([])
  const [expandedDebugId, setExpandedDebugId] = useState<number | null>(null)

  useEffect(() => {
    void (async () => {
      const s = await loadSettings()
      setSettings(s)
      const c = await loadCooldowns()
      setCooldownCount(Object.keys(c).length)
      setCooldownsBySite(await getCooldownsBySite())
      const h = await loadHistory()
      setHistoryCount(h.length)
      setDebugCalls(await loadDebugCalls())

      // The "active provider" status reflects what the SW would pick.
      const provider = await selectProvider(s.byok)
      const status = await (clearByokStatusCache(), provider).status()
      setReport({ status, provider: provider.kind, name: (provider as any).name })

      setWarmup(loadWarmup(WARMUP_KEY))
      setWarmupJudge(loadWarmup(WARMUP_KEY_JUDGE))
    })()
  }, [])

  // Tick the warmup counter so the user can see "warmed 12s ago".
  useEffect(() => {
    if (!warmup) return
    const t = setInterval(() => {
      setWarmupAgoSec(Math.floor((Date.now() - warmup.at) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [warmup])

  useEffect(() => {
    if (!warmupJudge) return
    const t = setInterval(() => {
      setWarmupJudgeAgoSec(Math.floor((Date.now() - warmupJudge.at) / 1000))
    }, 1000)
    return () => clearInterval(t)
  }, [warmupJudge])

  /**
   * Pre-warm the BYOK endpoint with a tiny `max_tokens: 4` request so the
   * model is loaded in the region before the first real trial. Returns the
   * duration in ms. Doesn't throw; errors are surfaced via setMessage.
   */
  const warmupByok = async (
    cfg: ByokConfig,
    opts: { modelOverride?: string; key?: 'counsel' | 'judge' } = {},
  ): Promise<number> => {
    const setWarmingFn = opts.key === 'judge' ? setWarmingJudge : setWarming
    const setWarmupFn = opts.key === 'judge' ? setWarmupJudge : setWarmup
    const setAgoFn = opts.key === 'judge' ? setWarmupJudgeAgoSec : setWarmupAgoSec
    const storageKey = opts.key === 'judge' ? WARMUP_KEY_JUDGE : WARMUP_KEY
    setWarmingFn(true)
    try {
      const t0 = Date.now()
      const p = new BYOK(cfg)
      // status() already does a `max_tokens: 1` ping. We piggyback here:
      // a real warmup needs to actually generate tokens so the model is
      // resident. Call nonStreamChat directly through the public surface.
      const model = opts.modelOverride || cfg.model || p['model']
      const baseUrl = cfg.baseUrl || (p as any).endpoint.replace(/\/chat\/completions$/, '')
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
      const r = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 4,
          stream: false,
        }),
      })
      const ms = Date.now() - t0
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        throw new Error(`warmup failed (${r.status}): ${t.slice(0, 200)}`)
      }
      const w: WarmupState = { provider: cfg.provider, model, at: Date.now(), durationMs: ms }
      setWarmupFn(w)
      saveWarmup(storageKey, w)
      setAgoFn(0)
      return ms
    } finally {
      setWarmingFn(false)
    }
  }

  const testByok = async (cfg: ByokConfig) => {
    setTesting(true)
    setMessage(null)
    try {
      const p = new BYOK(cfg)
      const status = await (clearByokStatusCache(), p).status({ fresh: true })
      if (status.kind === 'ready') {
        // Real warmup with a small token-generating request.
        const ms = await warmupByok(cfg, { key: 'counsel' })
        // Also warm the judge model if it's set differently.
        const judgeModel = cfg.judgeModel || cfg.model
        if (judgeModel && judgeModel !== cfg.model) {
          void warmupByok({ ...cfg, model: judgeModel }, { key: 'judge', modelOverride: judgeModel }).catch(() => {})
        }
        setMessage(`Connection successful · warmed in ${ms}ms — first trial will be fast.`)
      } else if (status.kind === 'needs-key') {
        setMessage('API key required.')
      } else {
        setMessage('Provider error: ' + ('reason' in status ? status.reason : 'unknown'))
      }
      return status
    } catch (e) {
      setMessage('Test failed: ' + (e instanceof Error ? e.message : String(e)))
      return { kind: 'error', reason: String(e) } as ProviderStatus
    } finally {
      setTesting(false)
    }
  }

  const updateSetting = async <K extends keyof Settings>(key: K, value: Settings[K]) => {
    if (!settings) return
    const next = { ...settings, [key]: value }
    setSettings(next)
    await saveSettings(next)
  }

  const updateByok = async (patch: Partial<ByokConfig>) => {
    if (!settings) return
    const next: Settings = {
      ...settings,
      byok: { ...(settings.byok ?? { provider: 'gemini' as const, apiKey: '' }), ...patch },
    }
    setSettings(next)
    await saveSettings(next)
    // Re-check status.
    const p = new BYOK(next.byok!)
    const status = await (clearByokStatusCache(), p).status({ fresh: true })
    setReport({ status, provider: 'byok', name: p.name })
    // Auto-warm in the background so the next trial is fast. Don't block
    // the UI on this; it can take 30-60s for cold-start on Ollama Cloud.
    if (next.byok && (next.byok.apiKey || next.byok.provider === 'ollama')) {
      void warmupByok(next.byok, { key: 'counsel' }).catch(() => {
        // Background warmup failure is non-fatal; the trial will retry.
      })
      const judgeModel = next.byok.judgeModel || next.byok.model
      if (judgeModel && judgeModel !== next.byok.model) {
        void warmupByok(next.byok, { key: 'judge', modelOverride: judgeModel }).catch(() => {})
      }
    }
    return status
  }

  const clearByok = async () => {
    if (!settings) return
    const next: Settings = { ...settings, byok: null }
    setSettings(next)
    await saveSettings(next)
    const provider = await selectProvider(null)
    const status = await (clearByokStatusCache(), provider).status()
    setReport({ status, provider: provider.kind, name: (provider as any).name })
  }

  const onAddIgnore = async () => {
    if (!settings) return
    const input = prompt('Add a domain to ignore (e.g. amazon.com):')
    if (!input) return
    const dom = input.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!dom) return
    const next = { ...settings, ignoredSites: Array.from(new Set([...settings.ignoredSites, dom])) }
    setSettings(next)
    await saveSettings(next)
  }

  const onRemoveIgnore = async (dom: string) => {
    if (!settings) return
    const next = { ...settings, ignoredSites: settings.ignoredSites.filter((d) => d !== dom) }
    setSettings(next)
    await saveSettings(next)
  }

  return (
    <div>
      <header style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 11, letterSpacing: '0.35em', textTransform: 'uppercase', color: '#c9a14a' }}>
          The Court of Restraint
        </div>
        <h1 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 42, fontWeight: 700, color: '#f7eed7', margin: '6px 0 4px' }}>
          WhyBuy Settings
        </h1>
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, margin: 0 }}>
          Configure the court. All settings are stored locally.
        </p>
      </header>

      <Section title="Active AI Provider">
        {report == null ? (
          <div style={{ color: '#e6c578' }}>Checking…</div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  background:
                    report.status.kind === 'ready'
                      ? '#7cba3f'
                      : report.status.kind === 'needs-key'
                      ? '#e6c578'
                      : '#b3384a',
                }}
              />
              <strong style={{ color: '#f7eed7' }}>
                {report.provider === 'byok' && 'BYOK'}
                {report.provider === 'prompt-api' && 'Chrome built-in AI'}
                {report.provider === 'scripted' && 'Scripted fallback'}
                {' — '}
                {report.status.kind === 'ready' && 'ready'}
                {report.status.kind === 'needs-download' && 'model not yet downloaded'}
                {report.status.kind === 'needs-key' && 'API key required'}
                {report.status.kind === 'error' && 'error'}
                {report.status.kind === 'unsupported' && 'not available'}
              </strong>
              {report.name && (
                <span style={{ fontSize: 11, color: 'rgba(247,238,215,0.55)' }}>({report.name})</span>
              )}
              {warmup && report.status.kind === 'ready' && (
                <span
                  style={{
                    fontSize: 10,
                    color: '#7cba3f',
                    padding: '2px 8px',
                    border: '1px solid rgba(124,186,63,0.45)',
                    borderRadius: 999,
                    letterSpacing: '0.05em',
                  }}
                  title={`Warmed ${warmupAgoSec}s ago (took ${warmup.durationMs}ms)`}
                >
                  ● warmed {warmupAgoSec}s ago
                </span>
              )}
              {!warmup && report.status.kind === 'ready' && (
                <span
                  style={{
                    fontSize: 10,
                    color: '#e6c578',
                    padding: '2px 8px',
                    border: '1px solid rgba(230,197,120,0.45)',
                    borderRadius: 999,
                    letterSpacing: '0.05em',
                  }}
                  title="First request will trigger a cold load on the provider side (may take 30-60s on Ollama Cloud free tier)"
                >
                  ○ cold — first trial will be slow
                </span>
              )}
              {warming && (
                <span style={{ fontSize: 10, color: '#e6c578', letterSpacing: '0.05em' }}>
                  warming…
                </span>
              )}
            </div>
            {report.status.kind === 'error' && 'reason' in report.status && (
              <div className="whybuy-card" style={{ padding: 12, fontSize: 13, color: '#f7eed7' }}>
                {report.status.reason}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title="Bring Your Own Key (BYOK)">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          Use a free hosted AI instead of Chrome's on-device model. Pick a provider, paste your key, and the court will use it for every trial.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          {PROVIDER_INFO.map((p) => {
            const isSelected = settings?.byok?.provider === p.id
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => updateByok({ provider: p.id, apiKey: settings?.byok?.apiKey ?? '', model: p.defaultModel })}
                style={{
                  textAlign: 'left',
                  padding: '12px 14px',
                  background: isSelected
                    ? 'linear-gradient(180deg, rgba(201,161,74,0.18) 0%, rgba(201,161,74,0.08) 100%)'
                    : 'rgba(247,238,215,0.04)',
                  border: `1px solid ${isSelected ? '#c9a14a' : 'rgba(201,161,74,0.25)'}`,
                  borderRadius: 6,
                  cursor: 'pointer',
                  color: '#f7eed7',
                }}
              >
                <div
                  style={{
                    fontFamily: "'Cormorant Garamond', serif",
                    fontSize: 17,
                    color: isSelected ? '#e6c578' : '#f7eed7',
                  }}
                >
                  {p.name}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(247,238,215,0.65)', marginTop: 4 }}>{p.description}</div>
                <div style={{ fontSize: 11, color: '#c9a14a', marginTop: 4, letterSpacing: '0.05em' }}>{p.freeTier}</div>
              </button>
            )
          })}
        </div>

        {settings?.byok && (
          <ByokEditor
            cfg={settings.byok}
            onChange={updateByok}
            onTest={async () => {
              if (!settings.byok) return
              await testByok(settings.byok)
            }}
            onClear={clearByok}
            testing={testing}
            message={message}
            info={PROVIDER_INFO.find((p) => p.id === settings.byok!.provider)!}
          />
        )}

        {!settings?.byok && (
          <div style={{ marginTop: 12 }}>
            <button
              type="button"
              className="whybuy-btn"
              onClick={() => updateByok({ provider: 'ollama-cloud', apiKey: '', model: 'ministral-3:3b' })}
            >
              Use Ollama Cloud (free, recommended)
            </button>
            <p style={{ fontSize: 12, color: 'rgba(247,238,215,0.5)', marginTop: 8 }}>
              Or click any provider above to start configuring.
            </p>
          </div>
        )}

        {settings?.byok && (
          <JudgeModelEditor
            cfg={settings.byok}
            onChange={updateByok}
            warming={warmingJudge}
            warmup={warmupJudge}
            warmupAgoSec={warmupJudgeAgoSec}
            onWarmJudge={async () => {
              if (!settings.byok) return
              const judgeModel = settings.byok.judgeModel || settings.byok.model
              await warmupByok(settings.byok, { key: 'judge', modelOverride: judgeModel })
            }}
          />
        )}
      </Section>

      <Section title="Debate Length">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          How many back-and-forth rounds the trial runs before the judge deliberates.
        </p>
        {settings && (
          <div style={{ display: 'flex', gap: 8 }}>
            {(['short', 'standard', 'long'] as DebateLength[]).map((opt) => (
              <ChoiceButton
                key={opt}
                active={settings.debateLength === opt}
                onClick={() => updateSetting('debateLength', opt)}
                label={opt}
                detail={opt === 'short' ? '2 rounds' : opt === 'standard' ? '3 rounds' : '4 rounds'}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Prosecution Tone">
        {settings && (
          <div style={{ display: 'flex', gap: 8 }}>
            {(['firm', 'socratic', 'sardonic'] as Tone[]).map((opt) => (
              <ChoiceButton
                key={opt}
                active={settings.tone === opt}
                onClick={() => updateSetting('tone', opt)}
                label={opt}
                detail={opt === 'firm' ? 'Direct and serious' : opt === 'socratic' ? 'Question-driven' : 'Dry and pointed'}
              />
            ))}
          </div>
        )}
      </Section>

      <Section title="Ignored Sites">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          WhyBuy will never intercept purchases on these domains.
        </p>
        {settings && settings.ignoredSites.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
            {settings.ignoredSites.map((d) => (
              <li
                key={d}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 10px',
                  background: 'rgba(247,238,215,0.04)',
                  border: '1px solid rgba(201,161,74,0.2)',
                  borderRadius: 4,
                  marginBottom: 6,
                  fontSize: 14,
                }}
              >
                <span style={{ flex: 1, color: '#f7eed7' }}>{d}</span>
                <button
                  onClick={() => onRemoveIgnore(d)}
                  style={{
                    background: 'transparent',
                    color: '#b3384a',
                    border: 'none',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="whybuy-btn-ghost whybuy-btn" onClick={onAddIgnore} style={{ background: 'transparent', color: '#e6c578' }}>
          + Add domain
        </button>
      </Section>

      <Section title="AI Behavior">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          Tune how the prosecution argues and how the judge rules. The defaults work on every model, including small non-reasoning ones.
        </p>
        {settings && (
          <>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
                Prompt detail
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <ChoiceButton
                  active={settings.promptDetail === 'minimal'}
                  onClick={() => updateSetting('promptDetail', 'minimal' as PromptDetail)}
                  label="Minimal"
                  detail="Title + price + site. Works on every model."
                />
                <ChoiceButton
                  active={settings.promptDetail === 'rich'}
                  onClick={() => updateSetting('promptDetail', 'rich' as PromptDetail)}
                  label="Rich"
                  detail="Brand + rating + prime + … Best on reasoning models."
                />
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
                Judge output
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <ChoiceButton
                  active={settings.judgeMode === 'natural'}
                  onClick={() => updateSetting('judgeMode', 'natural' as JudgeMode)}
                  label="Natural"
                  detail="A neutral paragraph weighing both arguments, ending with 'I rule in favor of the purchase.' or 'I rule in favor of restraint.' Default — works on small models."
                />
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title="AI Voice (ElevenLabs TTS)">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          Optional. Add an ElevenLabs API key to have the prosecution and judge speak out loud during the trial. The
          key is stored locally and is never logged or sent anywhere except ElevenLabs' API. Get a key at{' '}
          <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" style={{ color: '#e6c578' }}>
            elevenlabs.io/app/settings/api-keys
          </a>
          .
        </p>
        {settings && <VoiceSection
          voice={settings.voice ?? defaultVoiceConfig()}
          onChange={(v) => updateSetting('voice', v)}
        />}
      </Section>

      <Section title="AI Speech-to-Text (ElevenLabs)">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          Optional. Dictate your defense arguments into the mic during a trial — the transcript
          goes into the Composer for review before you submit. Uses the same{' '}
          <span style={{ color: '#e6c578' }}>ElevenLabs API key</span> as the Voice section above
          (Scribe v2 model, English). The key is stored locally and is never logged or sent
          anywhere except ElevenLabs' API.
        </p>
        {settings && <SttSection
          stt={settings.stt ?? defaultSttConfig()}
          voiceKeySet={!!settings.voice?.apiKey}
          onChange={(v) => updateSetting('stt', v)}
        />}
      </Section>

      <Section title="Active Cooldowns (by site)">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          Cooling-off periods are scoped per product+site. Declining a hat on Amazon does not block your eBay cart.
        </p>
        {Object.keys(cooldownsBySite).length === 0 ? (
          <div style={{ padding: 14, textAlign: 'center', color: 'rgba(247,238,215,0.5)', fontStyle: 'italic', fontSize: 13, border: '1px dashed rgba(201,161,74,0.2)', borderRadius: 6 }}>
            No active cooldowns.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {Object.entries(cooldownsBySite).map(([site, list]) => (
              <div
                key={site}
                style={{
                  background: 'rgba(247,238,215,0.04)',
                  border: '1px solid rgba(201,161,74,0.2)',
                  borderRadius: 6,
                  padding: '12px 14px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div>
                    <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 13, color: '#f7eed7' }}>{site}</div>
                    <div style={{ fontSize: 10, color: 'rgba(247,238,215,0.55)', letterSpacing: '0.1em', textTransform: 'uppercase', marginTop: 2 }}>
                      {list.length} cooldown{list.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="whybuy-btn-ghost whybuy-btn"
                    style={{ background: 'transparent', color: '#e6c578', fontSize: 11, padding: '4px 10px' }}
                    onClick={async () => {
                      if (!confirm(`Clear all cooldowns for ${site}?`)) return
                      await clearCooldownsForSite(site)
                      const fresh = await getCooldownsBySite()
                      setCooldownsBySite(fresh)
                      setCooldownCount(Object.values(fresh).reduce((s, l) => s + l.length, 0))
                    }}
                  >
                    Clear all for {site}
                  </button>
                </div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {list.map((entry) => (
                    <li
                      key={entry.product.fingerprint + entry.until}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '6px 0',
                        fontSize: 13,
                        borderTop: '1px solid rgba(201,161,74,0.1)',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0, color: '#f7eed7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={entry.groupLabel}>
                        {entry.groupLabel}
                      </div>
                      <div style={{ fontSize: 11, color: '#c9a14a' }}>
                        {Math.round(entry.confidence * 100)}% confidence
                      </div>
                      <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.65)', minWidth: 130, textAlign: 'right' }}>
                        until {new Date(entry.until).toLocaleString()}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
        {cooldownCount > 0 && (
          <div style={{ marginTop: 12 }}>
            <button
              className="whybuy-btn-ghost whybuy-btn"
              style={{ background: 'transparent', color: '#e6c578' }}
              onClick={async () => {
                if (!confirm('Clear ALL active cooldowns across every site?')) return
                await clearAllCooldowns()
                setCooldownsBySite({})
                setCooldownCount(0)
              }}
            >
              Clear all cooldowns
            </button>
          </div>
        )}
      </Section>

      <Section title="Last AI Prompts (debug)">
        <p style={{ color: 'rgba(247,238,215,0.65)', fontSize: 14, marginTop: 0 }}>
          The last 10 prompts the extension sent to the model, plus the first 2 KB of each response. Use this to verify the title and price reached the prompt.
        </p>
        {debugCalls.length === 0 ? (
          <div style={{ padding: 14, textAlign: 'center', color: 'rgba(247,238,215,0.5)', fontStyle: 'italic', fontSize: 13, border: '1px dashed rgba(201,161,74,0.2)', borderRadius: 6 }}>
            No prompts recorded yet. Run a trial to see what the AI was sent.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {debugCalls.map((c, i) => {
              const isOpen = expandedDebugId === i
              return (
                <li
                  key={`${c.ts}-${i}`}
                  style={{
                    background: 'rgba(247,238,215,0.04)',
                    border: '1px solid rgba(201,161,74,0.2)',
                    borderRadius: 6,
                    marginBottom: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedDebugId(isOpen ? null : i)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      background: 'transparent',
                      border: 'none',
                      padding: '10px 14px',
                      cursor: 'pointer',
                      color: '#f7eed7',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12 }}>
                      <span
                        style={{
                          fontSize: 9,
                          letterSpacing: '0.2em',
                          textTransform: 'uppercase',
                          color: c.kind === 'judge' ? '#1c4f7a' : '#c9a14a',
                          background: c.kind === 'judge' ? 'rgba(28,79,122,0.25)' : 'rgba(201,161,74,0.18)',
                          padding: '2px 6px',
                          borderRadius: 3,
                        }}
                      >
                        {c.kind}
                      </span>
                      {c.kind === 'judge' && c.judgeMode && (
                        <span style={{ fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(247,238,215,0.6)' }}>
                          {c.judgeMode}
                        </span>
                      )}
                      {c.kind === 'counsel' && c.detail && (
                        <span style={{ fontSize: 9, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(247,238,215,0.6)' }}>
                          {c.detail}
                        </span>
                      )}
                      <span style={{ marginLeft: 'auto', color: 'rgba(247,238,215,0.55)', fontSize: 11 }}>
                        {new Date(c.ts).toLocaleTimeString()}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'rgba(247,238,215,0.85)', marginTop: 4, fontFamily: "'JetBrains Mono', ui-monospace, monospace" }}>
                      {c.systemPrompt.slice(0, 120).replace(/\n/g, ' ')}…
                    </div>
                    {c.verdict && (
                      <div style={{ fontSize: 11, color: c.verdict.decision === 'proceed' ? '#7cba3f' : '#b3384a', marginTop: 4 }}>
                        {c.verdict.decision.toUpperCase()} @ {Math.round(c.verdict.confidence * 100)}%
                      </div>
                    )}
                  </button>
                  {isOpen && (
                    <div style={{ padding: '0 14px 14px', borderTop: '1px solid rgba(201,161,74,0.15)' }}>
                      <DebugBlock label="System prompt" body={c.systemPrompt} />
                      <DebugBlock label="User prompt" body={c.userPrompt} />
                      <DebugBlock label="Response (first 2 KB)" body={c.responseText} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {debugCalls.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <button
              className="whybuy-btn-ghost whybuy-btn"
              style={{ background: 'transparent', color: '#e6c578' }}
              onClick={async () => {
                if (!confirm('Clear the recorded prompts?')) return
                await clearDebugCalls()
                setDebugCalls([])
              }}
            >
              Clear recorded prompts
            </button>
          </div>
        )}
      </Section>

      <Section title="Local Data">
        <Row label="Trials in history" value={String(historyCount)} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <button
            className="whybuy-btn-ghost whybuy-btn"
            style={{ background: 'transparent', color: '#e6c578' }}
            onClick={async () => {
              if (!confirm('Clear all trial history? This cannot be undone.')) return
              await clearHistory()
              const h = await loadHistory()
              setHistoryCount(h.length)
            }}
          >
            Clear history
          </button>
        </div>
      </Section>

      <Section title="Privacy">
        <ul style={{ color: 'rgba(247,238,215,0.75)', fontSize: 14, lineHeight: 1.6, paddingLeft: 18, margin: 0 }}>
          <li>Chrome's built-in Prompt API runs on-device — nothing leaves your machine.</li>
          <li>If you supply a BYOK key, requests go directly to that provider. We never proxy them.</li>
          <li>No telemetry, no analytics, no remote calls from this extension.</li>
          <li>Trial history and cooldowns are stored in <code style={{ color: '#e6c578' }}>chrome.storage.local</code>.</li>
          <li>The <code style={{ color: '#e6c578' }}>&lt;all_urls&gt;</code> host permission is required for the universal purchase heuristic; the extension reads only the product page (title, price, image), never form inputs.</li>
        </ul>
      </Section>
    </div>
  )
}

function ByokEditor({
  cfg,
  onChange,
  onTest,
  onClear,
  testing,
  message,
  info,
}: {
  cfg: ByokConfig
  onChange: (patch: Partial<ByokConfig>) => void
  onTest: () => void
  onClear: () => void
  testing: boolean
  message: string | null
  info: typeof PROVIDER_INFO[number]
}) {
  return (
    <div className="whybuy-card" style={{ padding: 16, marginTop: 8 }}>
      <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
        {info.name}
      </div>
      {info.needsKey ? (
        <>
          <label style={{ display: 'block', fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 4 }}>
            API key
          </label>
          <input
            type="password"
            value={cfg.apiKey ?? ''}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="Paste your key here"
            autoComplete="off"
            spellCheck={false}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'rgba(247,238,215,0.05)',
              border: '1px solid rgba(201,161,74,0.35)',
              borderRadius: 6,
              color: '#f7eed7',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 13,
              marginBottom: 10,
              outline: 'none',
            }}
          />
          <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.55)', marginBottom: 12 }}>
            Get a free key at <a href={info.keyUrl} target="_blank" rel="noreferrer" style={{ color: '#c9a14a' }}>{info.keyUrl}</a>
          </div>
        </>
      ) : (
        <div style={{ fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 12 }}>
          No key needed. Make sure Ollama is running locally (<code style={{ color: '#e6c578' }}>ollama serve</code>).
        </div>
      )}

      {cfg.provider === 'ollama' && (
        <>
          <label style={{ display: 'block', fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 4 }}>
            Ollama base URL
          </label>
          <input
            type="text"
            value={cfg.baseUrl ?? 'http://localhost:11434/v1'}
            onChange={(e) => onChange({ baseUrl: e.target.value })}
            style={{
              width: '100%',
              padding: '10px 12px',
              background: 'rgba(247,238,215,0.05)',
              border: '1px solid rgba(201,161,74,0.35)',
              borderRadius: 6,
              color: '#f7eed7',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              fontSize: 13,
              marginBottom: 10,
              outline: 'none',
            }}
          />
        </>
      )}

      <label style={{ display: 'block', fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 4 }}>
        Model (leave blank for default)
      </label>
      <input
        type="text"
        value={cfg.model ?? ''}
        onChange={(e) => onChange({ model: e.target.value || undefined })}
        placeholder={info.defaultModel}
        style={{
          width: '100%',
          padding: '10px 12px',
          background: 'rgba(247,238,215,0.05)',
          border: '1px solid rgba(201,161,74,0.35)',
          borderRadius: 6,
          color: '#f7eed7',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 13,
          marginBottom: 14,
          outline: 'none',
        }}
      />

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="whybuy-btn"
          onClick={onTest}
          disabled={testing}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="whybuy-btn-ghost whybuy-btn"
          style={{ background: 'transparent', color: '#e6c578' }}
          onClick={onClear}
        >
          Use Chrome AI instead
        </button>
      </div>
      {message && (
        <div style={{ marginTop: 10, fontSize: 13, color: '#e6c578' }}>{message}</div>
      )}
    </div>
  )
}

/**
 * Pick a separate model for the judge. Defaults to the counsel model
 * when `cfg.judgeModel` is empty. Reasoning-capable models (like
 * `gpt-oss:20b` on Ollama Cloud) make the deliberation phase much more
 * useful because the user can see the judge's `<think>...</think>`
 * reasoning stream live.
 */
function JudgeModelEditor({
  cfg,
  onChange,
  warming,
  warmup,
  warmupAgoSec,
  onWarmJudge,
}: {
  cfg: ByokConfig
  onChange: (patch: Partial<ByokConfig>) => void
  warming: boolean
  warmup: WarmupState | null
  warmupAgoSec: number
  onWarmJudge: () => void | Promise<void>
}) {
  const presets = JUDGE_MODEL_PRESETS[cfg.provider] ?? []
  const current = cfg.judgeModel || cfg.model || ''
  const customActive = !presets.some((p) => p.id === cfg.judgeModel)

  return (
    <div className="whybuy-card" style={{ padding: 16, marginTop: 14 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: '0.2em',
          textTransform: 'uppercase',
          color: '#c9a14a',
          marginBottom: 4,
        }}
      >
        Judge Model
      </div>
      <div style={{ fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 10 }}>
        The judge can use a different model from the prosecution. Defaults to the counsel model. Both the prosecution and the judge write a short paragraph weighing the case — the judge's ruling appears on the verdict card.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
        {presets.map((p) => {
          const isActive = (cfg.judgeModel || cfg.model) === p.id
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onChange({ judgeModel: p.id })}
              style={{
                textAlign: 'left',
                padding: '8px 10px',
                background: isActive
                  ? 'linear-gradient(180deg, rgba(201,161,74,0.18) 0%, rgba(201,161,74,0.08) 100%)'
                  : 'rgba(247,238,215,0.04)',
                border: `1px solid ${isActive ? '#c9a14a' : 'rgba(201,161,74,0.2)'}`,
                borderRadius: 5,
                cursor: 'pointer',
                color: '#f7eed7',
              }}
            >
              <div style={{ fontFamily: "'JetBrains Mono', ui-monospace, monospace", fontSize: 12, color: isActive ? '#e6c578' : '#f7eed7' }}>
                {p.label}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(247,238,215,0.55)', marginTop: 3, lineHeight: 1.4 }}>
                {p.description}
              </div>
            </button>
          )
        })}
      </div>

      <label style={{ display: 'block', fontSize: 12, color: 'rgba(247,238,215,0.65)', marginBottom: 4 }}>
        Custom judge model
      </label>
      <input
        type="text"
        value={cfg.judgeModel ?? ''}
        onChange={(e) => onChange({ judgeModel: e.target.value || undefined })}
        placeholder={cfg.model || '(same as counsel model)'}
        style={{
          width: '100%',
          padding: '8px 10px',
          background: 'rgba(247,238,215,0.05)',
          border: `1px solid ${customActive && cfg.judgeModel ? '#c9a14a' : 'rgba(201,161,74,0.35)'}`,
          borderRadius: 5,
          color: '#f7eed7',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 12,
          marginBottom: 10,
          outline: 'none',
        }}
      />
      <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.5)', marginBottom: 12 }}>
        Currently using: <code style={{ color: '#e6c578' }}>{current || '(not set — falls back to counsel model)'}</code>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="whybuy-btn-ghost whybuy-btn"
          style={{ background: 'transparent', color: '#e6c578' }}
          onClick={onWarmJudge}
          disabled={warming || !current}
        >
          {warming ? 'Warming judge…' : 'Warm judge model'}
        </button>
        {warmup && (
          <span
            style={{
              fontSize: 10,
              color: '#7cba3f',
              padding: '2px 8px',
              border: '1px solid rgba(124,186,63,0.45)',
              borderRadius: 999,
              letterSpacing: '0.05em',
            }}
            title={`Judge warmed ${warmupAgoSec}s ago (took ${warmup.durationMs}ms)`}
          >
            ● judge warmed {warmupAgoSec}s ago
          </span>
        )}
        {!warmup && current && (
          <span
            style={{
              fontSize: 10,
              color: '#e6c578',
              padding: '2px 8px',
              border: '1px solid rgba(230,197,120,0.45)',
              borderRadius: 999,
              letterSpacing: '0.05em',
            }}
            title="Judge model not yet warmed — first deliberation will be slow"
          >
            ○ judge cold
          </span>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32, padding: '20px 22px', background: 'rgba(247,238,215,0.03)', border: '1px solid rgba(201,161,74,0.2)', borderRadius: 8 }}>
      <h2 style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 22, color: '#e6c578', margin: '0 0 12px' }}>{title}</h2>
      {children}
    </section>
  )
}

function ChoiceButton({ active, onClick, label, detail }: { active: boolean; onClick: () => void; label: string; detail: string }) {
  return (
    <button
      onClick={onClick}
      type="button"
      style={{
        flex: 1,
        padding: '12px 14px',
        textAlign: 'left',
        background: active ? 'linear-gradient(180deg, rgba(201,161,74,0.18) 0%, rgba(201,161,74,0.08) 100%)' : 'rgba(247,238,215,0.04)',
        border: `1px solid ${active ? '#c9a14a' : 'rgba(201,161,74,0.25)'}`,
        borderRadius: 6,
        cursor: 'pointer',
        color: '#f7eed7',
      }}
    >
      <div style={{ fontFamily: "'Cormorant Garamond', serif", fontSize: 17, textTransform: 'capitalize' }}>{label}</div>
      <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.6)', marginTop: 2 }}>{detail}</div>
    </button>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid rgba(201,161,74,0.12)', fontSize: 14 }}>
      <span style={{ color: 'rgba(247,238,215,0.7)' }}>{label}</span>
      <span style={{ color: '#f7eed7', fontWeight: 600 }}>{value}</span>
    </div>
  )
}

/**
 * A pre-formatted block for the debug panel. Renders the prompt or
 * response in a scrollable monospace box so the user can verify what
 * the model was actually sent.
 */
function DebugBlock({ label, body }: { label: string; body: string }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 10, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(201,161,74,0.7)', marginBottom: 4 }}>
        {label}
      </div>
      <pre
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11,
          lineHeight: 1.5,
          color: 'rgba(247,238,215,0.85)',
          background: 'rgba(15, 8, 4, 0.4)',
          border: '1px solid rgba(201,161,74,0.18)',
          borderRadius: 4,
          padding: '8px 12px',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 280,
          overflowY: 'auto',
          margin: 0,
        }}
      >
        {body || '(empty)'}
      </pre>
    </div>
  )
}

/**
 * Voice section. Manages the ElevenLabs TTS config: API key, voice,
 * model, and volume. Mirrors the trial's VoiceButton behavior
 * (the mute state is shared). API key is stored as a local-only
 * chrome.storage field; never logged.
 */
function VoiceSection({
  voice,
  onChange,
}: {
  voice: VoiceConfig
  onChange: (v: VoiceConfig) => void
}) {
  const [showKey, setShowKey] = useState(false)
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [testMessage, setTestMessage] = useState<string>('')
  const [voices, setVoices] = useState<Voice[] | null>(null)
  const [voicesErr, setVoicesErr] = useState<string>('')

  // Load the user's ElevenLabs voice list when the key changes
  // (and is non-empty). Used to populate the voice picker.
  useEffect(() => {
    let cancelled = false
    if (!voice.apiKey) {
      setVoices(null)
      setVoicesErr('')
      return
    }
    setVoicesErr('')
    elevenLabsVoices(voice.apiKey)
      .then((v) => {
        if (cancelled) return
        setVoices(v)
        if (v.length === 0) setVoicesErr('No voices returned by ElevenLabs. The key may be wrong.')
      })
      .catch((e) => {
        if (cancelled) return
        setVoicesErr(e?.message ?? 'Failed to load voices')
      })
    return () => {
      cancelled = true
    }
  }, [voice.apiKey])

  const updateKey = (next: string) => {
    // Trim whitespace. We don't validate format — ElevenLabs will
    // tell us when we Test. An empty key disables voice.
    onChange({ ...voice, apiKey: next.trim() })
    setTestStatus('idle')
    setTestMessage('')
  }

  const test = async () => {
    if (!voice.apiKey) return
    setTestStatus('testing')
    setTestMessage('')
    const tier = await elevenLabsUserTier(voice.apiKey)
    if (tier) {
      setTestStatus('ok')
      setTestMessage(`Connected to ElevenLabs — tier: ${tier}. Voice is ready.`)
    } else {
      setTestStatus('fail')
      setTestMessage('Could not connect to ElevenLabs with that key. Check the value and try again.')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Master enable toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          id="voice-enabled"
          type="checkbox"
          checked={voice.enabled}
          onChange={(e) => onChange({ ...voice, enabled: e.target.checked })}
          style={{ width: 18, height: 18, accentColor: '#c9a14a', cursor: 'pointer' }}
        />
        <label htmlFor="voice-enabled" style={{ fontSize: 14, color: '#f7eed7', cursor: 'pointer' }}>
          Enable AI voice during the trial
        </label>
      </div>

      {/* API key input */}
      <div>
        <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
          ElevenLabs API Key
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={voice.apiKey}
            onChange={(e) => updateKey(e.target.value)}
            placeholder="xi-api-key (paste from ElevenLabs dashboard)"
            autoComplete="off"
            spellCheck={false}
            style={{
              flex: 1,
              padding: '8px 10px',
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 12,
              background: 'rgba(15, 8, 4, 0.5)',
              border: '1px solid rgba(201,161,74,0.4)',
              borderRadius: 4,
              color: '#f7eed7',
            }}
          />
          <button
            type="button"
            onClick={() => setShowKey((s) => !s)}
            style={{
              padding: '8px 12px',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              background: 'transparent',
              border: '1px solid rgba(201,161,74,0.3)',
              color: '#e6c578',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {showKey ? 'Hide' : 'Show'}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={!voice.apiKey || testStatus === 'testing'}
            style={{
              padding: '8px 14px',
              fontSize: 11,
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              background: voice.apiKey ? 'rgba(201,161,74,0.18)' : 'rgba(247,238,215,0.05)',
              border: `1px solid ${voice.apiKey ? 'rgba(201,161,74,0.7)' : 'rgba(201,161,74,0.2)'}`,
              color: voice.apiKey ? '#e6c578' : 'rgba(247,238,215,0.4)',
              borderRadius: 4,
              cursor: voice.apiKey && testStatus !== 'testing' ? 'pointer' : 'not-allowed',
            }}
          >
            {testStatus === 'testing' ? 'Testing…' : 'Test'}
          </button>
        </div>
        {testStatus !== 'idle' && (
          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              color: testStatus === 'ok' ? '#7ec07e' : testStatus === 'fail' ? '#e08484' : '#e6c578',
            }}
          >
            {testMessage}
          </div>
        )}
      </div>

      {/* Voice + model pickers */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
            Voice
          </div>
          <select
            value={voice.voiceId}
            onChange={(e) => onChange({ ...voice, voiceId: e.target.value })}
            disabled={!voices || voices.length === 0}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              background: 'rgba(15, 8, 4, 0.5)',
              border: '1px solid rgba(201,161,74,0.4)',
              borderRadius: 4,
              color: '#f7eed7',
              cursor: voices && voices.length > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            {voices && voices.length > 0 ? (
              voices.map((v) => (
                <option key={v.voice_id} value={v.voice_id}>
                  {v.name}
                  {v.category ? ` — ${v.category}` : ''}
                  {v.labels?.accent ? ` (${v.labels.accent})` : ''}
                </option>
              ))
            ) : (
              <option value={voice.voiceId || DEFAULT_VOICE_ID}>
                {voicesErr || 'Add an API key and click Test to load voices'}
              </option>
            )}
          </select>
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
            Model
          </div>
          <select
            value={voice.modelId}
            onChange={(e) => onChange({ ...voice, modelId: e.target.value })}
            style={{
              width: '100%',
              padding: '8px 10px',
              fontSize: 13,
              background: 'rgba(15, 8, 4, 0.5)',
              border: '1px solid rgba(201,161,74,0.4)',
              borderRadius: 4,
              color: '#f7eed7',
            }}
          >
            <option value="eleven_turbo_v2_5">Eleven Turbo v2.5 — English, lowest latency</option>
            <option value="eleven_flash_v2_5">Eleven Flash v2.5 — 50% cheaper, slightly lower quality</option>
            <option value="eleven_multilingual_v2">Eleven Multilingual v2 — supports 29 languages</option>
          </select>
        </div>
      </div>

      {/* Volume + mute */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <input
          id="voice-mute"
          type="checkbox"
          checked={voice.muted}
          onChange={(e) => onChange({ ...voice, muted: e.target.checked })}
          style={{ width: 18, height: 18, accentColor: '#c9a14a', cursor: 'pointer' }}
        />
        <label htmlFor="voice-mute" style={{ fontSize: 13, color: '#f7eed7', cursor: 'pointer' }}>
          Mute by default (toggle from the speaker button during a trial)
        </label>
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
          <span>Volume</span>
          <span>{Math.round(voice.volume * 100)}%</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round(voice.volume * 100)}
          onChange={(e) => onChange({ ...voice, volume: Number(e.target.value) / 100 })}
          style={{ width: '100%', accentColor: '#c9a14a' }}
        />
      </div>

      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
          <span>Voice speed</span>
          <span>{voice.playbackRate.toFixed(2)}x</span>
        </div>
        <input
          type="range"
          min={50}
          max={200}
          value={Math.round(voice.playbackRate * 100)}
          onChange={(e) => onChange({ ...voice, playbackRate: Number(e.target.value) / 100 })}
          style={{ width: '100%', accentColor: '#c9a14a' }}
        />
        <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.5)', marginTop: 4, lineHeight: 1.5 }}>
          1.0x is normal speed. 1.5x (default) is faster — combines Web Audio playback rate with ElevenLabs native speed. Higher values sound chipmunk-y; 1.0–1.5x is the sweet spot.
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.5)', lineHeight: 1.5 }}>
        Voice is rate-limited at ~10 requests/minute on the free ElevenLabs tier. Each sentence the AI speaks
        counts as one request, so a full trial typically uses 4–10 requests.
      </div>
    </div>
  )
}

function SttSection({
  stt,
  voiceKeySet,
  onChange,
}: {
  stt: SttConfig
  voiceKeySet: boolean
  onChange: (v: SttConfig) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Master enable toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          id="stt-enabled"
          type="checkbox"
          checked={stt.enabled}
          onChange={(e) => onChange({ ...stt, enabled: e.target.checked })}
          style={{ width: 18, height: 18, accentColor: '#c9a14a', cursor: 'pointer' }}
        />
        <label htmlFor="stt-enabled" style={{ fontSize: 14, color: '#f7eed7', cursor: 'pointer' }}>
          Enable mic dictation during the trial
        </label>
      </div>

      {/* Model picker */}
      <div style={{ flex: '1 1 200px' }}>
        <div style={{ fontSize: 11, letterSpacing: '0.2em', textTransform: 'uppercase', color: '#c9a14a', marginBottom: 6 }}>
          Scribe model
        </div>
        <select
          value={stt.modelId}
          onChange={(e) => onChange({ ...stt, modelId: e.target.value as SttConfig['modelId'] })}
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            background: 'rgba(15, 8, 4, 0.5)',
            border: '1px solid rgba(201,161,74,0.4)',
            borderRadius: 4,
            color: '#f7eed7',
            cursor: 'pointer',
          }}
        >
          <option value="scribe_v2">Scribe v2 — best quality (default)</option>
          <option value="scribe_v1">Scribe v1 — older, cheaper</option>
        </select>
      </div>

      {!voiceKeySet && (
        <div
          style={{
            background: 'rgba(201,161,74,0.08)',
            border: '1px solid rgba(201,161,74,0.3)',
            borderRadius: 6,
            padding: '10px 12px',
            fontSize: 12,
            color: 'rgba(247,238,215,0.8)',
            lineHeight: 1.5,
          }}
        >
          <strong style={{ color: '#e6c578' }}>Heads up:</strong> STT needs an ElevenLabs API key
          to be set in the AI Voice section above. Add one there first, then come back and enable
          STT.
        </div>
      )}

      <div style={{ fontSize: 11, color: 'rgba(247,238,215,0.5)', lineHeight: 1.5 }}>
        How it works: click the mic in the Composer, speak, click again to stop. Your speech is
        sent to ElevenLabs Scribe, the transcript appears in the Composer for you to review, and
        you press Submit to send it to the AI. Audio is held only for the duration of the request.
        Each request costs ~1 second of audio at the Scribe v2 rate.
      </div>
    </div>
  )
}
