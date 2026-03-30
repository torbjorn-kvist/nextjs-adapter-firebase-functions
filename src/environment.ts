import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

export interface FirebaseEnvironment {
  /** The active Firebase project ID */
  projectId: string
  /** The alias for this project in .firebaserc (e.g. "default", "staging") */
  alias: string | undefined
  /** All alias → projectId mappings from .firebaserc */
  projects: Record<string, string>
  /** Absolute path to the directory where .firebaserc was found */
  root: string
}

interface FirebaseRC {
  projects?: Record<string, string>
  [key: string]: unknown
}

async function findFirebaseRoot(startDir: string): Promise<string | null> {
  let dir = startDir
  while (true) {
    const s = await stat(path.join(dir, '.firebaserc')).catch(() => null)
    if (s?.isFile()) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Returns the current Firebase environment using `firebase-tools` to resolve
 * the active project, combined with `.firebaserc` for the alias map.
 *
 * Requires `firebase-tools` to be installed (peer dependency).
 *
 * @example
 * import { getFirebaseEnvironment } from 'nextjs-adapter-firebase-functions/environment'
 *
 * const env = await getFirebaseEnvironment()
 * console.log(env?.projectId) // "my-firebase-project"
 * console.log(env?.alias)     // "default"
 *
 * @example Conditional config based on alias
 * const env = await getFirebaseEnvironment()
 * export default createFirebaseAdapter({
 *   functionConfig: {
 *     minInstances: env?.alias === 'production' ? 1 : 0,
 *   },
 * })
 */
export async function getFirebaseEnvironment(options?: {
  cwd?: string
}): Promise<FirebaseEnvironment | null> {
  const cwd = options?.cwd ?? process.cwd()

  // Use firebase-tools to get the active project (same as `firebase use` with no args).
  // Suppress stdout/stderr — firebase-tools prints "Active Project: ..." unconditionally.
  let active: string | undefined
  try {
    const { default: client } = await import('firebase-tools')
    const stdoutWrite = process.stdout.write.bind(process.stdout)
    const stderrWrite = process.stderr.write.bind(process.stderr)
    process.stdout.write = () => true
    process.stderr.write = () => true
    try {
      active = await client.use(undefined, { cwd })
    } finally {
      process.stdout.write = stdoutWrite
      process.stderr.write = stderrWrite
    }
  } catch {
    return null
  }

  if (!active) return null

  const root = await findFirebaseRoot(cwd)
  if (!root) return null

  let firebaserc: FirebaseRC = {}
  try {
    firebaserc = JSON.parse(await readFile(path.join(root, '.firebaserc'), 'utf8')) as FirebaseRC
  } catch {
    return null
  }

  const projects = firebaserc.projects ?? {}

  // `active` may be an alias or a direct project ID — resolve both cases
  const projectId = projects[active] ?? active
  const alias = projects[active]
    ? active
    : Object.entries(projects).find(([, id]) => id === active)?.[0]

  return { projectId, alias, projects, root }
}
