import type { HttpsOptions } from 'firebase-functions/v2/https'

export type { HttpsOptions }

/**
 * Firebase Functions v2 HttpsOptions — passed directly to onRequest().
 * @see https://firebase.google.com/docs/reference/functions/firebase-functions.https.httpsoptions
 */
export type FirebaseFunctionsHttpsOptions = HttpsOptions

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
