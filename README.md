# nextjs-adapter-firebase-functions

[![npm version](https://img.shields.io/npm/v/nextjs-adapter-firebase-functions)](https://www.npmjs.com/package/nextjs-adapter-firebase-functions)
[![npm downloads](https://img.shields.io/npm/dm/nextjs-adapter-firebase-functions)](https://www.npmjs.com/package/nextjs-adapter-firebase-functions)
[![license](https://img.shields.io/npm/l/nextjs-adapter-firebase-functions)](./LICENSE)
[![node](https://img.shields.io/node/v/nextjs-adapter-firebase-functions)](https://nodejs.org)

Firebase Cloud Functions adapter for [Next.js 16.2](https://nextjs.org/blog/next-16-2) custom adapter API.

Deploys your Next.js app as a single Firebase Cloud Function (v2) using `onRequest`. All routes — App Router, Pages Router, API routes, middleware, image optimization — are handled by one function via `next().getRequestHandler()`.

> Built with [Claude Code](https://claude.ai/code)

---

## Requirements

- Next.js `>=16.2.0`
- Node.js `22`
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`)
- A Firebase project with Cloud Functions enabled

---

## Installation

```bash
npm install nextjs-adapter-firebase-functions
```

---

## Setup

### 1. Zero config

Point `adapterPath` at the adapter. The zero-config default covers most apps:

```ts
// next.config.ts
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default {
  adapterPath: require.resolve('nextjs-adapter-firebase-functions'),
}
```

### 2. With options

To configure secrets, function settings, or env vars, use a dedicated adapter config file (`adapter.config.ts`, `.mjs`, or `.js` — any extension works):

```ts
// adapter.config.ts
import { createFirebaseAdapter } from 'nextjs-adapter-firebase-functions'

export default createFirebaseAdapter({
  functionName: 'nextjs',
  secrets: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
  functionConfig: {
    region: 'europe-west1',
    memory: '2GiB',
    timeoutSeconds: 120,
    minInstances: 1,
  },
  env: {
    NEXT_PUBLIC_APP_URL: 'https://myapp.com',
  },
})
```

```ts
// next.config.ts
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default {
  adapterPath: require.resolve('./adapter.config'),
}
```

### With Payload CMS (or other `next.config.ts` wrappers)

`adapterPath` works even when your config is wrapped by `withPayload()` or similar:

```ts
// next.config.ts
import { withPayload } from '@payloadcms/next/withPayload'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dirname = path.dirname(fileURLToPath(import.meta.url))

export default withPayload({
  adapterPath: path.resolve(dirname, './adapter.config.mjs'),
})
```

If you cannot modify `next.config.ts` (e.g. in CI), set `NEXT_ADAPTER_PATH` as an environment variable instead:

```bash
NEXT_ADAPTER_PATH="$(node -e "console.log(require.resolve('nextjs-adapter-firebase-functions'))")" \
  next build
```

---

## Build

> **Turbopack:** Next.js 16+ uses Turbopack by default. Turbopack creates `.next/node_modules/` with machine-specific symlinks that break on Cloud Run. Always build with `--webpack` for Firebase deploys.

> **Monorepo:** Only the project's own `package.json` `dependencies` are included in the generated `functions/package.json`. Workspace root deps are intentionally excluded to avoid pulling in unrelated sibling packages. The workspace root `node_modules` is still scanned for native binary sub-packages (e.g. `sharp`), so hoisted native modules are handled correctly.

```bash
next build --webpack
```

The adapter runs after the Next.js build and writes its output to `firebase-dist/` (configurable via `outDir`):

```
firebase-dist/
  functions/
    .next/                     # copied from .next/ (cache/, dev/, trace excluded)
    public/                    # copied from public/ (if present)
    index.js                   # Firebase Function entry (generated, CJS)
    firebase-params.js         # Secret/param definitions (generated, CJS)
    runtime-next-config.json   # Runtime Next.js config
    deployment-manifest.json   # Adapter metadata
    package.json               # Functions package (generated)
    .gitignore
  firebase.json                # Written to project root if absent
```

---

## Deployment

```bash
firebase deploy --only functions --project my-project-id
```

During `firebase deploy`, you will be prompted to set any secret values not yet stored in Cloud Secret Manager.

### Recommended: use `predeploy` in `firebase.json`

Add a `predeploy` hook so `firebase deploy` triggers the build automatically:

```json
{
  "functions": {
    "source": "firebase-dist/functions",
    "predeploy": ["next build --webpack"]
  }
}
```

Then deploy with:

```bash
firebase deploy --only functions --project my-project-id
```

---

## Firebase Environment Utility

Import from the `environment` subpath to read the active Firebase project. Useful for conditional config based on the active environment (e.g. `production` vs `staging`).

Requires `firebase-tools` as a peer dependency (`npm install --save-dev firebase-tools`).

```ts
import { getFirebaseEnvironment } from 'nextjs-adapter-firebase-functions/environment'

const env = await getFirebaseEnvironment()
// env?.projectId  → "my-firebase-project"
// env?.alias      → "default"
// env?.root       → "/path/to/project"
```

Example — conditional `minInstances` based on alias:

```ts
// adapter.config.ts
import { getFirebaseEnvironment } from 'nextjs-adapter-firebase-functions/environment'
import { createFirebaseAdapter } from 'nextjs-adapter-firebase-functions'

const env = await getFirebaseEnvironment()

export default createFirebaseAdapter({
  secrets: ['DATABASE_URL', 'PAYLOAD_SECRET'],
  functionConfig: {
    region: 'europe-west1',
    minInstances: env?.alias === 'production' ? 1 : 0,
  },
})
```

> Requires a `.firebaserc` in the project or workspace root. Run `firebase use <project>` once to create it.

---

## Options Reference

### `FirebaseAdapterOptions`

```ts
interface FirebaseAdapterOptions {
  outDir?: string
  functionName?: string
  secrets?: (string | SecretParam)[]
  params?: Record<string, FirebaseParamDefinition>
  env?: Record<string, string>
  envFilePath?: string
  functionConfig?: FirebaseFunctionsHttpsOptions
}
```

---

### `outDir`

**Type:** `string` **Default:** `'firebase-dist'`

Directory (relative to project root) where the adapter writes its output.

---

### `functionName`

**Type:** `string` **Default:** `'nextjs'`

The exported Firebase Function name. Appears in the Firebase console and emulator URL.

```ts
createFirebaseAdapter({ functionName: 'server' })
// URL: https://{region}-{project}.cloudfunctions.net/server
```

---

### `functionConfig`

**Type:** `FirebaseFunctionsHttpsOptions`

Options spread directly into `onRequest()`. All [Firebase Functions v2 `HttpsOptions`](https://firebase.google.com/docs/reference/functions/2nd-gen/node/firebase-functions.https.httpsoptions) fields are accepted.

```ts
createFirebaseAdapter({
  functionConfig: {
    region: 'europe-west1',
    timeoutSeconds: 120,   // default: 60
    memory: '2GiB',        // default: '1GiB'
    minInstances: 1,       // default: 0 (cold start on first request)
    maxInstances: 100,
    concurrency: 80,       // default: 80
    invoker: 'public',     // default: 'public'
    labels: { team: 'frontend' },
  },
})
```

**`memory` values:** `'128MiB'` | `'256MiB'` | `'512MiB'` | `'1GiB'` | `'2GiB'` | `'4GiB'` | `'8GiB'` | `'16GiB'` | `'32GiB'`

**`invoker`:** `'public'` (anyone can call) | `'private'` (requires auth) | `string[]` (service accounts)

---

### `secrets`

**Type:** `(string | SecretParam)[]`

Cloud Secret Manager secrets to bind to the function. Accepts plain name strings **or** `SecretParam` objects from `defineSecret()`. At runtime, bound secrets are available as `process.env.SECRET_NAME`.

```ts
// Plain strings
createFirebaseAdapter({
  secrets: ['DATABASE_URL', 'STRIPE_SECRET_KEY'],
})
```

```ts
// SecretParam objects (e.g. shared across multiple functions)
import { defineSecret } from 'firebase-functions/params'

const DATABASE_URL = defineSecret('DATABASE_URL')
const STRIPE_SECRET_KEY = defineSecret('STRIPE_SECRET_KEY')

export default createFirebaseAdapter({
  secrets: [DATABASE_URL, STRIPE_SECRET_KEY],
})
```

Access in your Next.js code without any imports:

```ts
// app/api/charge/route.ts
export async function POST(req: Request) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)
}
```

**Setting secrets:**

```bash
firebase functions:secrets:set DATABASE_URL
# prompts for value, stores in Cloud Secret Manager
```

---

### `params`

**Type:** `Record<string, FirebaseParamDefinition>`

Non-sensitive configuration values (feature flags, API endpoints, limits). Available as `process.env.KEY` at runtime.

```ts
createFirebaseAdapter({
  params: {
    NEXT_PUBLIC_API_URL: { type: 'string', default: 'https://api.example.com' },
    ITEMS_PER_PAGE: { type: 'int', default: 20 },
    ENABLE_ANALYTICS: { type: 'boolean', default: true },
  },
})
```

```ts
interface FirebaseParamDefinition {
  type: 'string' | 'int' | 'boolean'
  default?: string | number | boolean
  description?: string
}
```

---

### `env`

**Type:** `Record<string, string>`

Inline environment variables written to `functions/.env`. Available as `process.env.KEY` at runtime and in the emulator.

---

### `envFilePath`

**Type:** `string`

Path to a `.env` file (relative to project root) merged into `functions/.env`. Inline `env` values take precedence on conflict.

```ts
createFirebaseAdapter({ envFilePath: '.env.production' })
```

---

## Output File Details

### `functions/index.js`

Generated Firebase Function entry — re-generated on every build, do not edit manually.

- Function export name is baked in at build time from `functionName`
- Next.js initialization is deferred to the first request, with automatic retry on transient failures
- Cloud Functions pre-reads all request bodies into `req.rawBody` — the generated entry restores the stream so Next.js App Router can read it correctly

### `functions/firebase-params.js`

Generated secret/param definitions. Can be `require`d from other functions in the same codebase to share secrets:

```js
const { DATABASE_URL } = require('./firebase-params')
exports.myOtherFunction = onRequest({ secrets: [DATABASE_URL] }, handler)
```

### `firebase.json`

Written to the project root if it doesn't already exist. If you already have a `firebase.json`, it is never overwritten — merge the generated settings manually.

---

## Testing

### Unit tests

```bash
node --import tsx/esm --test test/unit/*.test.ts
```

### E2E tests — Next.js starter

Scaffolds `create-next-app`, builds with the adapter, deploys to the Firebase emulator:

```bash
ADAPTER_DIR="$(pwd)" bash scripts/e2e-deploy-starter.sh
```

### E2E tests — Payload CMS

Scaffolds a Payload CMS blank app, builds with the adapter, deploys to the Firebase emulator. Uses `mongodb-memory-server` — no external MongoDB required:

```bash
ADAPTER_DIR="$(pwd)" bash scripts/e2e-deploy-payload.sh
```

Both scripts accept:

| Variable | Default | Description |
|---|---|---|
| `ADAPTER_DIR` | *(required)* | Path to this repo root |
| `NEXT_TEST_DIR` | temp dir | Directory to scaffold into |
| `FIREBASE_PROJECT_ID` | *(required)* | Firebase project ID for emulator |

---

## License

MIT
