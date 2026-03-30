#!/usr/bin/env bash
set -euo pipefail

# e2e-deploy-payload.sh — scaffolds a Payload CMS app (MongoDB + mongodb-memory-server),
# builds it with the Firebase Functions adapter, and deploys to the Firebase emulator.
#
# mongodb-memory-server is started inside the Firebase Function on first request,
# before Next.js/Payload initializes, so no external MongoDB is required.
#
# Env:
#   ADAPTER_DIR   (required) path to adapter-firebase-functions root
#   NEXT_TEST_DIR (optional) directory to scaffold into; created if absent
#   FIREBASE_PROJECT_ID (optional, default: mono-tk-payload)
# Contract: only stdout output is the emulator URL.

ADAPTER_DIR="${ADAPTER_DIR:?ADAPTER_DIR must be set to the adapter-firebase-functions directory}"
PROJECT_ID="${FIREBASE_PROJECT_ID:-mono-tk-payload}"

# create-payload-app creates a named subdirectory — work in the parent and then cd in.
PARENT_DIR="$(mktemp -d)"
APP_NAME="payload-firebase-e2e"

if [ -z "${NEXT_TEST_DIR:-}" ]; then
  NEXT_TEST_DIR="$PARENT_DIR/$APP_NAME"
  echo "Will scaffold into: $NEXT_TEST_DIR" >&2
fi

cd "$PARENT_DIR"

# --- Scaffold Payload CMS blank template using expect ---
# The database prompt is a clack arrow-key TUI select (requires a pseudo-TTY).
# MongoDB is the default (first option) — just press Enter.
echo "Scaffolding Payload CMS app..." >&2
expect -f - <<'EXPECT_SCRIPT' "$PARENT_DIR" "$APP_NAME" >&2
  set parent_dir [lindex $argv 0]
  set app_name   [lindex $argv 1]

  cd $parent_dir
  spawn npx create-payload-app $app_name -t blank --use-npm --no-deps

  # MongoDB is the default — just confirm
  expect -timeout 60 "*Select a database*"
  send "\r"

  # Accept defaults for any remaining prompts
  expect {
    -timeout 60
    "*\?" { send "\r"; exp_continue }
    eof   {}
    timeout {}
  }
  wait
EXPECT_SCRIPT

if [ ! -f "$NEXT_TEST_DIR/package.json" ]; then
  echo "ERROR: create-payload-app did not produce $NEXT_TEST_DIR/package.json" >&2
  ls "$PARENT_DIR" >&2
  exit 1
fi

cd "$NEXT_TEST_DIR"

# --- Upgrade Next.js to 16.2+ if the template shipped with an older version ---
node -e "
  const fs = require('fs')
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
  const deps = pkg.dependencies || {}
  const ver = (deps.next || '').match(/(\d+)/)
  if (ver && parseInt(ver[1]) < 16) {
    deps.next = '^16.2.0'
    pkg.dependencies = deps
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
    console.log('Upgraded next to ^16.2.0')
  } else {
    console.log('next version OK:', deps.next)
  }
" >&2

# --- Write .env ---
cat > .env <<'ENVFILE'
PAYLOAD_SECRET=adapter-firebase-functions-test-secret
NEXT_PUBLIC_PAYLOAD_URL=http://localhost:3000
ENVFILE
# DATABASE_URI is not set here — mongodb-memory-server sets it at runtime inside the function.

# --- Activate Node 22 via fnm ---
if command -v fnm &>/dev/null; then
  eval "$(fnm env)" 2>/dev/null || true
  fnm use 22 --install-if-missing 2>&1 >&2 || true
fi

# --- Install dependencies ---
echo "Installing dependencies..." >&2
npm install --no-package-lock >&2

# --- Build adapter ---
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

# --- Set NEXT_ADAPTER_PATH (injected via env, not next.config.ts) ---
# Payload wraps next.config.ts with withPayload() — easier to inject via env var.
export NEXT_ADAPTER_PATH="${NEXT_TEST_DIR}/node_modules/adapter-firebase-functions/dist/index.js"

