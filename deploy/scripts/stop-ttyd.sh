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

# Stop the webpack dev server if one is running. It is not part of the normal
# deployment any more — ttyd serves the UI itself — but it may be up from a
# html/ editing session, and leaving it holding the port would be confusing.
bash "$SCRIPT_DIR/stop-ttyd-ui.sh" >/dev/null 2>&1 || true

# Stop ttyd
if [ -f "$PIDFILE_TTYD" ]; then
    kill $(cat $PIDFILE_TTYD) 2>/dev/null
    rm -f $PIDFILE_TTYD
    echo "✓ ttyd stopped"
fi

# Kill any remaining processes
pkill -f "ttyd -p" 2>/dev/null

echo -e "${GREEN}Web Terminal stopped${NC}"
