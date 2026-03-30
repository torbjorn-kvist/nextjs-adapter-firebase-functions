---
title: Bun Adapter E2E Scripts & Test Patterns
status: complete
author: researcher
---

# Bun Adapter E2E Scripts & Test Patterns

Source: `nextjs/adapter-bun` GitHub repo (fetched 2026-03-27). These scripts define the contract we must implement for `adapter-firebase-functions`.

See also: [[research-nextjs-test-harness]] for the harness contract, [[research-firebase-testing]] for Firebase-specific setup.

---

## `scripts/e2e-deploy.sh` — Verbatim

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

if [ -z "${ADAPTER_BUN_DIR:-}" ]; then
  echo "ADAPTER_BUN_DIR is not set" >&2
  exit 1
fi

if [ ! -d "$ADAPTER_BUN_DIR" ]; then
  echo "ADAPTER_BUN_DIR does not exist: $ADAPTER_BUN_DIR" >&2
  exit 1
fi

ADAPTER_BUN_DIR="$(cd "$ADAPTER_BUN_DIR" && pwd -P)"
export ADAPTER_BUN_DIR
ADAPTER_BUN_DIST_INDEX="${ADAPTER_BUN_DIR}/dist/index.js"
ADAPTER_PACK_LOCK_DIR="${ADAPTER_BUN_DIR}/.e2e-deploy-pack.lock"
adapter_pack_lock_acquired=0

cleanup_adapter_pack_lock() {
  if [ "$adapter_pack_lock_acquired" -eq 1 ]; then
    rmdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null || true
    adapter_pack_lock_acquired=0
  fi
}

trap cleanup_adapter_pack_lock EXIT

# Multiple deploy tests run in parallel and share ADAPTER_BUN_DIR.
# Serialize pack/build access so one test cannot remove dist while another
# is packing or resolving NEXT_ADAPTER_PATH.
for _attempt in $(seq 1 300); do
  if mkdir "$ADAPTER_PACK_LOCK_DIR" 2>/dev/null; then
    adapter_pack_lock_acquired=1
    break
  fi
  sleep 0.1
done

if [ "$adapter_pack_lock_acquired" -ne 1 ]; then
  echo "Timed out waiting for adapter pack lock: ${ADAPTER_PACK_LOCK_DIR}" >&2
  exit 1
fi

# Test jobs restore adapter-bun from cache. If dist artifacts are missing,
# rebuild in-place so NEXT_ADAPTER_PATH always points at a valid module.
if [ ! -f "$ADAPTER_BUN_DIST_INDEX" ]; then
  echo "Adapter dist missing at ${ADAPTER_BUN_DIST_INDEX}; rebuilding adapter-bun..." >&2
  (
    cd "$ADAPTER_BUN_DIR"
    bun install >&2
    bun run build >&2
  )
fi

if [ ! -f "$ADAPTER_BUN_DIST_INDEX" ]; then
  echo "Adapter dist build failed; missing ${ADAPTER_BUN_DIST_INDEX}" >&2
  exit 1
fi

# 1. Pick a random available port
PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# 2. Pack adapter-bun and add it as a tarball dependency. Installing the raw
# repo directory pulls fixture file: links into the temp app and can recurse.
PACK_RESULT="$(
  cd "$ADAPTER_BUN_DIR"
  npm pack --json --ignore-scripts --pack-destination "$NEXT_TEST_DIR"
)"
ADAPTER_BUN_TARBALL="$NEXT_TEST_DIR/$(
  node -e "const result = JSON.parse(process.argv[1]); console.log(result[0].filename)" "$PACK_RESULT"
)"
cleanup_adapter_pack_lock

# 3. Add adapter-bun as dependency
node -e "
const pkg=JSON.parse(require('fs').readFileSync('package.json','utf8'));
pkg.dependencies=pkg.dependencies||{};
pkg.dependencies['adapter-bun']='file:${ADAPTER_BUN_TARBALL}';
require('fs').writeFileSync('package.json',JSON.stringify(pkg,null,2));
" >&2

