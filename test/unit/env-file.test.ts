import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/**
 * These tests exercise the .env file generation logic in adapter.ts.
 * Since buildEnvFile/parseEnvFile/serializeEnvFile are not exported,
 * we test through runOnBuildComplete by inspecting the output .env file.
 */

let tmpDir: string

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `env-file-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(path.join(tmpDir, '.next'), { recursive: true })
  // Minimal package.json for buildFunctionsPackageJson
  await writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' },
  }))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

// We import runOnBuildComplete dynamically to work around ESM/TS loader issues.
// The adapter is written as ESM with .js extensions — ts-node or --loader tsx handles it.
async function importAdapter() {
  return import('../../src/adapter.js')
}

function makeBuildContext(projectDir: string) {
  return {
    projectDir,
    distDir: '.next',
    buildId: 'test-build-id',
    nextVersion: '16.2.0',
    config: {},
    routes: { static: [], dynamic: [], api: [], fallback: [] },
    appDir: true,
    pagesDir: false,
    publicDir: path.join(projectDir, 'public'),
  } as any
}

describe('.env file handling via runOnBuildComplete', () => {
  it('writes .env with inline env values', async () => {
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await runOnBuildComplete(makeBuildContext(tmpDir), outDir, {
      env: { FOO: 'bar', BAZ: 'qux' },
    })
    const envContent = await readFile(path.join(outDir, 'functions', '.env'), 'utf8')
    assert.ok(envContent.includes('FOO=bar'))
    assert.ok(envContent.includes('BAZ=qux'))
  })

  it('writes .env from envFilePath', async () => {
    const envPath = path.join(tmpDir, '.env.production')
    await writeFile(envPath, 'DB_HOST=localhost\nDB_PORT=5432\n')
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await runOnBuildComplete(makeBuildContext(tmpDir), outDir, {
      envFilePath: '.env.production',
    })
    const envContent = await readFile(path.join(outDir, 'functions', '.env'), 'utf8')
    assert.ok(envContent.includes('DB_HOST=localhost'))
    assert.ok(envContent.includes('DB_PORT=5432'))
  })

  it('inline env takes precedence over envFilePath for duplicate keys', async () => {
    const envPath = path.join(tmpDir, '.env.local')
    await writeFile(envPath, 'KEY=from-file\nOTHER=kept\n')
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await runOnBuildComplete(makeBuildContext(tmpDir), outDir, {
      envFilePath: '.env.local',
      env: { KEY: 'from-inline' },
    })
    const envContent = await readFile(path.join(outDir, 'functions', '.env'), 'utf8')
    assert.ok(envContent.includes('KEY=from-inline'))
    assert.ok(envContent.includes('OTHER=kept'))
    assert.ok(!envContent.includes('KEY=from-file'))
  })

  it('does not write .env when no env options provided', async () => {
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await runOnBuildComplete(makeBuildContext(tmpDir), outDir, {})
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(path.join(outDir, 'functions', '.env')), false)
  })

  it('does not write .env when env is empty object', async () => {
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await runOnBuildComplete(makeBuildContext(tmpDir), outDir, { env: {} })
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(path.join(outDir, 'functions', '.env')), false)
  })

  it('throws when envFilePath does not exist', async () => {
    const { runOnBuildComplete } = await importAdapter()
    const outDir = path.join(tmpDir, 'firebase-dist')
    await assert.rejects(
      () => runOnBuildComplete(makeBuildContext(tmpDir), outDir, {
        envFilePath: '.env.nonexistent',
      }),
      /Could not read envFilePath/
    )
  })
})
