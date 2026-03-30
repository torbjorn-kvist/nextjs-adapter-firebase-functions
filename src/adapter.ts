import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { NextAdapter } from 'next'
import { generateFirebaseParamsModule } from './firebase-params.js'
import { generateFunctionsEntry } from './runtime-template.js'
import type {
  BuildCompleteContext,
  FirebaseAdapterOptions,
  FirebaseDeploymentManifest,
  FirebaseFunctionManifest,
  FirebaseFunctionsHttpsOptions,
} from './types.js'

export const ADAPTER_NAME = 'firebase-functions'
export const DEFAULT_OUT_DIR = 'firebase-dist'
const DEFAULT_FUNCTION_NAME = 'nextjs'

const DEFAULT_FUNCTION_CONFIG: FirebaseFunctionsHttpsOptions = {
  timeoutSeconds: 60,
  memory: '1GiB',
  minInstances: 0,
  concurrency: 80,
  invoker: 'public',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveOutDir(projectDir: string, outDir: string): string {
  return path.isAbsolute(outDir) ? outDir : path.join(projectDir, outDir)
}

/** Extracts the string name from a secret — accepts both plain strings and SecretParam objects. */
function resolveSecretName(s: string | { name: string }): string {
  return typeof s === 'string' ? s : s.name
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function writeJson(filePath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function copyIfExists(src: string, dest: string): Promise<void> {
  const s = await stat(src).catch(() => null)
  if (!s?.isDirectory() && !s?.isFile()) return
  await cp(src, dest, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Runtime Next.js config (adapter-specific fields stripped)
// ---------------------------------------------------------------------------

function buildRuntimeNextConfig(config: BuildCompleteContext['config']): Record<string, unknown> {
  let cloned: unknown
  try {
    cloned = JSON.parse(JSON.stringify(config))
  } catch {
    console.warn(
      '[adapter-firebase-functions] Could not serialize Next.js config — runtime config will be empty',
    )
    cloned = {}
  }
  const record = toRecord(cloned)

  // Strip adapter/build-time fields
  delete record.outputFileTracingRoot
  delete record.cacheHandler
  delete record.adapterPath

  const experimental = record.experimental
  if (experimental && typeof experimental === 'object') {
    const exp = { ...toRecord(experimental) }
    delete exp.adapterPath
    record.experimental = exp
  }

  // distDir must be relative to functions/ dir at runtime
  record.distDir = '.next'

  return record
}

// ---------------------------------------------------------------------------
// Deployment manifest
// ---------------------------------------------------------------------------

function buildDeploymentManifest(
  ctx: BuildCompleteContext,
  fn: FirebaseFunctionManifest,
): FirebaseDeploymentManifest {
  return {
    schemaVersion: 1,
    adapterName: ADAPTER_NAME,
    generatedAt: new Date().toISOString(),
    build: {
      nextVersion: ctx.nextVersion,
      buildId: ctx.buildId,
      distDir: '.next',
    },
    function: fn,
  }
}

// ---------------------------------------------------------------------------
// Firebase Functions package.json
// ---------------------------------------------------------------------------

/** Read `dependencies` from a package.json, excluding `file:` entries. */
async function readPackageDeps(pkgPath: string): Promise<Record<string, string>> {
  const deps: Record<string, string> = {}
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as Record<string, unknown>
    const raw = toRecord(pkg.dependencies) as Record<string, string>
    // Exclude file: deps — npm installs those as symlinks which Firebase CLI rejects.
    for (const [k, v] of Object.entries(raw)) {
      if (!v.startsWith('file:')) deps[k] = v
    }
  } catch (err) {
    console.warn(
      `[adapter-firebase-functions] Could not read ${pkgPath} — runtime deps may be missing: ${(err as Error).message}`,
    )
  }
  return deps
}

/**
 * Walk up from startDir looking for a workspace root.
 * Detected by: package.json with a `workspaces` field, or a `pnpm-workspace.yaml` file.
 */
async function findWorkspaceRoot(startDir: string): Promise<string | null> {
  let dir = startDir
  while (true) {
    const parent = path.dirname(dir)
    if (parent === dir) return null // filesystem root
    dir = parent
    try {
      const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as Record<
        string,
        unknown
      >
      if (pkg.workspaces) return dir
    } catch {
      /* not a package root, keep walking */
    }
    const pnpmWs = await stat(path.join(dir, 'pnpm-workspace.yaml')).catch(() => null)
    if (pnpmWs) return dir
  }
}

// Packages that are build-time only and must never appear in Cloud Run optionalDependencies.
// These match the linux-x64 filter but are compiler/bundler tools, not runtime native modules.
const BUILD_TOOL_PACKAGE_PREFIXES = [
  '@next/swc-', // Next.js SWC compiler — .next/ is already compiled
  '@esbuild/', // esbuild bundler
  '@swc/', // SWC compiler
  '@rollup/rollup-', // Rollup bundler
  'lightningcss-', // LightningCSS bundler
]

function isBuildToolPackage(name: string): boolean {
  return BUILD_TOOL_PACKAGE_PREFIXES.some(prefix => name.startsWith(prefix))
}

/**
 * Scan deps' own package.json files in node_modules for platform-specific linux-x64
 * optional sub-packages (e.g. sharp → @img/sharp-linux-x64, @napi-rs packages, etc.).
 * This covers any native module that follows the NAPI-RS / sharp sub-package convention.
 * Build-tool packages (@next/swc-*, @esbuild/*, etc.) are excluded — the .next/ build
 * is already compiled and these are not needed at runtime on Cloud Run.
 */
async function detectLinuxOptionalDeps(
  deps: Record<string, string>,
  nodeModulesDirs: string[],
): Promise<Record<string, string>> {
  const optionals: Record<string, string> = {}
  for (const name of Object.keys(deps)) {
    for (const nmDir of nodeModulesDirs) {
      try {
        const depPkg = JSON.parse(
          await readFile(path.join(nmDir, name, 'package.json'), 'utf8'),
        ) as Record<string, unknown>
        const depOptionals = toRecord(depPkg.optionalDependencies) as Record<string, string>
        for (const [optName, optVer] of Object.entries(depOptionals)) {
          if (optName.includes('linux-x64') && !isBuildToolPackage(optName)) {
            optionals[optName] = optVer
          }
        }
        break // found in this node_modules dir — stop searching
      } catch {
        /* dep not in this node_modules dir, try next */
      }
    }
  }
  return optionals
}

async function buildFunctionsPackageJson(
  ctx: BuildCompleteContext,
): Promise<Record<string, unknown>> {
  const projectDeps = await readPackageDeps(path.join(ctx.projectDir, 'package.json'))

  // Detect linux-x64 optional sub-packages for native modules (sharp, @napi-rs/* etc.)
  // Cloud Run is linux-x64; without these, npm install on macOS won't fetch linux binaries.
  // Also scan the workspace root's node_modules so hoisted native packages are covered.
  const workspaceRoot = await findWorkspaceRoot(ctx.projectDir)
  const nodeModulesDirs = [
    path.join(ctx.projectDir, 'node_modules'),
    ...(workspaceRoot ? [path.join(workspaceRoot, 'node_modules')] : []),
  ]
  const optionalDependencies = await detectLinuxOptionalDeps(projectDeps, nodeModulesDirs)

  return {
    name: 'nextjs-firebase-functions',
    version: '1.0.0',
    private: true,
    main: 'index.js',
    // Node 22 is used for both building and the deployed Firebase runtime.
    engines: { node: '22' },
    dependencies: {
      // Project deps only — workspace root deps are intentionally excluded to avoid
      // pulling in unrelated sibling-service deps from monorepo roots.
      ...projectDeps,
      'firebase-admin': projectDeps['firebase-admin'] ?? '^12.0.0',
      'firebase-functions': projectDeps['firebase-functions'] ?? '^7.2.2',
      next: ctx.nextVersion ? `^${ctx.nextVersion}` : (projectDeps.next ?? '*'),
    },
    ...(Object.keys(optionalDependencies).length > 0 && { optionalDependencies }),
  }
}

// ---------------------------------------------------------------------------
// .env file (merged from envFilePath + inline env object)
// ---------------------------------------------------------------------------

/**
 * Parses a .env file into a key→value map. Skips blank lines and # comments.
 * Does not support multiline values or quoted strings with embedded newlines.
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    // Strip optional surrounding quotes from value
    let value = line.slice(eq + 1)
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) result[key] = value
  }
  return result
}

function serializeEnvFile(entries: Record<string, string>): string {
  return `${Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`
}

async function buildEnvFile(
  projectDir: string,
  envFilePath: string | undefined,
  inlineEnv: Record<string, string> | undefined,
): Promise<string | null> {
  const merged: Record<string, string> = {}

  if (envFilePath) {
    const resolved = path.isAbsolute(envFilePath) ? envFilePath : path.join(projectDir, envFilePath)
    try {
      const contents = await readFile(resolved, 'utf8')
      Object.assign(merged, parseEnvFile(contents))
    } catch (err) {
      throw new Error(
        `[adapter-firebase-functions] Could not read envFilePath "${resolved}": ${(err as Error).message}`,
      )
    }
  }

  // Inline env takes precedence
  if (inlineEnv && Object.keys(inlineEnv).length > 0) {
    Object.assign(merged, inlineEnv)
  }

  if (Object.keys(merged).length === 0) return null
  return serializeEnvFile(merged)
}

// ---------------------------------------------------------------------------
// firebase.json (written to project root if absent)
// ---------------------------------------------------------------------------

function buildFirebaseJson(functionsRelDir: string): Record<string, unknown> {
  return {
    functions: [
      {
        source: functionsRelDir,
        codebase: 'nextjs-adapter',
        // /node_modules (leading slash) = root-only in gitignore semantics,
        // so only the top-level node_modules/ is excluded during upload.
        ignore: ['/node_modules', '.git', '*.md'],
        predeploy: ['npm --prefix "$RESOURCE_DIR" install'],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Main build-complete handler
// ---------------------------------------------------------------------------

export async function runOnBuildComplete(
  ctx: BuildCompleteContext,
  configuredOutDir: string,
  options: FirebaseAdapterOptions,
): Promise<void> {
  const outDir = resolveOutDir(ctx.projectDir, configuredOutDir)
  const functionsDir = path.join(outDir, 'functions')

  // Resolve options with defaults
  const functionName = options.functionName ?? DEFAULT_FUNCTION_NAME
  const functionConfig: FirebaseFunctionsHttpsOptions = {
    ...DEFAULT_FUNCTION_CONFIG,
    ...options.functionConfig,
  }
  // Merge secrets from top-level options and functionConfig, normalize to string names.
  // Accepts both plain strings and SecretParam objects (from defineSecret()).
  const rawSecrets = [...(options.secrets ?? []), ...(functionConfig.secrets ?? [])]
  const secrets = [...new Set(rawSecrets.map(resolveSecretName))]
  const params = options.params ?? {}

  // Validate secret names
  for (const name of secrets) {
    if (!/^[A-Z0-9_]+$/.test(name)) {
      console.warn(
        `[adapter-firebase-functions] Secret name "${name}" may not be valid for Cloud Secret Manager (expected [A-Z0-9_]+)`,
      )
    }
  }

  // 1. Clean output directory
  await rm(outDir, { recursive: true, force: true })
  await mkdir(functionsDir, { recursive: true })

  // 2. Copy .next/ build output
  const distDir = path.isAbsolute(ctx.distDir)
    ? ctx.distDir
    : path.join(ctx.projectDir, ctx.distDir)
  // Warn if this was a Turbopack build — .next/node_modules/ will contain machine-specific
  // symlinks that break in Cloud Run. Build with `next build --webpack` for Firebase deploys.
  if (existsSync(path.join(distDir, 'node_modules'))) {
    console.warn(
      '[adapter-firebase-functions] Warning: Turbopack build detected (.next/node_modules/ exists).\n' +
        '  Machine-specific symlinks will break on Cloud Run. Use `next build --webpack` for Firebase deploys.',
    )
  }
  // dereference: true resolves symlinks as a fallback safety measure.
  // filter: skip build-time-only directories that have no runtime value on Cloud Run:
  //   cache/ — webpack/SWC incremental build cache (can be 300-500 MB)
  //   dev/   — Turbopack dev-mode artifacts from `next dev` (can be 400+ MB)
  //   trace  — Next.js build trace files used for bundle analysis only
  const nextExcludeDirs = ['cache', 'dev', 'trace'].map(d => path.join(distDir, d))
  await cp(distDir, path.join(functionsDir, '.next'), {
    recursive: true,
    force: true,
    dereference: true,
    filter: src => !nextExcludeDirs.some(dir => src.startsWith(dir)),
  })

  // 3. Copy public/ if it exists
  await copyIfExists(path.join(ctx.projectDir, 'public'), path.join(functionsDir, 'public'))

  // 4. Write runtime Next.js config
  const runtimeNextConfig = buildRuntimeNextConfig(ctx.config)
  await writeJson(path.join(functionsDir, 'runtime-next-config.json'), runtimeNextConfig)

  // 5. Write deployment manifest
  const fn: FirebaseFunctionManifest = {
    name: functionName,
    // Replace secrets with string names — SecretParam objects are not JSON-serializable.
    // At runtime, index.js always overrides secrets with SecretParam references from firebase-params.js.
    config: { ...functionConfig, secrets },
    params,
  }
  const manifest = buildDeploymentManifest(ctx, fn)
  await writeJson(path.join(functionsDir, 'deployment-manifest.json'), manifest)

  // 6. Write firebase-params.js
  const paramsContent = generateFirebaseParamsModule(secrets, params)
  await writeFile(path.join(functionsDir, 'firebase-params.js'), paramsContent, 'utf8')

  // 7. Write functions/index.js
  const entryContent = generateFunctionsEntry(functionName, secrets, params)
  await writeFile(path.join(functionsDir, 'index.js'), entryContent, 'utf8')

  // 8. Write functions/package.json
  const functionsPackageJson = await buildFunctionsPackageJson(ctx)
  await writeJson(path.join(functionsDir, 'package.json'), functionsPackageJson)

  // 9. Write functions/.gitignore
  await writeFile(path.join(functionsDir, '.gitignore'), 'node_modules/\n.env.local\n', 'utf8')

  // 10. Write functions/.env (merged from envFilePath + inline env)
  const envContent = await buildEnvFile(ctx.projectDir, options.envFilePath, options.env)
  if (envContent !== null) {
    await writeFile(path.join(functionsDir, '.env'), envContent, 'utf8')
    const keyCount = envContent.split('\n').filter(l => l.includes('=')).length
    console.log(`  Env vars: ${keyCount} written to functions/.env`)
  }

  // 11. Write firebase.json to project root if it doesn't exist
  const firebaseJsonPath = path.join(ctx.projectDir, 'firebase.json')
  if (!existsSync(firebaseJsonPath)) {
    const functionsRelDir = path.relative(ctx.projectDir, functionsDir)
    await writeJson(firebaseJsonPath, buildFirebaseJson(functionsRelDir))
    console.log(`[adapter-firebase-functions] Created firebase.json at ${firebaseJsonPath}`)
  }

  console.log(`[adapter-firebase-functions] Build complete → ${outDir}`)
  console.log(
    `  Function: ${functionName} (${functionConfig.memory ?? '1GiB'}, ${functionConfig.timeoutSeconds ?? 60}s timeout)`,
  )
  if (secrets.length > 0) console.log(`  Secrets: ${secrets.join(', ')}`)
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export function createFirebaseAdapter(options: FirebaseAdapterOptions = {}): NextAdapter {
  const configuredOutDir = options.outDir ?? DEFAULT_OUT_DIR

  return {
    name: ADAPTER_NAME,
    modifyConfig(config) {
      // Minimal: pass through unchanged
      // We do not set output: 'standalone' — we copy .next/ directly
      return config
    },
    async onBuildComplete(ctx) {
      await runOnBuildComplete(ctx, configuredOutDir, options)
    },
  }
}