# 4. Install dependencies
bun install --no-frozen-lockfile >&2

# Bun type packages can conflict with Next.js global typings in fixtures
# without explicit tsconfig "types". Remove them for deploy test builds.
if [ -d "node_modules/bun-types" ]; then
  rm -rf "node_modules/bun-types"
fi
if [ -d "node_modules/@types/bun" ]; then
  rm -rf "node_modules/@types/bun"
fi

# 5. Set adapter path
NEXT_ADAPTER_PATH_LOCAL="${NEXT_TEST_DIR}/node_modules/adapter-bun/dist/index.js"
if [ ! -f "$NEXT_ADAPTER_PATH_LOCAL" ]; then
  echo "Installed adapter dist missing: ${NEXT_ADAPTER_PATH_LOCAL}" >&2
  exit 1
fi
export NEXT_ADAPTER_PATH="$NEXT_ADAPTER_PATH_LOCAL"
# Next's deploy harness aliases NEXT_PRIVATE_TEST_MODE -> __NEXT_TEST_MODE
# in next.config.js for test-only hydration markers. Ensure it's set so
# browser hydration waits don't fall back to a 10s timeout per navigation.
if [ -z "${NEXT_PRIVATE_TEST_MODE:-}" ] && [ -n "${NEXT_TEST_MODE:-}" ]; then
  export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE}"
fi

# 6. Build (NEXT_ADAPTER_PATH tells Next.js to use our adapter).
# The Next.js test harness always wires a `build` script in package.json.
# Execute that script, but force `next build` segments to run through Bun.
: > "$NEXT_TEST_DIR/.adapter-build.log"

BUILD_SCRIPT="$(
  node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const build = pkg?.scripts?.build;
if (typeof build === 'string' && build.trim().length > 0) {
  const normalized = build.replace(/\\bnext\\s+build\\b/g, 'bun --bun next build');
  console.log(normalized);
}
" 2>/dev/null || true
)"

if [ -z "$BUILD_SCRIPT" ]; then
  echo 'Missing package.json scripts.build in deploy test dir' >&2
  exit 1
fi

# Generate a stable deployment ID before the build so it is baked into
# client bundles and used consistently at runtime.
DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="bun-adapter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"

# Forward experimental feature flags from the test harness.
if [ -n "${__NEXT_CACHE_COMPONENTS:-}" ]; then
  export NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS="${__NEXT_CACHE_COMPONENTS}"
fi
if [ -n "${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS:-}" ]; then
  export __NEXT_CACHE_COMPONENTS="${NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS}"
fi

bash -lc "$BUILD_SCRIPT" 2>&1 | tee -a "$NEXT_TEST_DIR/.adapter-build.log" >&2

# 7. Record build ID markers for logs script
BUILD_ID=$(cat ".next/BUILD_ID" 2>/dev/null || echo "unknown")
echo "BUILD_ID: $BUILD_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> "$NEXT_TEST_DIR/.adapter-build.log"
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> "$NEXT_TEST_DIR/.adapter-build.log"

# 8. Start server on selected port
# Use bun (without --bun) for better Node.js API compatibility with Next.js internals
PORT=$PORT NEXT_DEPLOYMENT_ID="$NEXT_DEPLOYMENT_ID" VERCEL_IMMUTABLE_ASSET_TOKEN="$VERCEL_IMMUTABLE_ASSET_TOKEN" IMMUTABLE_ASSET_TOKEN="$IMMUTABLE_ASSET_TOKEN" bun bun-dist/server.js >> "$NEXT_TEST_DIR/.adapter-server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$NEXT_TEST_DIR/.adapter-server.pid"

# 9. Wait for server to be ready.
# Use a plain TCP probe instead of an HTTP route probe so middleware fixtures
# are not exercised during readiness checks.
server_ready=0
for i in $(seq 1 30); do
  if PORT="$PORT" node -e "
