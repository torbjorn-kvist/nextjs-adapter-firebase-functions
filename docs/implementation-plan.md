---
title: Firebase Functions Adapter — Implementation Plan
status: complete
author: implementer
---

# Implementation Plan

## File List

```
adapter-firebase-functions/
  package.json
  tsconfig.json
  tsconfig.build.json
  src/
    index.ts              — re-exports + zero-config default instance
    adapter.ts            — createFirebaseAdapter, modifyConfig, onBuildComplete, runOnBuildComplete
    types.ts              — all shared types + BuildCompleteContext alias
    firebase-params.ts    — generateFirebaseParamsModule() → CJS JS string
    runtime-template.ts   — generateFunctionsEntry() → CJS JS string

docs/
  implementation-plan.md  — this file
```

## Deviations from Design Doc

### 1. `buildFunctionsPackageJson` dynamic import fix

The design doc used `await (await import('node:fs/promises')).readFile(...)` inline. The implementation uses a named `import { readFile }` via a local `const { readFile } = await import(...)` inside the try block. This avoids re-importing the already-imported `fs/promises` module at the top of the file while keeping the pattern readable. Functionally identical.

### 2. `types.ts` — extra `NextConfigComplete` re-export

Added `export type { NextConfigComplete }` at the bottom of `types.ts` to avoid a TypeScript "unused import" error under strict mode, since `NextConfigComplete` is imported at the top but only used structurally (the design doc's `BuildCompleteContext` alias pulls it in transitively via `next`'s types).

### 3. `modifyConfig` return type

Design doc shows `modifyConfig` returning `config` directly (pass-through). The implementation does exactly this — returns `config` unmodified. No `output: 'export'` guard was added since the design doc marked that as a comment/future concern.

### 4. `secretsArrayCode` in `runtime-template.ts`

The generated `secrets` array in `index.js` uses bare variable names (e.g. `[DATABASE_URL, STRIPE_KEY]`), which are the `defineSecret` return values imported from `firebase-params`. This matches the design doc's intent — these are `Secret` objects passed to `onRequest({ secrets: [...] })`, not strings.

## Testing Notes

### Unit-testable functions (no file I/O)

- `generateFirebaseParamsModule(secrets, params)` — pure string generator
  - Test: empty secrets+params → only header comment
  - Test: secrets only → only `defineSecret` imports
  - Test: params only → correct `defineString`/`defineInt`/`defineBoolean` import selection
  - Test: mixed → both blocks present, correct import list (no dupes)
  - Test: param with `default` + `description` → options object in output
  - Test: param with no options → no second argument

- `generateFunctionsEntry(secrets, params)` — pure string generator
  - Test: no bindings → no `require('./firebase-params')` destructure line
  - Test: secrets → destructure line present, `secrets: [NAME]` array correct
  - Test: params → names appear in destructure, NOT in secrets array
  - Test: mixed → all names in destructure, only secrets in secrets array

- `buildRuntimeNextConfig(config)` — strips fields, sets `distDir`
  - Test: `outputFileTracingRoot`, `cacheHandler`, `adapterPath` removed
  - Test: `experimental.adapterPath` removed
  - Test: `distDir` set to `'.next'` regardless of input

### Integration test (requires file system)

- Run `runOnBuildComplete` with a mock `BuildCompleteContext` pointing at a temp dir with a fake `.next/` directory
- Assert output structure:
  - `firebase-dist/functions/.next/` exists (copied)
  - `firebase-dist/functions/index.js` contains function name
  - `firebase-dist/functions/firebase-params.js` correct for given secrets/params
  - `firebase-dist/functions/deployment-manifest.json` has correct schemaVersion=1
  - `firebase-dist/functions/package.json` has `next` dep at correct version
  - `firebase-dist/functions/.gitignore` contains `node_modules/`
  - `firebase.json` written to projectDir (only when absent)
  - `firebase.json` NOT overwritten if already present

### Edge cases to test

- `secrets: []`, `params: {}` → `firebase-params.js` has no-op comment, `secrets: []` in index.js
- `outDir` as absolute path → resolveOutDir returns it unchanged
- `ctx.distDir` as absolute path → used directly (not joined with projectDir)
- `public/` absent → copyIfExists returns false, no error thrown
- Secret name with lowercase → warning logged but continues
- `functionName` option → appears as `exports[_functionName]` key in generated index.js (dynamic at runtime via manifest)
- `maxInstances` / `region` omitted → not present in `_functionOpts` (conditional assignment)
