#!/usr/bin/env bash
set -euo pipefail

# e2e-deploy-starter.sh — scaffolds the official Next.js starter (create-next-app)
# and deploys it to the Firebase emulator.
#
# This validates the adapter works with a real-world app structure:
# app router, image optimization, fonts, tailwind, etc.
#
# Env: NEXT_TEST_DIR (temp dir), ADAPTER_DIR (adapter-firebase-functions root)
# Contract: only stdout output is the server URL.

ADAPTER_DIR="${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter-firebase-functions directory}"
[ -f "$ADAPTER_DIR/.env" ] && source "$ADAPTER_DIR/.env"
PROJECT_ID="${FIREBASE_PROJECT_ID:?FIREBASE_PROJECT_ID must be set (or added to .env)}"

# Use NEXT_TEST_DIR if set (harness mode), otherwise create a temp dir
# Note: mktemp suffix is lowercased — create-next-app derives the package name
# from the directory name and rejects names with capital letters.
if [ -z "${NEXT_TEST_DIR:-}" ]; then
  # Use a fixed lowercase subdir — create-next-app derives the npm package name
  # from the directory name and rejects capital letters.
  NEXT_TEST_DIR="$(mktemp -d)/nextjs-firebase-e2e"
  mkdir -p "$NEXT_TEST_DIR"
  echo "Created temp dir: $NEXT_TEST_DIR" >&2
fi

cd "$NEXT_TEST_DIR"

# --- Scaffold official Next.js starter directly into NEXT_TEST_DIR ---
echo "Scaffolding Next.js starter app..." >&2
# Pipe newlines to auto-accept any remaining interactive prompts (e.g. React Compiler).
# { yes || true } suppresses yes's SIGPIPE exit with pipefail enabled.
{ yes "" 2>/dev/null || true; } | npx --yes create-next-app@latest . \
  --typescript \
  --app \
  --tailwind \
  --eslint \
  --no-git \
  --no-install \
  --src-dir \
  --import-alias "@/*" \
  --no-turbopack 1>&2
if [ ! -f package.json ]; then
  echo "ERROR: create-next-app did not produce a package.json — scaffold failed" >&2
  exit 1
fi

# --- Inject adapter next.config.ts ---
# Use NEXT_ADAPTER_PATH env var (set below) rather than require.resolve in config,
# because Next.js may not have import.meta.url available during config compilation.
cat > next.config.ts <<'NEXTCONFIG'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // adapterPath is injected via NEXT_ADAPTER_PATH env var at build time
}
export default nextConfig
NEXTCONFIG

# --- Build adapter (ensure dist/ is up to date) ---
echo "Building adapter..." >&2
(cd "$ADAPTER_DIR" && npm run build) >&2

# --- Pack adapter and inject as dependency ---
ADAPTER_PACK_LOCK="${ADAPTER_DIR}/.e2e-deploy-pack.lock"
for _attempt in $(seq 1 300); do
  if mkdir "$ADAPTER_PACK_LOCK" 2>/dev/null; then break; fi
  sleep 0.1
done

PACK_RESULT="$(cd "$ADAPTER_DIR" && npm pack --json --ignore-scripts --pack-destination "$NEXT_TEST_DIR")"
TARBALL="$NEXT_TEST_DIR/$(node -e "console.log(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))[0].filename)" <<< "$PACK_RESULT")"
rmdir "$ADAPTER_PACK_LOCK" 2>/dev/null || true

node -e "
  const pkg = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
  pkg.dependencies = pkg.dependencies || {};
  pkg.dependencies['adapter-firebase-functions'] = 'file:${TARBALL}';
  require('fs').writeFileSync('package.json', JSON.stringify(pkg, null, 2));
" >&2

npm install --no-package-lock >&2

# --- Set adapter path + deployment ID ---
export NEXT_ADAPTER_PATH="${NEXT_TEST_DIR}/node_modules/adapter-firebase-functions/dist/index.js"

DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="firebase-adapter-starter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE:-deploy}"

# --- Build ---
: > .adapter-build.log
npm run build 2>&1 | tee -a .adapter-build.log >&2

echo "BUILD_ID: $(cat .next/BUILD_ID 2>/dev/null || echo unknown)" >> .adapter-build.log
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> .adapter-build.log
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> .adapter-build.log

# --- Activate Node 22 for emulator subprocess via fnm ---
# The Firebase emulator spawns a subprocess with the node found in PATH.
# Switching to Node 22 ensures the subprocess matches our functions runtime.
if command -v fnm &>/dev/null; then
  eval "$(fnm env)" 2>/dev/null || true
  fnm use 22 --install-if-missing 2>&1 >&2 || true
fi

# --- Install functions dependencies ---
FUNCTIONS_DIR="firebase-dist/functions"
if [ -d "$FUNCTIONS_DIR" ]; then
  (cd "$FUNCTIONS_DIR" && npm install --no-package-lock) >&2
else
  echo "ERROR: $FUNCTIONS_DIR not found after build" >&2
  exit 1
fi

# --- Pick a random port for the emulator ---
FUNCTIONS_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# --- Write firebase.json for the emulator ---
cat > firebase-dist/firebase.json <<EOF
{
  "functions": {
    "source": "functions",
    "runtime": "nodejs22"
  },
  "emulators": {
    "functions": {
      "port": ${FUNCTIONS_PORT},
      "host": "127.0.0.1"
    }
  }
}
EOF

# --- Start Firebase emulator ---
(cd firebase-dist && firebase emulators:start --only functions --project "$PROJECT_ID") \
  >> .adapter-server.log 2>&1 &
EMULATOR_PID=$!
echo "$EMULATOR_PID" > .adapter-server.pid

# --- Wait for emulator readiness ---
for i in $(seq 1 30); do
  if node -e "
    const s = require('net').connect({host:'127.0.0.1', port:${FUNCTIONS_PORT}});
    s.once('connect', () => { s.destroy(); process.exit(0); });
    s.once('error', () => { s.destroy(); process.exit(1); });
    setTimeout(() => process.exit(1), 750);
  " 2>/dev/null; then
    break
  fi
  if ! kill -0 "$EMULATOR_PID" 2>/dev/null; then
    echo "Emulator process died" >&2
    cat .adapter-server.log >&2
    exit 1
  fi
  sleep 1
done

# --- Output ONLY the function URL on stdout ---
echo "http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/nextjs"
