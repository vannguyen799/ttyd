#!/usr/bin/env bash
# Stop the custom ttyd web UI dev server (started by start-ttyd-ui.sh).
set -euo pipefail

PID_FILE="/tmp/ttyd-ui.pid"
PORT="${TTYD_UI_PORT:-10090}"

if [[ -f "$PID_FILE" ]]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    # webpack serve spawns a child; kill the whole process group.
    kill -- "-$(ps -o pgid= "$PID" | tr -d ' ')" 2>/dev/null \
      || kill "$PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
fi

# Fallback: nuke anything listening on the port
pkill -f "webpack serve.*--port $PORT" 2>/dev/null || true

echo "[ttyd-ui] stopped (port $PORT)."
