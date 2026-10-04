# WhyBuy — Implementation Plan

## Locked-in decisions

| Topic | Choice |
|---|---|
| AI | BYOK first (Ollama Cloud, Gemini, Groq, OpenRouter, Ollama), Chrome built-in Prompt API as a fallback, scripted as last resort |
| Interception | Capture-phase click listener on a single "checkout" pattern; no URL auto-trigger |
| Debate | Fixed rounds: prosecution opening → 3 user rebuttals + 3 prosecution responses → judge |
| Verdict | Full-screen Judge Room with gavel-strike animation, then a revealed verdict card; soft block with 24-hour cooling-off override per product+domain |
| Stack | WXT + React + TypeScript + Tailwind |
| Visual | Dark mahogany, cinematic, gavel-strike animations, mini AI avatar with talking animation |
| History | Local (`chrome.storage.local`) with stats popup |
| Input | Text only |
| Default prompt detail | `minimal` (title + price + site). Rich product card behind a Settings toggle. |
| Default judge mode | `natural` (line-based ruling). |
| Cooldown scope | Per product+site. UI groups cooldowns by site in the Options page. |
| Test isolation | All e2e scripts require a tempdir `userDataDir`; non-tempdir profiles are refused unless `WHYBUY_ALLOW_REAL_PROFILE=1`. |

## Project structure

```
whybuy/
├── entrypoints/
│   ├── background.ts          service worker (AI session, port handler, debug recorder)
│   ├── content.ts            click interceptor + mounts trial overlay
│   ├── popup/                toolbar popup
│   └── options/              settings page (BYOK, judge mode, prompt detail, cooldowns, debug)
├── components/
│   ├── trial/                TrialApp, Panels, Composer, JudgeRoom, ClaudeAvatar, etc.
│   ├── popup/Popup.tsx
│   └── options/Options.tsx
├── lib/
│   ├── ai/                   types, provider, promptApi, byok, scripted, prompts, judgeParse, verdictHelpers, debug
│   ├── intercept/            selectors, product, trigger, cart
│   ├── trial/                state machine
│   ├── storage/              history, cooldowns, settings
│   ├── messaging/bus.ts
│   └── utils/                hash, log
├── public/icon/icon.svg
├── wxt.config.ts
├── tailwind.config.ts
└── tsconfig.json
```

## Provider abstraction

```ts
interface AIProvider {
  status(): Promise<ProviderStatus>
  ensureReady(onProgress?: (pct: number) => void): Promise<void>
  counselTurn(args, onChunk, signal?): Promise<string>
  judgeVerdict(args, signal?, opts?): Promise<Verdict>
}

interface JudgeCallOptions {
  judgeMode?: 'natural' | 'structured'
  detail?: 'minimal' | 'rich'
}
```

`selectProvider()` returns BYOK when configured, otherwise `PromptApiProvider` when the on-device model is ready, otherwise `ScriptedProvider`.

## AI modes

### Prompt detail (`promptDetail`)

- **`'minimal'` (default)** — the prosecution only sees:
  ```
  PRODUCT: <title>
  PRICE:  <cur> <amount>
  SITE:   <domain>
  ```
  The model uses its own world knowledge about the product. Works on every model. Use when the extraction is barebones (e.g. some Amazon.ca checkout-step pages) or when you don't want to confuse the model with brand/rating/prime noise.

- **`'rich'`** — the full structured product card (brand, rating, review count, prime, was-price, ASIN). Best for reasoning-capable models. Fields the extractor didn't populate are omitted (we never write "Brand: unknown" because that misleads the model).

### Judge output mode (`judgeMode`)

- **`'natural'` (default)** — line-based ruling format. The model emits exactly five lines, no prose:
  ```
  DECISION:   <proceed|abandon>
  CONFIDENCE: <0.00-1.00>
  REASONING:  <2-4 sentences; streamed live to the user>
  SUMMARY:    <1-2 sentence plain-English ruling>
  FACTORS:    <factor 1> | <factor 2> | <factor 3>
  ```
  Parser: `lib/ai/judgeParse.ts → parseNaturalVerdict()`. Idempotent, case-insensitive, garbage-tolerant, streams reasoning live, returns `partial: true` until all five required fields are present. Works on every model including non-reasoning ones like `ministral-3:8b` on Ollama Cloud.

- **`'structured'`** — retired. The `<think>`+JSON judge was removed because small models couldn't follow it; a stored `'structured'` value is treated as `'natural'`.

## Trigger

The trial fires on exactly one user gesture: a click on a button that literally says "Checkout" / "Proceed to checkout" / "Go to checkout" / "Continue to checkout". There is no URL auto-trigger, no "Buy Now" interception, no "Add to cart" interception, and no "Place order" interception. The user must press the checkout button.

## Trial state machine

```
intro → opening → user_1 → prosecution_1 → user_2 → prosecution_2
     → user_3 → prosecution_3 → deliberation → verdict → released | loss
```

The `deliberation` and `verdict` phases are now rendered by a dedicated `JudgeRoom` component: a full-viewport, dimmed mahogany surface with a judge mark and a gavel. The gavel raises, strikes, flashes, and then the verdict reveals with a staggered fade.

## Cooldowns

- Storage: `chrome.storage.local['whybuy.cooldowns.v1']`.
- Key: per-product fingerprint (or a stable hash of the cart's ASIN|hash + domain).
- Duration: 24 hours.
- UI: Options page groups cooldowns by `site` (e.g. `amazon.com`, `ebay.com`). "Clear all for amazon.com" is a one-click action. "Clear all" at the bottom is the nuclear option.
- Legacy entries (no `site` field) are backfilled from `product.domain` on load.

## Debug panel

`lib/ai/debug.ts` records the last 10 AI calls (system prompt + user prompt + first 2 KB of the response + verdict if applicable). Surfaced in Options → "Last AI Prompts (debug)". Use this to verify the title and price are reaching the model.

## Privacy

- BYOK providers make direct calls to the provider (no proxy). The extension stores the key in `chrome.storage.local`.
- Chrome's built-in Prompt API runs on-device.
- No telemetry, no analytics.
- The `<all_urls>` host permission is required for the universal click heuristic; the extension reads only the product page (title, price, image) and never reads form inputs.
- The "Last AI Prompts" debug panel is local — never sent anywhere.

## Test isolation

Hard guarantee: no test script may run against the user's real Chrome profile.

- All `scripts/*.mjs` e2e scripts use `mkdtempSync(join(tmpdir(), 'whybuy-…'))` for their `userDataDir` and call `assertIsolatedProfile(userDataDir)` before launching puppeteer.
- `scripts/load.mjs` (the manual loader) refuses a non-tempdir profile unless `WHYBUY_ALLOW_REAL_PROFILE=1` is set.
- `scripts/audit-isolation.mjs` is a no-leak smoke test that runs a full trial cycle in an isolated profile and walks `os.tmpdir()` afterwards to assert no `whybuy.*` files leaked outside the test profile.
- `scripts/lib/test-isolation.mjs` exports the shared `isTempProfile` / `assertIsolatedProfile` helpers.

CI (`.github/workflows/ci.yml`) runs `npm run typecheck` and `npm run test:unit` on every push. E2e tests require a real Ollama key and are not part of CI.
