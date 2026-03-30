---
title: Next.js 16.2 Adapter API
status: complete
author: lead
---

# Next.js 16.2 Adapter API

> Source: https://nextjs.org/docs/app/api-reference/config/next-config-js/adapterPath (fetched 2026-03-27)

## Configuration

```js
// next.config.js
const nextConfig = {
  adapterPath: require.resolve('./my-adapter.js'),
}
```

Alternatively: `NEXT_ADAPTER_PATH` env var for zero-config platform usage.

## Interface

```typescript
import type { NextAdapter } from 'next'

export interface NextAdapter {
  name: string
  modifyConfig?: (
    config: NextConfigComplete,
    ctx: { phase: PHASE_TYPE; nextVersion: string }
  ) => Promise<NextConfigComplete> | NextConfigComplete
  onBuildComplete?: (ctx: {
    routing: {
      beforeMiddleware: Array<Route>
      beforeFiles: Array<Route>
      afterFiles: Array<Route>
      dynamicRoutes: Array<Route>
      onMatch: Array<Route>
      fallback: Array<Route>
      shouldNormalizeNextData: boolean
      rsc: RoutesManifest['rsc']
    }
    outputs: AdapterOutputs
    projectDir: string
    repoRoot: string
    distDir: string
    config: NextConfigComplete
    nextVersion: string
    buildId: string
  }) => Promise<void> | void
}
```

## Output Types

### `outputs.pages` — `pages/` React pages
```typescript
{
  type: 'PAGES'
  id: string
  filePath: string       // built handler file
  pathname: string       // URL path
  sourcePage: string
  runtime: 'nodejs' | 'edge'
  assets: Record<string, string>   // traced deps: relPath → absPath
  wasmAssets?: Record<string, string>
  edgeRuntime?: { modulePath: string; entryKey: string; handlerExport: string }
  config: { maxDuration?: number; preferredRegion?: string | string[]; env?: Record<string, string> }
}
```

Same shape for: `outputs.appPages` (`APP_PAGE`), `outputs.pagesApi` (`PAGES_API`), `outputs.appRoutes` (`APP_ROUTE`).

### `outputs.prerenders`
```typescript
{
  type: 'PRERENDER'
  id: string
  pathname: string
  parentOutputId: string
  groupId: number
  pprChain?: { headers: Record<string, string> }
  parentFallbackMode?: false | null | string
  fallback?: {
    filePath: string | undefined
    initialStatus?: number
    initialHeaders?: Record<string, string | string[]>
    initialExpiration?: number
    initialRevalidate?: number | false
    postponedState: string | undefined
  }
  config: {
    allowQuery?: string[]
    allowHeader?: string[]
    bypassFor?: RouteHas[]
    renderingMode?: 'STATIC' | 'PARTIALLY_STATIC'
    partialFallback?: boolean
    bypassToken?: string
  }
}
```

### `outputs.staticFiles`
```typescript
{
  type: 'STATIC_FILE'
  id: string
  filePath: string
  pathname: string
  immutableHash: string | undefined
}
```

### `outputs.middleware`
```typescript
{
  type: 'MIDDLEWARE'
  runtime: 'nodejs' | 'edge'
  // ... same base shape
  config: {
    matchers?: Array<{ source: string; sourceRegex: string; has?: RouteHas[]; missing?: RouteHas[] }>
  }
}
```

## Node.js Handler Invocation

```typescript
handler(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: {
    waitUntil?: (promise: Promise<void>) => void
    requestMeta?: {
      relativeProjectDir?: string
      hostname?: string
      revalidate?: (opts) => Promise<void>
      render404?: (req, res, parsedUrl, setHeaders) => Promise<void>
      postponed?: string            // PPR
      onCacheEntryV2?: (entry, meta) => Promise<boolean>
    }
  }
): Promise<void>
```

## Edge Handler Invocation

```typescript
handler(
  request: Request,
  ctx: { waitUntil?: (prom: Promise<void>) => void; signal?: AbortSignal; requestMeta?: RequestMeta }
): Promise<Response>
```

Edge entries: use `output.edgeRuntime.entryKey` to look up from `globalThis._ENTRIES`, then call `entry[output.edgeRuntime.handlerExport]`.

## Testing Harness

Three env vars point to shell scripts:
- `NEXT_TEST_DEPLOY_SCRIPT_PATH` — builds + deploys, **must print deployment URL to stdout only**
- `NEXT_TEST_DEPLOY_LOGS_SCRIPT_PATH` — prints lines starting with `BUILD_ID:`, `DEPLOYMENT_ID:`, `IMMUTABLE_ASSET_TOKEN:`
- `NEXT_TEST_CLEANUP_SCRIPT_PATH` — tears down

Scripts run with `cwd` = isolated tmp app dir. `NEXT_TEST_DIR` and `NEXT_TEST_DEPLOY_URL` are provided to logs/cleanup scripts.

## Key Notes

- `modifyConfig` called on every CLI command loading `next.config.js`
- `onBuildComplete` called once after full build
- For `config.output === 'export'`: only `outputs.staticFiles` is populated
- Breaking changes require new Next.js major version

## See Also

- [[research-bun-adapter-patterns]]
- [[design-adapter-architecture]]
- [[research-firebase-functions-api]]
