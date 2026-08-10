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

# ttyd — the single public process: UI, WebSocket and image paste in one.
if pgrep -f "ttyd -p" > /dev/null; then
    PORT=$(pgrep -af "ttyd -p" | grep -oE '\-p [0-9]+' | awk '{print $2}' | head -1)
    BIND=$(pgrep -af "ttyd -p" | grep -oE '\-i [^ ]+' | awk '{print $2}' | head -1)
    echo -e "  ttyd:        ${GREEN}Running${NC} (${BIND:-0.0.0.0}:${PORT:-10090})"
    echo -e "  URL:         ${CYAN}http://localhost:${PORT:-10090}${NC}"

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

# Image paste is handled by ttyd's authenticated upload endpoint; it needs no
# sidecar process and is available whenever this fork's ttyd is running.
if pgrep -f "ttyd -p" > /dev/null; then
    echo -e "  Image paste: ${GREEN}Running${NC} (temporary-file bridge)"
else
    echo -e "  Image paste: ${RED}Stopped${NC}"
fi

# Dev server — not part of the deployment, but worth flagging when it is up.
if pgrep -f "webpack serve" > /dev/null; then
    DEV_PORT=$(pgrep -af "webpack serve" | grep -oE '\-\-port [0-9]+' | awk '{print $2}' | head -1)
    echo -e "  Dev server:  ${YELLOW}Running${NC} (webpack, port ${DEV_PORT:-9000} — html/ editing only)"
fi

echo ""
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
