---
title: Firebase Functions Emulator & Local Testing
status: complete
author: researcher
---

# Firebase Functions Emulator & Local Testing

See also: [[research-bun-adapter-patterns]] for the script contract, [[research-nextjs-test-harness]] for harness env vars.

---

## Project: `my-firebase-project`

The Firebase project for this adapter is `my-firebase-project`. All examples below use this project ID.

### Start emulator (functions only)

```bash
firebase emulators:start --only functions --project my-firebase-project
```

### Local URL format

```
http://127.0.0.1:5001/my-firebase-project/us-central1/{functionName}
```

For the Next.js adapter, the function name will be `nextjsServer` (or whatever we name the exported onRequest handler):

```
http://127.0.0.1:5001/my-firebase-project/us-central1/nextjsServer
```

### What the emulator needs

1. **`firebase.json`** — must have `functions` and `emulators` sections
2. **`functions/` directory** (or wherever `functions.source` points) containing:
   - `package.json` with `main` entry pointing to compiled function code
   - The compiled JS files (the adapter's build output)
   - `node_modules/` with all runtime dependencies

### Check if emulator is ready

**TCP probe** (preferred — matches bun adapter pattern):
```bash
node -e "
  const s = require('net').connect({host:'127.0.0.1', port:5001});
  s.once('connect', () => { s.destroy(); process.exit(0); });
  s.once('error', () => { s.destroy(); process.exit(1); });
  setTimeout(() => process.exit(1), 750);
" 2>/dev/null
```

**Emulator hub** (if hub is enabled):
```bash
curl -s http://127.0.0.1:4400/emulators  # returns JSON of running emulators
```

---

## Emulator CLI Commands

### Start functions emulator only

```bash
firebase emulators:start --only functions
```

Requires `firebase.json` with a `functions` entry, or specify emulators explicitly. The functions emulator runs on port **5001** by default.

### Start with specific project

```bash
firebase emulators:start --only functions --project my-firebase-project
```

### Run tests then exit (non-interactive)

```bash
firebase emulators:exec --only functions --project my-firebase-project "npm test"
```

This starts the emulator, runs the script, then shuts down. Good for CI when you don't need the emulator to outlive the test runner.

---

## HTTP Function URL Format

```
http://127.0.0.1:5001/{project-id}/{region}/{functionName}
```

Examples:
```
http://127.0.0.1:5001/my-firebase-project/us-central1/nextjsServer
http://127.0.0.1:5001/demo-nextjs-test/us-central1/nextjsServer
```

**For e2e scripts**: The deploy script must output this URL (only thing on stdout). The test harness will hit this URL with Playwright.

**Important**: Use `127.0.0.1` not `localhost` — the emulator binds to `127.0.0.1` and IPv6 `localhost` resolution can fail.

---

## firebase-tools Programmatic API

The `firebase-tools` npm package exposes a Node.js module API. Each CLI command maps to a function.

```javascript
const client = require('firebase-tools');

// Equivalent to: firebase --project="foo" apps:list ANDROID
client.apps.list("ANDROID", { project: "foo" }).then(data => { ... });
```

### Starting emulators programmatically

```javascript
const client = require('firebase-tools');

await client['emulators:start']({
  only: 'functions',
  project: 'my-firebase-project',
  // Note: this is a long-running process — it won't resolve until the emulator stops
});
```

**Practical recommendation for e2e scripts**: Use the CLI directly in a shell script (`firebase emulators:start &`) rather than the programmatic API. This is simpler, more debuggable, and matches how the bun adapter does things (shell script, background process, PID file).

---

## `firebase.json` Minimum Config for Functions Emulator

```json
{
  "functions": {
    "source": ".",
    "runtime": "nodejs20"
  },
  "emulators": {
    "functions": {
      "port": 5001,
      "host": "127.0.0.1"
    }
  }
}
```

For e2e tests the deploy script will generate a `firebase.json` per test (with a random port for parallel safety).

---

## Secrets in Firebase Functions v2

### Confirmed: `process.env.SECRET_NAME` IS populated

When a secret is bound to a v2 function via the `secrets` array, Firebase/Cloud Run injects the secret value as an environment variable at instance startup. Both access patterns work:

```typescript
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';

const mySecret = defineSecret('MY_SECRET');

export const myFunc = onRequest(
  { secrets: [mySecret] },
  (req, res) => {
    const v1 = mySecret.value();          // recommended — type-safe string
    const v2 = process.env.MY_SECRET;     // also works — string | undefined
    res.send(v1);
  }
);
```

### Mechanism

Firebase Functions v2 runs on Cloud Run. When secrets are bound, Cloud Run resolves them from Secret Manager at container startup and injects them as environment variables (`secretKeyRef` in the container spec).

`.value()` is a wrapper that reads `process.env.SECRET_NAME` internally and throws if undefined.

### Emulator behavior (important gotcha)

The emulator does **not** fetch from Secret Manager. Instead it reads from `.secret.local` file in the functions directory:

```bash
# .secret.local
MY_SECRET=test-value-for-local-dev
```

**Bug**: The emulator exposes secrets from `.secret.local` to ALL functions, even those that don't declare the secret in their `secrets` array. This differs from production where only bound functions get the value.

For the e2e deploy script, set secrets as plain env vars before starting the emulator:

```bash
export MY_SECRET="test-value"
firebase emulators:start --only functions --project my-firebase-project
```

Or use `.secret.local`.

---

## Starting & Stopping the Emulator in Shell Scripts

Pattern matching the bun adapter's approach (background process + PID file):

```bash
# Start emulator in background
firebase emulators:start --only functions --project my-firebase-project \
  >> "$NEXT_TEST_DIR/.firebase-emulator.log" 2>&1 &
EMULATOR_PID=$!
echo "$EMULATOR_PID" > "$NEXT_TEST_DIR/.adapter-server.pid"

# Wait for readiness (TCP on functions port)
for i in $(seq 1 30); do
  if node -e "
    const s = require('net').connect({host:'127.0.0.1',port:${FUNCTIONS_PORT}});
    s.once('connect',()=>{s.destroy();process.exit(0)});
    s.once('error',()=>{s.destroy();process.exit(1)});
    setTimeout(()=>process.exit(1),750);
  " 2>/dev/null; then
    break
  fi
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo "Emulator died" >&2; cat "$NEXT_TEST_DIR/.firebase-emulator.log" >&2; exit 1
  fi
  sleep 1
done

# Output URL (only stdout output)
echo "http://127.0.0.1:${FUNCTIONS_PORT}/my-firebase-project/us-central1/nextjsServer"
```

Cleanup script kills the PID from `.adapter-server.pid` — same pattern as bun adapter.

---

## Project ID for Local Testing

Two options with different tradeoffs:

### Option A: `demo-*` prefix (CI-friendly, no credentials required)

The Firebase emulator treats any project ID starting with `demo-` as a fully local/offline project. No Google account, no `firebase login`, no `GOOGLE_APPLICATION_CREDENTIALS` needed. The emulator runs without contacting Google.

```bash
firebase emulators:start --only functions --project demo-nextjs-test
# URL: http://127.0.0.1:5001/demo-nextjs-test/us-central1/nextjsServer
```

Use for: CI pipelines, contributors without Firebase access, fully offline iteration.

### Option B: `my-firebase-project` (real project ID, still runs locally)

`my-firebase-project` is the actual Firebase project for this adapter. Using the real project ID with the emulator still runs everything locally — no deployment, no billing. It just makes URLs match production and allows testing against other emulated services (Firestore, Auth) with production-parity config.

```bash
firebase emulators:start --only functions --project my-firebase-project
# URL: http://127.0.0.1:5001/my-firebase-project/us-central1/nextjsServer
```

Requires `firebase login` or `GOOGLE_APPLICATION_CREDENTIALS` to be set (the emulator may still start without it, but some operations will fail).

Use for: local dev where you want URLs to match production, integration tests against other emulated services.

### Recommendation for scripts

Default to `demo-nextjs-test` in CI scripts; accept `FIREBASE_PROJECT_ID` env var so developers can override to `my-firebase-project` locally:

```bash
PROJECT_ID="${FIREBASE_PROJECT_ID:-demo-nextjs-test}"
firebase emulators:start --only functions --project "$PROJECT_ID"
# ...
echo "http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/nextjsServer"
```

---

## Required Files in Build Output for Emulator

The emulator needs these files in the working directory (or wherever `functions.source` points):

- `firebase.json` — project config with `functions` + `emulators` sections
- `package.json` — with a `main` entry pointing to the compiled function file
- Compiled JS (the adapter's output — e.g., `index.js` that exports the onRequest handler)
- `node_modules/` — all runtime dependencies

The deploy script must ensure these exist after `next build` completes. The adapter's `onBuildComplete` hook generates the function code; the deploy script wraps it with `firebase.json` and starts the emulator.

---

## Port Conflicts in Parallel Testing

Unlike the bun adapter (which picks a random port for its own server), the Firebase emulator defaults to 5001. For parallel test shards on a single machine, each shard needs a different port:

```bash
FUNCTIONS_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# Generate firebase.json with random port
cat > firebase.json <<EOF
{
  "functions": {"source": "."},
  "emulators": {"functions": {"port": ${FUNCTIONS_PORT}, "host": "127.0.0.1"}}
}
EOF

firebase emulators:start --only functions --project my-firebase-project \
  >> .firebase-emulator.log 2>&1 &
```

---

## What the Deploy Script Must Do (Summary)

1. `cd "$NEXT_TEST_DIR"`
2. Install adapter as tarball dependency (match bun adapter pattern)
3. Set `NEXT_ADAPTER_PATH` to installed adapter dist
4. Generate deployment ID, set `NEXT_DEPLOYMENT_ID` + `VERCEL_IMMUTABLE_ASSET_TOKEN` + `IMMUTABLE_ASSET_TOKEN`
5. Run `next build` (via package.json `scripts.build`)
6. Write BUILD_ID/DEPLOYMENT_ID/IMMUTABLE_ASSET_TOKEN markers to `.adapter-build.log`
7. Pick random port, generate `firebase.json`
8. Copy adapter build output to emulator-expected location
9. Start Firebase emulator in background, save PID to `.adapter-server.pid`
10. TCP-poll until emulator is ready (or detect death)
11. Output URL to stdout: `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/nextjsServer`
