#!/bin/bash
# ══════════════════════════════════════════════════════════════
# ttyd - Web Terminal (Local)
# Access terminal from any browser on localhost
# ══════════════════════════════════════════════════════════════
#
# Usage:
#   ./start-ttyd.sh [OPTIONS]
#
# Options:
#   -p, --password PASSWORD    Set terminal password (default: random 8-char)
#   -P, --port PORT            Set ttyd port (default: 7681)
#   -u, --username USERNAME    Set username (default: user)
#   -n, --no-auth              Disable authentication
#   -h, --help                 Show this help
#
# Environment variables:
#   TTYD_PASSWORD              Terminal password (overridden by -p)
#   TTYD_USERNAME              Username (overridden by -u)
#   TTYD_PORT                  Port (overridden by -P)
# ══════════════════════════════════════════════════════════════

PIDFILE_TTYD="/tmp/ttyd.pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_WRAPPER="$SCRIPT_DIR/ttyd-session.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# Generate random password
generate_password() {
    cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1
}

# Default values
PORT="${TTYD_PORT:-7681}"          # internal ttyd backend port (localhost only)
UI_PORT="${TTYD_UI_PORT:-10090}"   # public port: custom vkbd UI (start-ttyd-ui.sh)
USERNAME="${TTYD_USERNAME:-user}"
PASSWORD="${TTYD_PASSWORD:-$(generate_password)}"
NO_AUTH=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--password)
            PASSWORD="$2"
            shift 2
            ;;
        -P|--port)
            PORT="$2"
            shift 2
            ;;
        -u|--username)
            USERNAME="$2"
            shift 2
            ;;
        -n|--no-auth)
            NO_AUTH=true
            shift
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -p, --password PASSWORD    Set terminal password (default: random 8-char)"
            echo "  -P, --port PORT            Set ttyd port (default: 7681)"
            echo "  -u, --username USERNAME    Set username (default: user)"
            echo "  -n, --no-auth              Disable authentication"
            echo "  -h, --help                 Show this help"
            echo ""
            echo "Examples:"
            echo "  $0                         # Local with random password"
            echo "  $0 -p mysecret             # Custom password"
            echo "  $0 -n                      # No authentication"
            echo "  $0 -u admin -p secret123   # Custom user/pass"
            echo ""
            echo "Environment variables:"
            echo "  TTYD_PASSWORD, TTYD_USERNAME, TTYD_PORT"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage"
            exit 1
            ;;
    esac
done

# Check and install package via nix-env if not found.
#
# Only the -iA form is used. A bare `nix-env -i <name>` has to evaluate every
# derivation in nixpkgs to match by name, which grew to 24 GB of RSS on this
# workstation and drove it to the edge of OOM on every workspace start. -iA
# looks the attribute up directly and costs almost nothing. Declaring the
# package in dev.nix is better still: it is fetched once and GC-rooted.
ensure_package() {
    local cmd=$1
    local pkg=$2

    if ! command -v $cmd &> /dev/null; then
        echo -e "${YELLOW}$cmd not found. Installing via nix-env -iA...${NC}"
        nix-env -iA nixpkgs.$pkg 2>/dev/null
        if ! command -v $cmd &> /dev/null; then
            echo -e "${RED}Failed to install $pkg. Add to dev.nix: pkgs.$pkg${NC}"
            return 1
        fi
        echo -e "${GREEN}$pkg installed successfully${NC}"
    fi
    return 0
}

echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  ttyd - Starting Web Terminal${NC}"
echo -e "${CYAN}══════════════════════════════════════════════════════════════${NC}"
echo ""

# Ensure dependencies (auto-install if missing)
ensure_package "ttyd" "ttyd" || exit 1
ensure_package "tmux" "tmux" || echo -e "${YELLOW}Warning: tmux missing, default sessions will fall back to shell${NC}"
command -v screen >/dev/null 2>&1 || echo -e "${YELLOW}Warning: screen not installed, /screen/<name> routes will fall back to shell${NC}"
# Clipboard bridge deps — optional: only browser image paste depends on them.
ensure_package "xclip" "xclip" || echo -e "${YELLOW}Warning: xclip missing, browser image paste disabled${NC}"
ensure_package "Xvfb" "xorg.xorgserver" || echo -e "${YELLOW}Warning: Xvfb missing, browser image paste disabled${NC}"

# Kill existing processes
if [ -f "$PIDFILE_TTYD" ]; then
    kill $(cat $PIDFILE_TTYD) 2>/dev/null
    rm -f $PIDFILE_TTYD
