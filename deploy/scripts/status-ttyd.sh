#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Check ttyd status
# ══════════════════════════════════════════════════════════════

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Web Terminal Status${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo ""

UI_PORT="${TTYD_UI_PORT:-10090}"

# Public entry: custom vkbd web UI (webpack) on $UI_PORT
if pgrep -f "webpack serve.*--port $UI_PORT" > /dev/null; then
    echo -e "  Web UI:      ${GREEN}Running${NC} (public, port $UI_PORT)"
    echo -e "  URL:         ${CYAN}http://localhost:$UI_PORT${NC}"
else
    echo -e "  Web UI:      ${RED}Stopped${NC} (public port $UI_PORT)"
fi
echo ""

# Internal backend: ttyd (bound to localhost, proxied by the UI)
if pgrep -f "ttyd -p" > /dev/null; then
    PORT=$(pgrep -af "ttyd -p" | grep -oE '\-p [0-9]+' | awk '{print $2}' | head -1)
    echo -e "  ttyd:        ${GREEN}Running${NC} (internal backend, 127.0.0.1:${PORT:-7681})"

    # Check if auth is enabled
    if pgrep -af "ttyd -p" | grep -q "\-c "; then
        CREDS=$(pgrep -af "ttyd -p" | grep -oE '\-c [^ ]+' | awk '{print $2}' | head -1)
        if [ -n "$CREDS" ]; then
            USER=$(echo "$CREDS" | cut -d: -f1)
            PASS=$(echo "$CREDS" | cut -d: -f2)
            echo -e "  Auth:        ${GREEN}Enabled${NC}"
            echo -e "  Username:    ${CYAN}$USER${NC}"
            echo -e "  Password:    ${CYAN}$PASS${NC}"
        fi
    else
        echo -e "  Auth:        ${YELLOW}Disabled${NC}"
    fi
else
    echo -e "  ttyd:        ${RED}Stopped${NC}"
fi

# Clipboard bridge — what makes browser image paste (Ctrl+V) work.
CLIP_DISPLAY="${TTYD_CLIP_DISPLAY:-:77}"
PIDFILE_CLIP="/tmp/ttyd-clipboard-x.pid"
if [ -f "$PIDFILE_CLIP" ] && kill -0 "$(cat "$PIDFILE_CLIP")" 2>/dev/null; then
    echo -e "  Image paste: ${GREEN}Running${NC} (headless X on $CLIP_DISPLAY)"
else
    echo -e "  Image paste: ${RED}Stopped${NC} (needs xclip + Xvfb)"
fi

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