const net = require('node:net');
const port = Number(process.env.PORT);
const socket = net.connect({ host: '127.0.0.1', port });
const done = (ok) => {
  socket.destroy();
  process.exit(ok ? 0 : 1);
};
socket.once('connect', () => done(true));
socket.once('error', () => done(false));
setTimeout(() => done(false), 750);
" >/dev/null 2>&1; then
    server_ready=1
    break
  fi

  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Server died. Logs:" >&2
    cat "$NEXT_TEST_DIR/.adapter-server.log" >&2
    exit 1
  fi
  sleep 1
done

if [ "$server_ready" -ne 1 ]; then
  echo "Server did not become ready within timeout. Logs:" >&2
  cat "$NEXT_TEST_DIR/.adapter-server.log" >&2
  exit 1
fi

# 10. Output URL (only thing on stdout)
echo "http://localhost:${PORT}"
```

### Key design decisions

- **Validation first**: Checks `ADAPTER_BUN_DIR` exists before anything else.
- **Lock file** (`mkdir` atomically) serializes parallel test pack/build across shards, with `trap` for cleanup.
- **Auto-rebuild**: If dist is missing (CI cache miss), rebuilds adapter in-place.
- **`npm pack` -> tarball** avoids symlink issues with raw directory installs.
- **Bun type cleanup**: Removes `bun-types` and `@types/bun` to avoid TS conflicts with Next.js fixtures.
- **NEXT_PRIVATE_TEST_MODE**: Auto-mirrored from NEXT_TEST_MODE for hydration markers.
- **Build script normalization**: Rewrites `next build` to `bun --bun next build` in the package.json build script.
- **Experimental flags**: Forwards `__NEXT_CACHE_COMPONENTS` <-> `NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS`.
- **All non-URL output goes to stderr** or log files.
- **Random port** via Node `net.createServer` on port 0.
- **TCP probe** (not HTTP) avoids triggering middleware on readiness check.
- **Server death detection**: Checks `kill -0` during poll loop and fails fast.
- **Log file** `.adapter-build.log` holds BUILD_ID/DEPLOYMENT_ID/IMMUTABLE_ASSET_TOKEN markers.
- **`.adapter-server.pid`** holds the PID for cleanup.

---

## `scripts/e2e-logs.sh` — Verbatim

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# Emit canonical build/deploy markers first so next-deploy.ts parses
# deterministic values even when fixture scripts also print similarly-named keys.
if [ -f ".adapter-build.log" ]; then
  BUILD_ID_VALUE="$(grep -E '^BUILD_ID: ' .adapter-build.log | tail -n1 | sed 's/^BUILD_ID: //')"
  DEPLOYMENT_ID_VALUE="$(grep -E '^DEPLOYMENT_ID: ' .adapter-build.log | tail -n1 | sed 's/^DEPLOYMENT_ID: //')"
  IMMUTABLE_ASSET_TOKEN_VALUE="$(grep -E '^IMMUTABLE_ASSET_TOKEN: ' .adapter-build.log | tail -n1 | sed 's/^IMMUTABLE_ASSET_TOKEN: //')"

  if [ -n "$BUILD_ID_VALUE" ]; then
    echo "BUILD_ID: $BUILD_ID_VALUE"
  fi
  if [ -n "$DEPLOYMENT_ID_VALUE" ]; then
    echo "DEPLOYMENT_ID: $DEPLOYMENT_ID_VALUE"
  fi
  if [ -n "$IMMUTABLE_ASSET_TOKEN_VALUE" ]; then
    echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN_VALUE"
  fi
fi

# Output all log files
for f in .adapter-build.log .next/trace; do
  if [ -f "$f" ]; then
    echo "=== $f ==="
    cat "$f"
    echo ""
  fi
done

# Output any server stdout/stderr logs
for f in .adapter-server.log; do
  if [ -f "$f" ]; then
    echo "=== $f ==="
    cat "$f"
    echo ""
  fi
done
```

### Key points