fi

# Verify wrapper exists
if [ ! -x "$SESSION_WRAPPER" ]; then
    echo -e "${RED}Error: session wrapper not found or not executable: $SESSION_WRAPPER${NC}"
    exit 1
fi

# ── tmux session persistence (resurrect + continuum) ───────────
# Wire ~/.tmux.conf to source the kit's persistence config (idempotent),
# then kick the tmux server so tmux-continuum auto-restores saved sessions
# on boot — before any browser connects. Plugins come from dev.nix; if
# they're absent the config's if-shell guards make it a no-op.
PERSIST_CONF="$(cd "$SCRIPT_DIR/.." && pwd)/config/tmux-persist.conf"
if command -v tmux >/dev/null 2>&1 && [ -f "$PERSIST_CONF" ]; then
    USER_TMUX_CONF="$HOME/.tmux.conf"
    SOURCE_LINE="source-file $PERSIST_CONF"
    touch "$USER_TMUX_CONF"
    if ! grep -qF "$SOURCE_LINE" "$USER_TMUX_CONF" 2>/dev/null; then
        {
            echo ""
            echo "# firebase-nix-kit: tmux session persistence (resurrect + continuum)"
            echo "$SOURCE_LINE"
        } >> "$USER_TMUX_CONF"
        echo -e "${GREEN}✓ Linked tmux persistence config into ~/.tmux.conf${NC}"
    fi
    # Starting the server loads the config → continuum restores saved
    # sessions. Harmless (idle empty server) if there's nothing to restore.
    if ! tmux has-session 2>/dev/null; then
        tmux start-server 2>/dev/null || true
    fi
fi

# ── clipboard bridge (image paste from the browser) ────────────
# A browser tab can't reach the host clipboard, so Ctrl+V never finds an
# image and Claude Code can't be given screenshots. Fix: run a 1x1 headless
# X display whose only job is holding a clipboard selection. The web UI
# POSTs a pasted image to /clipboard-image (webpack.config.js), which loads
# it into that clipboard via xclip; Ctrl+V in Claude then works natively.
# Exporting DISPLAY here is what makes it reach Claude: ttyd inherits it →
# ttyd-session.sh → tmux → the agent process.
CLIP_DISPLAY="${TTYD_CLIP_DISPLAY:-:77}"
if bash "$SCRIPT_DIR/start-clipboard-x.sh"; then
    export DISPLAY="$CLIP_DISPLAY"
    export TTYD_CLIP_DISPLAY="$CLIP_DISPLAY"
    echo -e "${GREEN}✓ clipboard bridge ready (DISPLAY=$CLIP_DISPLAY)${NC}"
    # tmux only copies DISPLAY into sessions created *after* this point
    # (update-environment). Seed the global env so new sessions inherit it;
    # panes already running keep their old env and need a restart.
    if command -v tmux >/dev/null 2>&1 && tmux has-session 2>/dev/null; then
        tmux setenv -g DISPLAY "$CLIP_DISPLAY" 2>/dev/null || true
    fi
else
    echo -e "${YELLOW}⚠ clipboard bridge unavailable — image paste will be disabled${NC}"
fi

# ── xterm.js client options ────────────────────────────────────
# Ayu Dark palette — matches the integrated terminal in VSCode Ayu.
TTYD_THEME='{"background":"#181818","foreground":"#BFBDB6","cursor":"#E6B450","cursorAccent":"#181818","selectionBackground":"#409FFF4D","black":"#11131A","red":"#D95757","green":"#7FD962","yellow":"#E6B450","blue":"#59C2FF","magenta":"#D2A6FF","cyan":"#95E6CB","white":"#C7C7C7","brightBlack":"#686868","brightRed":"#F07178","brightGreen":"#AAD94C","brightYellow":"#FFB454","brightBlue":"#59C2FF","brightMagenta":"#D2A6FF","brightCyan":"#95E6CB","brightWhite":"#FFFFFF"}'
TTYD_FONT='MesloLGS NF, Menlo, Monaco, Consolas, "Courier New", monospace'

