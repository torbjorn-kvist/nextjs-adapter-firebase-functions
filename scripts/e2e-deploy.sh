#!/usr/bin/env bash
set -euo pipefail

# e2e-deploy.sh — called by the Next.js deploy test harness.
# Env: NEXT_TEST_DIR (from harness), ADAPTER_DIR (our adapter root)
# Contract: only stdout output is the server URL. Everything else to stderr/logs.

cd "$NEXT_TEST_DIR"

ADAPTER_DIR="${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter-firebase-functions directory}"
PROJECT_ID="${FIREBASE_PROJECT_ID:-mono-tk-payload}"

# --- Pack adapter and inject into fixture package.json ---
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

# --- Set adapter path ---
export NEXT_ADAPTER_PATH="${NEXT_TEST_DIR}/node_modules/adapter-firebase-functions/dist/index.js"

# --- Generate deployment ID ---
DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="firebase-adapter-${DEPLOY_RANDOM}"
export VERCEL_IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE:-deploy}"

# --- Build ---
: > .adapter-build.log
npm run build 2>&1 | tee -a .adapter-build.log >&2

echo "BUILD_ID: $(cat .next/BUILD_ID 2>/dev/null || echo unknown)" >> .adapter-build.log
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> .adapter-build.log
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> .adapter-build.log

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

# --- Write firebase.json for the emulator (in the build output dir) ---
cat > firebase-dist/firebase.json <<EOF
{
  "functions": {
    "source": "functions",
    "runtime": "nodejs20"
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

# --- Wait for emulator readiness (TCP probe on functions port) ---
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
