---
title: .env File Support
status: complete
author: team-lead
---

# `.env` File Support

## Two input sources, one output

The adapter merges two sources into `functions/.env` at build time:

```typescript
createFirebaseAdapter({
  // 1. Path to an existing .env file (relative to projectDir)
  envFilePath: '.env.production',

  // 2. Inline key-value pairs — useful for CI or per-deploy overrides
  env: {
    NEXT_PUBLIC_API_URL: 'https://api.prod.example.com',
    FEATURE_FLAG_NEW_UI: 'true',
  },
})
```

**Merge rule**: inline `env` takes precedence over `envFilePath` on key collision.

If neither is set, no `.env` file is written.

## Runtime access

Firebase Functions loads `functions/.env` automatically at startup.
All vars are available as `process.env.KEY` in Next.js server code — no special import needed.

```typescript
// app/api/config/route.ts
export async function GET() {
  return Response.json({ apiUrl: process.env.NEXT_PUBLIC_API_URL })
}
```

## Distinction from secrets

| | `.env` / `env` option | `secrets` option |
|---|---|---|
| Storage | Plaintext in deployment bundle | Encrypted in Cloud Secret Manager |
| Access | `process.env.KEY` | `process.env.KEY` (bound) or `secretRef.value()` |
| Use for | Public config, feature flags, API URLs | API keys, DB passwords, tokens |
| Visible in Firebase console | Yes | No |

## Implementation

`parseEnvFile` handles: blank lines, `#` comments, `KEY=value`, quoted values (`"..."` / `'...'`).
Does NOT support multiline values or shell variable expansion — standard Firebase `.env` limitations.

## See Also

- [[design-firebase-params]] — secrets and typed params
- [[design-adapter-architecture]] — full output structure
