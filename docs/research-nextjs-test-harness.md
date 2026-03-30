---
title: Next.js Deploy Test Harness Contract
status: complete
author: researcher
---

# Next.js Deploy Test Harness Contract

The `NEXT_TEST_MODE=deploy` harness in `vercel/next.js` drives adapter e2e tests. This doc covers the exact contract our three scripts must fulfill.

See also: [[research-bun-adapter-patterns]] for bun's implementation, [[research-firebase-testing]] for Firebase-specific details.

---

## The Three Script Environment Variables

| Variable | Points to | Called how |
|---|---|---|
| `NEXT_TEST_DEPLOY_SCRIPT_PATH` | `scripts/e2e-deploy.sh` | Once per test, blocking |
| `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` | `scripts/e2e-logs.sh` | On failure/debug |
| `NEXT_TEST_CLEANUP_SCRIPT_PATH` | `scripts/e2e-cleanup.sh` | After each test |

These must be absolute paths to executable shell scripts.

---

## Deploy Script Contract (`NEXT_TEST_DEPLOY_SCRIPT_PATH`)

### Input — environment variables set by harness

| Variable | Value |
|---|---|
| `NEXT_TEST_DIR` | Absolute path to the fixture's temp working directory |
| `NEXT_TEST_MODE` | `"deploy"` |
| `NEXT_PRIVATE_TEST_MODE` | Should mirror `NEXT_TEST_MODE` (set this in your script if not set) |
| `IS_TURBOPACK_TEST` | `"1"` if turbopack |
| `NEXT_TEST_JOB` | `"1"` in CI |

The harness also writes a `package.json` into `NEXT_TEST_DIR` with a `scripts.build` entry before calling the deploy script.

### What the script must do

1. `cd "$NEXT_TEST_DIR"`
2. Install dependencies (the adapter must be resolvable as `adapter-firebase-functions` or similar)
3. Set `NEXT_ADAPTER_PATH` to the adapter's `dist/index.js`
4. Run the build script from `package.json` (the harness wires `scripts.build`)
5. Start the server / emulator
6. Wait until the server is ready
7. **Print only the URL to stdout** — e.g. `http://127.0.0.1:5001/demo-test/us-central1/nextjsServer`

### Stdout contract

**Only one line on stdout: the deployment URL.** The harness reads stdout to get the URL it will send Playwright to. Any extra stdout will break URL parsing.

All other output (build logs, install output, debug messages) must go to **stderr** or log files.

### Build log markers

Write these to a log file (e.g., `.adapter-build.log`) so `e2e-logs.sh` can emit them:

```
BUILD_ID: <value from .next/BUILD_ID>
DEPLOYMENT_ID: <generated random ID>
IMMUTABLE_ASSET_TOKEN: <same as DEPLOYMENT_ID>
```

The harness parses these markers from the logs script output to validate caching behavior.

### NEXT_DEPLOYMENT_ID

Generate a stable deployment ID before the build and export it:

```bash
DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="firebase-adapter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
```

This must be baked into client bundles during `next build` (Next.js reads it from env).

---

## Logs Script Contract (`NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`)

### When called

Called when a test fails or when the harness needs to display build/runtime information for debugging.

### What it must output

Stdout should contain (in this order for reliable parsing):

1. **Markers first** (harness parses these with regex):
   ```
   BUILD_ID: <value>
   DEPLOYMENT_ID: <value>
   IMMUTABLE_ASSET_TOKEN: <value>
   ```

2. Then all relevant log file contents (build log, server log, Next.js trace, etc.)

### Why markers must come first

The harness uses `grep`/regex to find `BUILD_ID:` etc. from the logs output. If these appear buried in verbose build output, the parser may find wrong values from fixture scripts that also print similar keys. The bun adapter emits canonical markers at the top to ensure the harness picks the right values.

---

## Cleanup Script Contract (`NEXT_TEST_CLEANUP_SCRIPT_PATH`)

### When called

After every test (pass or fail). Must be idempotent (may be called even if deploy script failed).

### What it must do

1. Print any remaining runtime logs (before shutdown)
2. Kill the server/emulator process (read PID from `.adapter-server.pid` or similar)
3. Graceful shutdown (SIGTERM), wait up to 5s, then SIGKILL
4. Remove PID file
5. Optionally persist logs to a well-known path for post-run inspection

### Idempotency

The PID file may not exist (if deploy failed before server started). Check with `[ -f "$PID_FILE" ]` before reading.

---

## How NEXT_TEST_DIR Works

The harness creates a temp directory for each test, copies or symlinks the fixture into it, and sets `NEXT_TEST_DIR` to that path. The deploy script receives a fresh directory each test run.

The harness writes `package.json` with:
```json
{
  "scripts": {
    "build": "next build"
  }
}
```
(possibly more fields, but `scripts.build` is always present)

---

## NEXT_EXTERNAL_TESTS_FILTERS

A comma-separated list of JSON manifest files that control which tests run. The adapter provides its own manifest alongside the default Next.js one:

```bash
NEXT_EXTERNAL_TESTS_FILTERS="test/deploy-tests-manifest.json,/path/to/adapter/test/deploy-tests-manifest.adapter-firebase.json"
```