- **Markers first**: Uses `grep | tail -n1 | sed` to extract last occurrence of each marker, ensuring fixture output doesn't pollute marker values.
- **Three log sources**: Build log, Next.js trace, and server runtime log.
- **Separator format**: `=== filename ===` between log sections.

---

## `scripts/e2e-cleanup.sh` — Verbatim

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# 1. Output runtime logs before shutdown.
LOG_FILE=".adapter-server.log"
PRE_SHUTDOWN_LOG_LINES=0
if [ -f "$LOG_FILE" ]; then
  echo "=== ${LOG_FILE} (pre-shutdown) ==="
  cat "$LOG_FILE"
  echo ""
  PRE_SHUTDOWN_LOG_LINES="$(wc -l < "$LOG_FILE" | tr -d '[:space:]')"
fi

# 2. Stop the server
PID_FILE=".adapter-server.pid"
if [ -f "$PID_FILE" ]; then
  while IFS= read -r SERVER_PID; do
    if [ -z "$SERVER_PID" ]; then
      continue
    fi
    if kill -0 "$SERVER_PID" 2>/dev/null; then
      kill "$SERVER_PID" 2>/dev/null || true
      # Wait up to 5 seconds for graceful shutdown
      for i in $(seq 1 50); do
        if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
        sleep 0.1
      done
      # Force kill if still running
      if kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -9 "$SERVER_PID" 2>/dev/null || true
      fi
    fi
  done < "$PID_FILE"
  rm -f "$PID_FILE"
fi

# 3. Persist logs and output anything appended during shutdown.
if [ -f "$LOG_FILE" ]; then
  PERSIST_SERVER_LOG_PATH="${ADAPTER_BUN_PERSIST_SERVER_LOG:-/tmp/adapter-bun-last-server.log}"
  cp "$LOG_FILE" "$PERSIST_SERVER_LOG_PATH" 2>/dev/null || true

  POST_SHUTDOWN_LOG_LINES="$(wc -l < "$LOG_FILE" | tr -d '[:space:]')"
  if [ "$POST_SHUTDOWN_LOG_LINES" -gt "$PRE_SHUTDOWN_LOG_LINES" ]; then
    echo "=== ${LOG_FILE} (post-shutdown appended) ==="
    sed -n "$((PRE_SHUTDOWN_LOG_LINES + 1)),\$p" "$LOG_FILE"
    echo ""
  fi
