import type { HttpsOptions } from 'firebase-functions/v2/https'

export type { HttpsOptions }

/**
 * Firebase Functions v2 HttpsOptions — passed directly to onRequest().
 * @see https://firebase.google.com/docs/reference/functions/firebase-functions.https.httpsoptions
 */
export type FirebaseFunctionsHttpsOptions = HttpsOptions

/**
 * Controls exposing Next.js cache tags on responses so an upstream CDN
 * (Cloudflare, Fastly) can purge by tag.
 *
 * Next.js only emits `x-next-cache-tags` itself when running in "minimal mode"
 * (the Vercel contract, which requires the platform to own routing). This
 * adapter instead reads tags from the response cache entry via
 * `requestMeta.onCacheEntry` and sets the header itself.
 */
export interface CacheTagsOptions {
  /** Response header carrying the comma-separated tag list. @default 'Cache-Tag' */
  header?: string
  /** Also emit Next.js's native `x-next-cache-tags` header. @default false */
  includeNextHeader?: boolean
  /** Drop Next.js's implicit `_N_T_/…` path tags, keeping only explicit ones. @default false */
  stripImplicitTags?: boolean
  /** Truncate the header value at this many bytes, on a tag boundary. Cloudflare's limit is 16 KB. @default 16384 */
  maxBytes?: number
}

/** Fully resolved cache-tag config baked into the generated functions/index.js. */
export interface ResolvedCacheTagsOptions {
  header: string
  includeNextHeader: boolean
  stripImplicitTags: boolean
  maxBytes: number
}

export interface FirebaseParamDefinition {
  type: 'string' | 'int' | 'boolean'
  default?: string | number | boolean
  description?: string
}

export interface FirebaseAdapterOptions {
  /** Output directory for Firebase deployment artifacts. @default 'firebase-dist' */
  outDir?: string
  /** Exported Firebase Function name. @default 'nextjs' */
  functionName?: string
  /**
   * Cloud Secret Manager secrets to bind to the function.
   * Accepts secret names as plain strings or SecretParam objects from defineSecret().
   * Also merged with secrets declared in functionConfig.secrets.
   */
  secrets?: NonNullable<FirebaseFunctionsHttpsOptions['secrets']>
  /** Non-sensitive Firebase param definitions. */
  params?: Record<string, FirebaseParamDefinition>
  /** Path to a .env file (relative to projectDir) to copy into functions output. */
  envFilePath?: string
  /** Environment variables injected into functions/.env. Inline values override envFilePath. */
  env?: Record<string, string>
  /**
   * Expose Next.js cache tags on cached responses for CDN tag-based purging.
   * `true` uses the defaults (`Cache-Tag` header). Off by default.
   *
   * Only covers App Router pages — Route Handlers (`app/**\/route.ts`) provide
   * no interception hook in Next.js 16.
   */
  cacheTags?: boolean | CacheTagsOptions
  /**
   * Firebase Functions HttpsOptions — spread directly into onRequest().
   * Use this for timeoutSeconds, memory, region, minInstances, concurrency,
   * invoker, labels, vpcConnector, and any other Firebase-specific config.
   */
  functionConfig?: FirebaseFunctionsHttpsOptions
}

export interface FirebaseFunctionManifest {
  name: string
  config: FirebaseFunctionsHttpsOptions
  params: Record<string, FirebaseParamDefinition>
}

export interface FirebaseDeploymentManifest {
  schemaVersion: 1
  adapterName: 'firebase-functions'
  generatedAt: string
  build: {
    nextVersion: string | undefined
    buildId: string
    distDir: string
  }
  function: FirebaseFunctionManifest
}

// Alias for the onBuildComplete context parameter type
export type BuildCompleteContext = Parameters<
  NonNullable<import('next').NextAdapter['onBuildComplete']>
>[0]
