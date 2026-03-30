#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# Emit markers first (harness parses these with regex)
if [ -f ".adapter-build.log" ]; then
  BUILD_ID_VALUE="$(grep -E '^BUILD_ID: ' .adapter-build.log | tail -n1 | sed 's/^BUILD_ID: //' || true)"
  DEPLOYMENT_ID_VALUE="$(grep -E '^DEPLOYMENT_ID: ' .adapter-build.log | tail -n1 | sed 's/^DEPLOYMENT_ID: //' || true)"
  IMMUTABLE_ASSET_TOKEN_VALUE="$(grep -E '^IMMUTABLE_ASSET_TOKEN: ' .adapter-build.log | tail -n1 | sed 's/^IMMUTABLE_ASSET_TOKEN: //' || true)"
  [ -n "$BUILD_ID_VALUE" ] && echo "BUILD_ID: $BUILD_ID_VALUE"
  [ -n "$DEPLOYMENT_ID_VALUE" ] && echo "DEPLOYMENT_ID: $DEPLOYMENT_ID_VALUE"
  [ -n "${IMMUTABLE_ASSET_TOKEN_VALUE:-}" ] && echo "IMMUTABLE_ASSET_TOKEN: $IMMUTABLE_ASSET_TOKEN_VALUE" || echo "IMMUTABLE_ASSET_TOKEN: undefined"
fi

# Dump all log files
for f in .adapter-build.log .adapter-server.log; do
  if [ -f "$f" ]; then
    echo "=== $f ==="
    cat "$f"
    echo ""
  fi
done