fi
```

### Key points

- **Pre-shutdown log capture**: Records line count before kill, then diffs to show only post-shutdown output.
- **Graceful then force**: SIGTERM first, poll `kill -0` for 5s, then SIGKILL.
- **Idempotent**: Checks `[ -f "$PID_FILE" ]` and `kill -0` before acting.
- **Log persistence**: Copies to `ADAPTER_BUN_PERSIST_SERVER_LOG` (defaults to `/tmp/adapter-bun-last-server.log`).
- **Multi-PID**: Reads PID file line-by-line (`while IFS= read`), handling potential multiple PIDs.

---

## `scripts/e2e-local.sh` — Verbatim

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ADAPTER_BUN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# Place workspace outside the adapter-bun tree so bun.lock doesn't
# get detected as a workspace root by Next.js turbo/bundler.
WORKSPACE="${ADAPTER_BUN_DIR}/../.adapter-bun-e2e"
NEXTJS_DIR="$WORKSPACE/next.js"
NEXTJS_REF="${1:-canary}"
TEST_FILE="${2:-test/e2e/app-dir/app/index.test.ts}"

echo "=== adapter-bun local e2e test runner ==="
echo "Adapter dir:  $ADAPTER_BUN_DIR"
echo "Workspace:    $WORKSPACE"
echo "Next.js ref:  $NEXTJS_REF"
echo "Test file:    $TEST_FILE"
echo ""

# -- Step 1: Clone or update Next.js --
if [ -d "$NEXTJS_DIR/.git" ]; then
  echo ">>> Next.js repo exists, fetching..."
  cd "$NEXTJS_DIR"
  git fetch origin "$NEXTJS_REF" --depth=25
  git checkout FETCH_HEAD
else
  echo ">>> Cloning vercel/next.js (ref: $NEXTJS_REF)..."
  mkdir -p "$WORKSPACE"
  git clone --depth=25 --branch "$NEXTJS_REF" https://github.com/vercel/next.js.git "$NEXTJS_DIR"
fi

# -- Step 2: Install & build Next.js --
cd "$NEXTJS_DIR"
echo ">>> Installing Next.js dependencies (pnpm install)..."
corepack enable
pnpm install

echo ">>> Building Next.js (pnpm build)..."
pnpm build

echo ">>> Re-linking after build (pnpm install)..."
pnpm install

# -- Step 3: Install Playwright --
echo ">>> Installing Playwright chromium..."
pnpm playwright install --with-deps chromium

# -- Step 4: Build adapter-bun --
echo ">>> Building adapter-bun..."
cd "$ADAPTER_BUN_DIR"
bun install
bun run build

# -- Step 5: Make scripts executable --
chmod +x "$ADAPTER_BUN_DIR/scripts/e2e-deploy.sh" \
         "$ADAPTER_BUN_DIR/scripts/e2e-logs.sh" \
         "$ADAPTER_BUN_DIR/scripts/e2e-cleanup.sh"

# -- Step 6: Run the test --
echo ""
echo ">>> Running test: $TEST_FILE"
echo ""
cd "$NEXTJS_DIR"

NEXT_TEST_MODE=deploy \
NEXT_E2E_TEST_TIMEOUT=240000 \
NEXT_EXTERNAL_TESTS_FILTERS="test/deploy-tests-manifest.json,$ADAPTER_BUN_DIR/test/deploy-tests-manifest.adapter-bun.json" \
NEXT_TEST_DEPLOY_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-deploy.sh" \
NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-logs.sh" \
NEXT_TEST_CLEANUP_SCRIPT_PATH="$ADAPTER_BUN_DIR/scripts/e2e-cleanup.sh" \
ADAPTER_BUN_DIR="$ADAPTER_BUN_DIR" \
IS_TURBOPACK_TEST=1 \
NEXT_TEST_JOB=1 \
NEXT_TELEMETRY_DISABLED=1 \
node run-tests.js --test-pattern "$TEST_FILE" -c 1 --debug
```

### Key points

- **Self-contained**: Clones Next.js, installs, builds, and runs test — no prerequisites beyond git/node/bun/pnpm.
- **Workspace isolation**: Places Next.js clone outside adapter tree to avoid bun.lock workspace detection.
- **Args**: `$1` = Next.js ref (default: `canary`), `$2` = test file pattern.
- **Single concurrency** (`-c 1`) for local debugging.
- **Shallow clone** (`--depth=25`) for speed.

---

## `fixtures/verbose-mixed-router/next.config.ts` — Verbatim

```typescript
import type { NextConfig } from 'next';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const adapterPath = require.resolve('adapter-bun');

const config: NextConfig = {
  adapterPath,
  turbopack: {
    root: fixtureRoot,
  },
  images: {
    path: '/_next/image',
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'assets.example.com',
        pathname: '/**',
      },
    ],
    localPatterns: [
      {
        pathname: '/images/**',
      },
    ],
    qualities: [70, 75],
  },
  async headers() {
    return [
      {
        source: '/cfg/:path*',
        headers: [
          {
            key: 'x-fixture-next-config-header',
            value: 'cfg',
          },
        ],
      },
      {
        source: '/pages-router/ssr',
        headers: [
          {
            key: 'x-fixture-ssr-header',
            value: 'from-next-config',
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/cfg/redirect-old',
        destination: '/pages-router/static',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/cfg/rewrite-order/:id',
          destination: '/pages-router/ssr?from=before&id=:id',
        },
      ],
      afterFiles: [
        {
          source: '/cfg/rewrite-order/:id',
          destination: '/pages-router/products/:id',
        },
        {
          source: '/cfg/rewrite-after/:id',
          destination: '/pages-router/products/:id',
        },
      ],
      fallback: [
        {
          source: '/cfg/rewrite-fallback/:path*',
          destination: '/app-router/static',
        },
        {
          source: '/cfg/external',
          destination: 'https://example.vercel.sh',
        },
      ],
    };
  },
};

export default config;
```

