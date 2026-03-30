---
title: Research Index — Firebase Functions Adapter for Next.js 16.2
status: complete
author: researcher
---

# docs/

| File | Summary |
|------|---------|
| [[research-nextjs-adapter-api]] | Next.js 16.2 adapter API full reference |
| [[research-firebase-functions-api]] | Firebase Functions v2 onRequest, secrets, params |
| [[design-adapter-architecture]] | Architecture decisions and output structure |
| [[design-firebase-params]] | Secrets/params design pattern |
| [[implementation-plan]] | File list + test notes from implementer |
| [[research-bun-adapter-patterns]] | Bun adapter e2e scripts + fixture patterns |
| [[research-firebase-testing]] | Firebase emulator + my-firebase-project test setup |
| [[research-nextjs-test-harness]] | Deploy/logs/cleanup script contract |
| [adapter-firebase-functions/README.md](../adapter-firebase-functions/README.md) | User-facing docs: install, options, secrets, params, deploy, emulator (task #5 complete) |

## Key Facts (quick reference)

- **Emulator URL**: `http://127.0.0.1:5001/{project-id}/us-central1/nextjsServer`
- **Project IDs**: `my-firebase-project` = real project (local dev, production-parity URLs); `demo-nextjs-test` = offline/no-credentials (CI default). Scripts should default to `demo-nextjs-test`, accept `FIREBASE_PROJECT_ID` override.
- **Deploy script stdout**: Only one line — the URL. Everything else to stderr or log files
- **Log markers order**: `BUILD_ID:`, `DEPLOYMENT_ID:`, `IMMUTABLE_ASSET_TOKEN:` must come first in logs script output
- **Secrets**: Both `secretRef.value()` and `process.env.SECRET_NAME` work in production; emulator reads `.secret.local`
- **Port selection**: Random port via `net.createServer` on port 0, same pattern as bun adapter
- **PID tracking**: Write emulator PID to `.adapter-server.pid`, cleanup script reads it
- **Parallel safety**: Each test shard needs its own emulator port; generate per-test `firebase.json`
- **Test timeout**: 4 minutes (`NEXT_E2E_TEST_TIMEOUT=240000`)
