---
title: Firebase Functions Adapter — Test Plan
status: complete
author: tester
---

# Test Plan

## Unit Tests

### `test/unit/firebase-params.test.ts`

Tests `generateFirebaseParamsModule` from `src/firebase-params.ts`:
- Empty secrets + params produces no-op module
- Secrets-only produces correct `defineSecret` imports/exports
- Params-only produces correct `defineString`/`defineInt`/`defineBoolean` calls with defaults
- Mixed secrets + params produces both sections with correct import list
- Duplicate secrets each generate a line (dedup happens in `adapter.ts`)
- Param description included in options when provided
- Options object omitted when param has no default or description
- Only the needed `define*` functions are imported

### `test/unit/runtime-template.test.ts`

Tests `generateFunctionsEntry` from `src/runtime-template.ts`:
- No secrets produces `secrets: []` and no firebase-params require
- Secrets produce correct destructure line and secrets array
- Params appear in destructure but NOT in secrets array
- Mixed secrets + params: all in destructure, only secrets in array
- `__dirname` used for `next()` dir option
- Function name read dynamically from manifest
- Init error handling (`_initErr`) present
- Manifest config spread into function opts
- Default values for timeoutSeconds, memory, etc.

### `test/unit/env-file.test.ts`

Tests `.env` file handling (via `runOnBuildComplete`):
- Inline `env` object writes correct KEY=VALUE to output `.env`
- `envFilePath` reads and copies file contents
- Inline `env` takes precedence over `envFilePath` for duplicate keys
- No env options means no `.env` file written
- Empty `env: {}` means no `.env` file written
- Missing `envFilePath` throws descriptive error

## Running Unit Tests

```bash
cd adapter-firebase-functions
npx tsx --test test/unit/*.test.ts
```

Or with Node.js built-in loader (requires `--loader tsx` or `ts-node/esm`):

```bash
node --loader tsx --test test/unit/*.test.ts
```

## E2E Scripts

### `scripts/e2e-deploy.sh`

Follows the Next.js adapter test harness contract ([[research-nextjs-test-harness]], [[research-bun-adapter-patterns]]):
1. Packs adapter as tarball, injects into fixture `package.json`
2. Sets `NEXT_ADAPTER_PATH`, `NEXT_DEPLOYMENT_ID`, `IMMUTABLE_ASSET_TOKEN`
3. Runs `npm run build`
4. Installs dependencies in `firebase-dist/functions/`
5. Starts Firebase emulator on a random port
6. Polls for TCP readiness
7. Outputs function URL on stdout (only output)

### `scripts/e2e-logs.sh`

Emits BUILD_ID, DEPLOYMENT_ID, IMMUTABLE_ASSET_TOKEN markers first, then dumps log files.

### `scripts/e2e-cleanup.sh`

Kills emulator process from PID file (graceful SIGTERM, then SIGKILL after 5s). Falls back to `lsof` port kill.

## Running E2E Locally

```bash
cd /path/to/test-app
ADAPTER_DIR=/path/to/adapter-firebase-functions \
NEXT_TEST_DIR=$(pwd) \
  /path/to/adapter-firebase-functions/scripts/e2e-deploy.sh
```

## Fixture App

`fixtures/basic-app/` — minimal Next.js app with adapter wired in:
- `next.config.ts` sets `adapterPath`
- `app/page.tsx` renders "Hello from Firebase Functions"

## Next.js Starter Fixture (Dynamic)

`scripts/e2e-deploy-starter.sh` scaffolds a fresh `create-next-app` project dynamically:
- Uses `npx create-next-app@latest` with TypeScript, App Router, Tailwind, ESLint, src dir
- Injects adapter as dependency and overwrites `next.config.ts`
- Validates adapter works with real-world app structure: image optimization, fonts, etc.
- Reuses the same emulator startup pattern as `e2e-deploy.sh`
- If `NEXT_TEST_DIR` is not set, creates a temp directory automatically

Run standalone:
```bash
ADAPTER_DIR=/path/to/adapter-firebase-functions \
  /path/to/adapter-firebase-functions/scripts/e2e-deploy-starter.sh
```

## Official Next.js Test Suite (TODO)

`test/deploy-tests-manifest.adapter-firebase.json` lists the supported tests. To run the full harness:

```bash
NEXT_TEST_DEPLOY_SCRIPT_PATH=scripts/e2e-deploy.sh \
NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH=scripts/e2e-logs.sh \
NEXT_TEST_CLEANUP_SCRIPT_PATH=scripts/e2e-cleanup.sh \
node run-tests.js --type=e2e
```

**TODO**: Add GitHub Actions CI workflow to automate this in PRs.

## Known Limitations

- E2E scripts require `firebase-tools` installed globally (`npm i -g firebase-tools`)
- Emulator requires Java runtime (JRE 11+ / CI uses JDK 17)
- Firebase project `my-firebase-project` is hardcoded in deploy script
- Parallel test shards each start their own emulator on a random port
- **No edge runtime**: Firebase Functions runs on Node.js only
- **No ISR on-demand revalidation**: requires cache backend not yet implemented
- **Cache tags**: exposed via the `cacheTags` option (App Router pages only — Route Handlers
  have no `onCacheEntry` hook in Next.js 16); purging the CDN is left to the caller
- **Emulator timeout**: emulator cold start is 5-15s; 4-minute test timeout is sufficient but tight for large fixtures

## See Also

- [[research-firebase-testing]]
- [[research-bun-adapter-patterns]]
- [[research-nextjs-test-harness]]
- [[implementation-plan]]