### Key points

- **`adapterPath`**: Uses `require.resolve('adapter-bun')` — the adapter is a normal npm dependency.
- **`turbopack.root`**: Points to fixture directory for correct resolution.
- **Comprehensive routing**: Tests headers, redirects, beforeFiles/afterFiles/fallback rewrites — exercises the full routing layer.
- **For Firebase adapter**: Same structure, just `require.resolve('adapter-firebase-functions')` instead.

---

## Parallelism & locking pattern

The bun adapter uses `mkdir` as an atomic lock to serialize pack+build across parallel test shards. Key details from the actual source:

- Lock acquired with `mkdir "$ADAPTER_PACK_LOCK_DIR"` in a retry loop (300 attempts, 0.1s apart = 30s timeout).
- Lock released via `cleanup_adapter_pack_lock()` function, registered as `trap EXIT`.
- Lock is released ASAP after `npm pack` completes — not held during install/build.
- Timeout failure exits with error.

For Firebase adapter: We won't need the pack lock if we use a pre-built tarball, but we should still serialize if multiple shards share `ADAPTER_FIREBASE_DIR`.

---

## Environment variables set by deploy script

| Variable | Purpose |
|---|---|
| `NEXT_TEST_DIR` | Set by harness — the fixture's temp dir |
| `ADAPTER_BUN_DIR` | Set by CI/local — path to adapter repo |
| `NEXT_ADAPTER_PATH` | Resolved by deploy script — points to installed adapter dist |
| `NEXT_DEPLOYMENT_ID` | Generated by deploy script (`bun-adapter-{random}`), baked into build |
| `VERCEL_IMMUTABLE_ASSET_TOKEN` | Same as NEXT_DEPLOYMENT_ID |
| `IMMUTABLE_ASSET_TOKEN` | Same as NEXT_DEPLOYMENT_ID |
| `NEXT_PRIVATE_TEST_MODE` | Mirrors NEXT_TEST_MODE for hydration markers |
| `__NEXT_CACHE_COMPONENTS` | Forwarded experimental feature flag |
| `NEXT_PRIVATE_EXPERIMENTAL_CACHE_COMPONENTS` | Forwarded experimental feature flag |

---

## CI Workflow Pattern

The `.github/workflows/test-e2e-deploy.yml` uses a two-job pattern:

**Build job** (single, `ubuntu-latest-8-core`):
1. Checkout adapter-bun + vercel/next.js
2. `pnpm install && pnpm build` (Next.js)
3. `pnpm playwright install --with-deps chromium`
4. `bun install && bun run build` (adapter)
5. `actions/cache/save` for [next.js, adapter-bun, playwright]

**Test job** (16 shards via matrix):
1. `actions/cache/restore`
2. `chmod +x scripts/e2e-*.sh`
3. Set env: `NEXT_TEST_MODE=deploy`, all script paths, `ADAPTER_BUN_DIR`
4. `node run-tests.js --timings -g ${{ matrix.group }} -c 2 --type e2e`

Key env vars passed to test runner:
- `NEXT_TEST_MODE=deploy`
- `NEXT_E2E_TEST_TIMEOUT=240000` (4 min per test)
- `NEXT_EXTERNAL_TESTS_FILTERS` — comma-separated manifest JSONs
- `NEXT_TEST_DEPLOY_SCRIPT_PATH`, `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH`, `NEXT_TEST_CLEANUP_SCRIPT_PATH`
- `ADAPTER_BUN_DIR`
- `IS_TURBOPACK_TEST=1`
- `NEXT_TELEMETRY_DISABLED=1`
