---
title: Firebase Functions v2 API
status: complete
author: lead
---

# Firebase Functions v2 API

> Sources: firebase.google.com docs, fetched 2026-03-27

## HTTP Functions — `onRequest`

```typescript
import { onRequest } from 'firebase-functions/v2/https'

export const myFn = onRequest({
  region: 'us-central1',           // string | string[]
  timeoutSeconds: 60,              // max 3600 for v2
  memory: '1GiB',                  // '128MiB' | '256MiB' | '512MiB' | '1GiB' | '2GiB' | '4GiB' | '8GiB' | '16GiB' | '32GiB'
  minInstances: 0,
  maxInstances: 100,
  concurrency: 80,                 // requests per instance, v2 only
  secrets: [mySecret],             // Secret[] from defineSecret
  invoker: 'public',               // 'public' | 'private' | string[]
}, async (req, res) => {
  // req is Express-compatible, extends Node.js IncomingMessage
  // res is Express-compatible, extends Node.js ServerResponse
  res.send('Hello')
})
```

**Key**: `req`/`res` are Express-compatible — they extend Node.js `IncomingMessage`/`ServerResponse`. This means `next().getRequestHandler()(req, res)` works directly.

## Secrets — `defineSecret`

```typescript
import { defineSecret } from 'firebase-functions/params'

const dbUrl = defineSecret('DATABASE_URL')
const apiKey = defineSecret('NEXT_PUBLIC_API_KEY')

export const nextjs = onRequest({
  secrets: [dbUrl, apiKey],
}, async (req, res) => {
  // Access via .value() inside the function body
  const url = dbUrl.value()

  // OR via process.env (Firebase injects secrets as env vars when bound)
  const url2 = process.env.DATABASE_URL  // ✓ works when secret is in secrets[]
})
```

**Important**: Secrets bound via `secrets: [...]` ARE available as `process.env.SECRET_NAME` at runtime. The `.value()` method is an alternative. Next.js server code can use `process.env.DATABASE_URL` normally.

**Deployment**: `firebase deploy` will prompt for missing secret values and store them in Cloud Secret Manager.

## Params — `defineString`, `defineInt`, `defineBoolean`

```typescript
import { defineString, defineInt, defineBoolean } from 'firebase-functions/params'

const welcomeMsg = defineString('WELCOME_MESSAGE', { default: 'Hello' })
const port = defineInt('PORT', { default: 3000 })
const debug = defineBoolean('DEBUG', { default: false })

// Access at runtime:
const msg = welcomeMsg.value()   // string
const p = port.value()            // number
const d = debug.value()           // boolean
```

Params are stored in function config, NOT in Secret Manager. Use for non-sensitive configuration.

## `.env` Files

Firebase Functions supports:
```
functions/
  .env                  # always deployed (non-sensitive config)
  .env.local            # local emulator only, NOT deployed
  .env.<project-id>     # project-specific (deployed when that project is active)
```

Access: `process.env.MY_VAR`

## TypeScript Support

Firebase CLI does NOT auto-compile TypeScript. Standard setup:
```
functions/
  src/index.ts     → compile → lib/index.js
  package.json     (main: "lib/index.js", scripts: { build: "tsc" })
  tsconfig.json
```

**Our adapter** generates `functions/index.js` directly (pre-compiled JavaScript). No TS compilation step needed. User's `package.json` points to `index.js` as `main`.

## Local Emulator

```bash
firebase emulators:start --only functions
# Functions available at: http://127.0.0.1:5001/{project-id}/{region}/{functionName}
```

The emulator hot-reloads JS files. For our test deploy script, we:
1. Run `next build` (with adapter)
2. Install deps in `functions/`
3. Start emulator
4. Output the function URL to stdout

## Node.js Version

Firebase Functions v2 supports Node.js 18, 20 (recommended), 22.
Set in `functions/package.json`:
```json
{ "engines": { "node": "20" } }
```

## Module System

Firebase Functions supports both CJS and ESM. Our generated `functions/index.js` uses CJS (`require`) for maximum compatibility.

## See Also

- [[research-nextjs-adapter-api]]
- [[design-adapter-architecture]]
- [[design-firebase-params]]
