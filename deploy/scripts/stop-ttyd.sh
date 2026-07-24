#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Stop ttyd
# ══════════════════════════════════════════════════════════════

PIDFILE_TTYD="/tmp/ttyd.pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}Stopping Web Terminal...${NC}"

# Stop the custom vkbd web UI (public port) first.
bash "$SCRIPT_DIR/stop-ttyd-ui.sh" 2>/dev/null || true

# Stop the ttyd backend
if [ -f "$PIDFILE_TTYD" ]; then
    kill $(cat $PIDFILE_TTYD) 2>/dev/null
    rm -f $PIDFILE_TTYD
    echo "✓ ttyd stopped"
fi

# Kill any remaining processes
pkill -f "ttyd -p" 2>/dev/null

# Stop the clipboard bridge (headless X + whichever xclip owns the selection).
PIDFILE_CLIP="/tmp/ttyd-clipboard-x.pid"
CLIP_DISPLAY="${TTYD_CLIP_DISPLAY:-:77}"
if [ -f "$PIDFILE_CLIP" ]; then
    # xclip holds the selection for this display only; it exits when the
    # server goes away, but kill it first so no orphan lingers.
    pkill -f "xclip -selection clipboard -t image/png" 2>/dev/null
    kill "$(cat "$PIDFILE_CLIP")" 2>/dev/null
    rm -f "$PIDFILE_CLIP" "/tmp/.X11-unix/X${CLIP_DISPLAY#:}" 2>/dev/null
    echo "✓ clipboard bridge stopped"
fi

echo -e "${GREEN}Web Terminal stopped${NC}"