# Build ttyd command with or without auth.
# -a: allow URL args (?arg=...&arg=...) to be passed to the wrapper for
# tmux/screen auto-attach routing. See ttyd-session.sh for URL scheme.
# -t theme/fontFamily/fontSize: VSCode Dark+ look.
# -t macOptionClickForcesSelection: on macOS, xterm's shift-to-select
#   bypass doesn't apply — the modifier is Option, and only when this is
#   on. Lets Mac users ⌥+drag to make a real xterm selection (then plain
#   Cmd+C copies), matching Shift+drag on Windows/Linux. Primary copy path
#   is still the OSC 52 clipboard bridge in tmux-persist.conf.
# -i 127.0.0.1: bind the ttyd backend to localhost ONLY — never exposed
#   externally. The single public entry is the custom vkbd UI on port
#   $UI_PORT (start-ttyd-ui.sh), which proxies /ws + /token to this backend.
echo -e "${YELLOW}Starting ttyd backend on 127.0.0.1:$PORT (internal)...${NC}"
COMMON_OPTS=(-p "$PORT" -i 127.0.0.1 -W -a
    -t "theme=$TTYD_THEME"
    -t "fontFamily=$TTYD_FONT"
    -t "fontSize=14"
    -t "cursorBlink=true"
    -t "macOptionClickForcesSelection=true"
)
# Credential file for the custom vkbd UI server (start-ttyd-ui.sh). Safari/iOS
# can't send the Authorization header on the WebSocket upgrade, so the webpack
# proxy injects it from this file (base64 "user:pass" — same value ttyd's
# /token returns). See ../../html/webpack.config.js readTtydCredential().
CRED_FILE="/tmp/ttyd.cred"
if [ "$NO_AUTH" = true ]; then
    rm -f "$CRED_FILE"
    ttyd "${COMMON_OPTS[@]}" "$SESSION_WRAPPER" &
    AUTH_MSG="None (open access)"
else
    printf '%s' "$USERNAME:$PASSWORD" | base64 -w0 > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    ttyd "${COMMON_OPTS[@]}" -c "$USERNAME:$PASSWORD" "$SESSION_WRAPPER" &
    AUTH_MSG="$USERNAME / $PASSWORD"
fi
echo $! > $PIDFILE_TTYD
sleep 2

# Check ttyd started
if ! kill -0 $(cat $PIDFILE_TTYD) 2>/dev/null; then
    echo -e "${RED}Error: ttyd failed to start${NC}"
    exit 1
fi
echo -e "${GREEN}✓ ttyd backend started (127.0.0.1:$PORT)${NC}"

# ── custom vkbd web UI — the single public port ────────────────
# webpack dev server on $UI_PORT serves the virtual-keyboard UI and proxies
# /ws + /token to the localhost ttyd backend above. This is the only port
# users/tunnels should reach; the raw ttyd backend stays internal.
echo -e "${YELLOW}Starting custom web UI on port $UI_PORT...${NC}"
if TTYD_UI_PORT="$UI_PORT" bash "$SCRIPT_DIR/start-ttyd-ui.sh"; then
    echo -e "${GREEN}✓ web UI started (port $UI_PORT)${NC}"
else
    echo -e "${YELLOW}⚠ web UI failed to start — backend is still up on 127.0.0.1:$PORT${NC}"
fi

echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  WEB TERMINAL READY${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
echo ""

echo -e "  ${CYAN}URL:${NC} http://localhost:$UI_PORT"
echo ""
echo -e "  ${CYAN}Session routing (auto-attach):${NC}"
echo -e "    default (tmux main):   http://localhost:$UI_PORT/"
echo -e "    tmux <name>:           http://localhost:$UI_PORT/?arg=<name>"
echo -e "    screen <name>:         http://localhost:$UI_PORT/?arg=screen&arg=<name>"
echo -e "  ${CYAN}Modifiers (stack before session spec):${NC}"
echo -e "    cwd:<path>             chdir before launch"
echo -e "    codex                  run \`codex\` (no args) on first-create"
echo -e "    codex:<args>           run \`codex <args>\` on first-create"
echo -e "    claude                 run \`claude\` (no args) on first-create"
echo -e "    claude:<args>          run \`claude <args>\` on first-create"
echo -e "    e.g.  http://localhost:$UI_PORT/?arg=cwd:/home/user/MetrixCRM&arg=codex&arg=crm"

echo ""
if [ "$NO_AUTH" = true ]; then
    echo -e "  ${CYAN}Auth:${NC} ${YELLOW}Disabled (open access)${NC}"
else
    echo -e "  ${CYAN}Username:${NC} $USERNAME"
    echo -e "  ${CYAN}Password:${NC} $PASSWORD"
fi

echo ""
echo -e "  Stop: ${CYAN}bash $SCRIPT_DIR/stop-ttyd.sh${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
