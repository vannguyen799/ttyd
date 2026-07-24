#!/usr/bin/env bash
# Start custom ttyd web UI (virtual-keyboard build from this ttyd fork).
# Serves http://localhost:$PORT and proxies /ws + /token to ttyd backend.
set -euo pipefail

# These deploy scripts live at <ttyd-fork>/deploy/scripts, so the fork root
# (which holds the html/ vkbd frontend) is two levels up.
TTYD_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HTML_DIR="$TTYD_DIR/html"
PORT="${TTYD_UI_PORT:-10090}"
PID_FILE="/tmp/ttyd-ui.pid"
LOG_FILE="/tmp/ttyd-ui.log"

if [[ ! -f "$HTML_DIR/package.json" ]]; then
  echo "[ttyd-ui] error: html frontend not found at $HTML_DIR. Aborting." >&2
  exit 1
fi

# Skip if port already taken
if ss -tln 2>/dev/null | awk '{print $4}' | grep -qE ":$PORT\$"; then
  echo "[ttyd-ui] port $PORT already in use — nothing to do."
  exit 0
fi

# Enable corepack yarn if needed
if ! command -v yarn >/dev/null 2>&1; then
  corepack enable >/dev/null 2>&1 || true
fi
if ! command -v yarn >/dev/null 2>&1; then
  echo "[ttyd-ui] error: yarn not found. Enable corepack or install node >=12." >&2
  exit 1
fi

cd "$HTML_DIR"

# Install deps if missing
if [[ ! -d node_modules ]]; then
  echo "[ttyd-ui] installing deps in $HTML_DIR..."
  yarn install >/tmp/ttyd-ui-install.log 2>&1
fi

nohup yarn webpack serve \
  --port "$PORT" \
  --host 0.0.0.0 \
  --allowed-hosts all \
  >"$LOG_FILE" 2>&1 &

PID=$!
echo "$PID" > "$PID_FILE"
echo "[ttyd-ui] started on port $PORT (PID $PID). Log: $LOG_FILE"