DEPLOY_RANDOM=$(node -e "console.log(require('crypto').randomBytes(8).toString('base64url'))")
export NEXT_DEPLOYMENT_ID="firebase-adapter-payload-${DEPLOY_RANDOM}"
export IMMUTABLE_ASSET_TOKEN="$NEXT_DEPLOYMENT_ID"
export NEXT_PRIVATE_TEST_MODE="${NEXT_TEST_MODE:-deploy}"

# --- Build ---
echo "Running next build..." >&2
: > .adapter-build.log
npm run build 2>&1 | tee -a .adapter-build.log >&2

echo "BUILD_ID: $(cat .next/BUILD_ID 2>/dev/null || echo unknown)" >> .adapter-build.log
echo "DEPLOYMENT_ID: $NEXT_DEPLOYMENT_ID" >> .adapter-build.log
echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN" >> .adapter-build.log

# --- Install functions dependencies ---
FUNCTIONS_DIR="firebase-dist/functions"
if [ -d "$FUNCTIONS_DIR" ]; then
  # Inject mongodb-memory-server before npm install
  node -e "
    const fs = require('fs')
    const pkg = JSON.parse(fs.readFileSync('$FUNCTIONS_DIR/package.json', 'utf8'))
    pkg.dependencies = pkg.dependencies || {}
    pkg.dependencies['mongodb-memory-server'] = '*'
    fs.writeFileSync('$FUNCTIONS_DIR/package.json', JSON.stringify(pkg, null, 2) + '\n')
    console.log('Injected mongodb-memory-server into functions/package.json')
  " >&2

  (cd "$FUNCTIONS_DIR" && npm install --no-package-lock) >&2
else
  echo "ERROR: $FUNCTIONS_DIR not found after build — adapter onBuildComplete did not run" >&2
  cat .adapter-build.log >&2
  exit 1
fi

# --- Patch functions/index.js to start mongodb-memory-server before Next.js init ---
# mongodb-memory-server starts an in-memory MongoDB and sets process.env.DATABASE_URI.
# This must happen before require('next') / Payload initialization.
node -e "
  const fs = require('fs')
  const indexPath = '$FUNCTIONS_DIR/index.js'
  let src = fs.readFileSync(indexPath, 'utf8')

  const mongoInit = \`
// Start mongodb-memory-server and set DATABASE_URI before Next.js/Payload init.
// This is injected by e2e-deploy-payload.sh for testing purposes.
async function _startMongoMemoryServer() {
  const { MongoMemoryServer } = require('mongodb-memory-server')
  const mongod = await MongoMemoryServer.create()
  process.env.DATABASE_URI = mongod.getUri()
  process.env.DATABASE_URL = mongod.getUri()
  console.log('[e2e] mongodb-memory-server started:', mongod.getUri())
}
\`

  // Insert after the 'use strict' line
  src = src.replace(\"'use strict'\", \"'use strict'\" + mongoInit)

  // Call _startMongoMemoryServer() at the start of _startInit's async body
  src = src.replace(
    '_initPromise = (async () => {\\n      try {',
    '_initPromise = (async () => {\\n      try {\\n        await _startMongoMemoryServer()'
  )

  fs.writeFileSync(indexPath, src)
  console.log('Patched functions/index.js with mongodb-memory-server startup')
" >&2

# Copy .env into functions dir for runtime access (PAYLOAD_SECRET, NEXT_PUBLIC_PAYLOAD_URL)
cp .env "$FUNCTIONS_DIR/.env" 2>/dev/null || true

# --- Pick a random port ---
FUNCTIONS_PORT=$(node -e "const s=require('net').createServer();s.listen(0,()=>{console.log(s.address().port);s.close()})")

# --- Write firebase.json for emulator ---
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

# --- Start emulator ---
(cd firebase-dist && firebase emulators:start --only functions --project "$PROJECT_ID") \
  >> .adapter-server.log 2>&1 &
EMULATOR_PID=$!
echo "$EMULATOR_PID" > .adapter-server.pid

# --- Wait for emulator readiness ---
for i in $(seq 1 40); do
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