The adapter manifest specifies which test files are known-good for this adapter, filtering down from the full Next.js suite.

---

## Full Environment for Test Runner (e2e-local.sh equivalent)

```bash
NEXT_TEST_MODE=deploy \
NEXT_E2E_TEST_TIMEOUT=240000 \
NEXT_EXTERNAL_TESTS_FILTERS="test/deploy-tests-manifest.json,${ADAPTER_FIREBASE_DIR}/test/deploy-tests-manifest.adapter-firebase.json" \
NEXT_TEST_DEPLOY_SCRIPT_PATH="${ADAPTER_FIREBASE_DIR}/scripts/e2e-deploy.sh" \
NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="${ADAPTER_FIREBASE_DIR}/scripts/e2e-logs.sh" \
NEXT_TEST_CLEANUP_SCRIPT_PATH="${ADAPTER_FIREBASE_DIR}/scripts/e2e-cleanup.sh" \
ADAPTER_FIREBASE_DIR="${ADAPTER_FIREBASE_DIR}" \
NEXT_TEST_JOB=1 \
NEXT_TELEMETRY_DISABLED=1 \
node run-tests.js --test-pattern "$TEST_FILE" -c 1 --debug
```

Run from inside the cloned `vercel/next.js` repo directory.

---

## Concurrency Model

- Tests run in parallel (up to `-c N` concurrent tests)
- Each test gets its own `NEXT_TEST_DIR` (isolated temp dir)
- All tests share the adapter source (`ADAPTER_FIREBASE_DIR`)
- **The deploy script must be safe to run concurrently** — use file locks if any shared state (like packing the adapter)

### Firebase-specific parallel concern

Each parallel test needs its own emulator instance on a different port, since the Firebase emulator is a long-running process per test. Options:

1. **Random port per test** — generate a free port, pass to `firebase emulators:start`, generate a per-test `firebase.json`
2. **Single shared emulator** — harder, requires routing between tests, not recommended

Recommended: random port per test, matching the bun adapter's `PORT=$(node -e "...")` pattern.

---

## Test Timeout

`NEXT_E2E_TEST_TIMEOUT=240000` — 4 minutes per test. The deploy script + server startup must complete well within this.

Firebase emulator cold start is typically 5-15 seconds. Build time depends on fixture size.

---

## Adapter Path Resolution

The deploy script must export `NEXT_ADAPTER_PATH` pointing to the adapter's compiled entry point. Next.js reads this to load the custom adapter instead of the built-in one.

```bash
# After installing adapter as a dependency in NEXT_TEST_DIR:
export NEXT_ADAPTER_PATH="${NEXT_TEST_DIR}/node_modules/adapter-firebase-functions/dist/index.js"
```

Or if testing from source without installing:
```bash
export NEXT_ADAPTER_PATH="${ADAPTER_FIREBASE_DIR}/dist/index.js"
```

The bun adapter packs + installs as a tarball to avoid symlink issues. For Firebase adapter, same approach is recommended for accuracy.

---

## Summary: Minimal Deploy Script Skeleton

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$NEXT_TEST_DIR"

# 1. Install adapter
npm pack --json --ignore-scripts --pack-destination "$NEXT_TEST_DIR" \
  --prefix "$ADAPTER_FIREBASE_DIR" > /tmp/pack-result.json
TARBALL="$NEXT_TEST_DIR/$(node -e "console.log(JSON.parse(require('fs').readFileSync('/tmp/pack-result.json'))[0].filename)")"
node -e "
  const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
  pkg.dependencies['adapter-firebase-functions']='file:${TARBALL}';
  require('fs').writeFileSync('package.json',JSON.stringify(pkg,null,2));
"
npm install --no-package-lock >&2

# 2. Set adapter path + deployment ID
export NEXT_ADAPTER_PATH="${NEXT_TEST_DIR}/node_modules/adapter-firebase-functions/dist/index.js"
DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="firebase-adapter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"

# 3. Build
: > .adapter-build.log
npm run build 2>&1 | tee -a .adapter-build.log >&2
echo "BUILD_ID: $(cat .next/BUILD_ID 2>/dev/null || echo unknown)" >> .adapter-build.log
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> .adapter-build.log
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> .adapter-build.log

# 4. Pick port, generate firebase.json
FUNCTIONS_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")
cat > firebase.json <<EOF
{"functions":{"source":".next/standalone"},"emulators":{"functions":{"port":${FUNCTIONS_PORT},"host":"127.0.0.1"}}}
EOF

# 5. Start emulator
firebase emulators:start --only functions --project demo-nextjs-test \
  >> .adapter-server.log 2>&1 &
echo $! > .adapter-server.pid

# 6. Wait for readiness
for i in $(seq 1 30); do
  node -e "
    const s=require('net').connect({host:'127.0.0.1',port:${FUNCTIONS_PORT}});
    s.once('connect',()=>{s.destroy();process.exit(0)});
    s.once('error',()=>{s.destroy();process.exit(1)});
    setTimeout(()=>process.exit(1),750);
  " 2>/dev/null && break
  sleep 1
done

# 7. Output URL (ONLY stdout)
echo "http://127.0.0.1:${FUNCTIONS_PORT}/demo-nextjs-test/us-central1/nextjsServer"
```
