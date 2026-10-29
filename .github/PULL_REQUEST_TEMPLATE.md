## Summary

<!-- What does this PR change? One or two sentences. -->

## How to test

<!-- Concrete steps a reviewer can follow to verify the change. -->
1.
2.
3.

## Checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test:unit` passes
- [ ] `npm run build` succeeds
- [ ] No real API keys, tokens, or `.env` content in the diff
- [ ] New UI is screenshotted or described inline
- [ ] If a new test fixture was added, it lives under `scripts/fixtures/` with a clear filename
- [ ] If a new e2e flow was added, it uses an isolated `userDataDir` (calls `assertIsolatedProfile()`)
- [ ] I read `CONTRIBUTING.md` and followed it
