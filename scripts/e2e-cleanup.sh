#!/usr/bin/env bash
set -euo pipefail

cd "$NEXT_TEST_DIR"

# Print pre-shutdown logs
[ -f .adapter-server.log ] && cat .adapter-server.log

# Kill emulator from PID file (graceful then SIGKILL)
if [ -f .adapter-server.pid ]; then
  while IFS= read -r SERVER_PID; do
    kill "$SERVER_PID" 2>/dev/null || true
    for i in $(seq 1 50); do
      kill -0 "$SERVER_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$SERVER_PID" 2>/dev/null || true
  done < .adapter-server.pid
  rm -f .adapter-server.pid
fi

# Also kill anything on the emulator port (fallback)
EMULATOR_PORT_PID="$(lsof -ti :5001 2>/dev/null || true)"
if [ -n "$EMULATOR_PORT_PID" ]; then
  kill "$EMULATOR_PORT_PID" 2>/dev/null || true
fi
