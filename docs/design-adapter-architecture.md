---
title: Firebase Functions Adapter — Architecture Design
status: draft
author: lead
---

# Adapter Architecture Design

## Decision: Single Function + `next()` Server

Unlike the Vercel adapter (per-route lambda functions), we use **one Firebase Function** that wraps `next().getRequestHandler()`. Rationale:
- Firebase Functions v2 has per-instance concurrency (up to 1000 req/instance), so one function handles all routes efficiently
- `getRequestHandler()` is the same API used by `next start` — proven, correct, handles all routing internally including RSC, middleware, ISR
- Per-route functions would require complex routing logic and multiply cold start surface area

## Decision: Copy `.next/` directly (no `output: 'standalone'`)

`output: 'standalone'` is designed for minimal container images. For Firebase Functions:
- The `functions/` dir has its own `package.json` with `next` as a dependency
- `npm install` is run before deploy anyway
- Copying raw `.next/` is simpler and avoids standalone's quirks with custom servers

## Output Structure

```
{outDir}/                          # default: firebase-dist/
  functions/
    .next/                         # copied from projectDir/.next/
    public/                        # copied from projectDir/public/ (if exists)
    index.js                       # Firebase Functions entry (CJS, generated)
    firebase-params.js             # Secret/param definitions (CJS, generated)
    runtime-next-config.json       # Next.js config stripped of adapter fields
    deployment-manifest.json       # Adapter metadata
    package.json                   # Firebase Functions package (generated)
    .gitignore                     # Excludes node_modules
  firebase.json                    # Written to projectDir root if absent
```

## `modifyConfig` Hook

Minimal — only strips incompatible options if needed. Does NOT set `output: 'standalone'`.

```typescript
modifyConfig(config) {
  return {
    ...config,
    // Ensure output is not 'export' (would break SSR)
    // output: config.output === 'export' ? undefined : config.output,
  }
}
```

## `onBuildComplete` Hook

1. Clean `{outDir}/functions/`
2. Copy `.next/` → `functions/.next/`
3. Copy `public/` → `functions/public/` (if exists)
4. Write `runtime-next-config.json` (config with adapter fields removed, `distDir` set to `.next`)
5. Write `deployment-manifest.json`
6. Write `functions/firebase-params.js` (from `secrets` + `params` options)
7. Write `functions/index.js` (from template, imports firebase-params)
8. Write `functions/package.json`
9. Write `functions/.gitignore`
10. Write `{projectDir}/firebase.json` if it doesn't exist

## Firebase Params Design

See [[design-firebase-params]]

## Secrets Flow

```
Adapter options:
  secrets: ['DATABASE_URL', 'STRIPE_KEY']
  params: { REGION: { type: 'string', default: 'us-central1' } }

↓ onBuildComplete generates:

functions/firebase-params.js:
  const { defineSecret } = require('firebase-functions/params')
  exports.DATABASE_URL = defineSecret('DATABASE_URL')
  exports.STRIPE_KEY = defineSecret('STRIPE_KEY')

functions/index.js:
  const { DATABASE_URL, STRIPE_KEY } = require('./firebase-params')
  exports.nextjs = onRequest({ secrets: [DATABASE_URL, STRIPE_KEY] }, handler)
```

At runtime, Next.js server code accesses via `process.env.DATABASE_URL` (Firebase injects bound secrets as env vars).

## Runtime Entry (`functions/index.js`)

```javascript
'use strict'
const { onRequest } = require('firebase-functions/v2/https')
const { DATABASE_URL, STRIPE_KEY } = require('./firebase-params')
const manifest = require('./deployment-manifest.json')

let _handler = null
let _initErr = null

const _init = (async () => {
  try {
    let conf = {}
    try { conf = require('./runtime-next-config.json') } catch {}
    const next = require('next')
    const app = next({ dev: false, dir: __dirname, conf })
    await app.prepare()
    _handler = app.getRequestHandler()
  } catch (err) {
    _initErr = err
    console.error('[adapter-firebase] init failed:', err)
  }
})()

exports.nextjs = onRequest({
  timeoutSeconds: 60,
  memory: '1GiB',
  minInstances: 0,
  concurrency: 80,
  invoker: 'public',
  ...(manifest.function?.config ?? {}),
  secrets: [DATABASE_URL, STRIPE_KEY],
}, async (req, res) => {
  if (!_handler) await _init
  if (_initErr || !_handler) { res.status(500).send('Internal Server Error'); return }
  try { await _handler(req, res) }
  catch (err) {
    console.error('[adapter-firebase] request error:', err)
    if (!res.headersSent) res.status(500).send('Internal Server Error')
  }
})
```

## Adapter Options

```typescript
interface FirebaseAdapterOptions {
  outDir?: string               // default: 'firebase-dist'
  functionName?: string         // default: 'nextjs'
  secrets?: string[]            // Cloud Secret Manager secret names
  params?: Record<string, FirebaseParamDefinition>
  envFilePath?: string          // path to .env file to copy into functions output
  env?: Record<string, string>  // inline env vars (override envFilePath)
  functionConfig?: FirebaseFunctionsHttpsOptions  // spread into onRequest()
}

interface FirebaseFunctionsHttpsOptions {
  region?: string | string[]
  timeoutSeconds?: number       // default: 60
  memory?: string               // default: '1GiB'
  minInstances?: number         // default: 0
  maxInstances?: number
  concurrency?: number          // default: 80
  invoker?: 'public' | 'private' | string[]  // default: 'public'
  labels?: Record<string, string>
  vpcConnector?: string
  vpcConnectorEgressSettings?: 'PRIVATE_RANGES_ONLY' | 'ALL_TRAFFIC'
  ingressSettings?: 'ALLOW_ALL' | 'ALLOW_INTERNAL_ONLY' | 'ALLOW_INTERNAL_AND_GCLB'
  serviceAccount?: string
  [key: string]: unknown        // any other Firebase HttpsOptions field
}

interface FirebaseParamDefinition {
  type: 'string' | 'int' | 'boolean'
  default?: string | number | boolean
  description?: string
}
```

`functionConfig` is spread directly into the `onRequest()` options, so any field supported by Firebase Functions v2 `HttpsOptions` can be passed through without adapter changes.

## Files to Implement

```
adapter-firebase-functions/
  src/
    index.ts              # re-exports createFirebaseAdapter + default instance
    adapter.ts            # createFirebaseAdapter, modifyConfig, onBuildComplete
    types.ts              # FirebaseAdapterOptions, FirebaseParamDefinition, BuildCompleteContext
    runtime-template.ts   # FIREBASE_ENTRY_TEMPLATE string
    firebase-params.ts    # generateFirebaseParamsModule() → JS string
  package.json
  tsconfig.json
  tsconfig.build.json
```

## See Also

- [[research-nextjs-adapter-api]]
- [[research-firebase-functions-api]]
- [[design-firebase-params]]
- [[implementation-plan]]
