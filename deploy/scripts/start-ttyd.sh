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
#   -P, --port PORT            Public port to serve on (default: 10090)
#   -u, --username USERNAME    Set username (default: user)
#   -b, --bind ADDRESS         Address to bind (default: 0.0.0.0)
#   -n, --no-auth              Disable authentication
#   -F, --foreground           Run ttyd in the foreground (for systemd)
#   -h, --help                 Show this help
#   -- ARG...                  Default wrapper args for a bare URL
#
# Environment variables:
#   TTYD_PASSWORD              Terminal password (overridden by -p)
#   TTYD_USERNAME              Username (overridden by -u)
#   TTYD_PORT                  Port (overridden by -P)
#   TTYD_BIND                  Bind address (overridden by -b)
#   TTYD_BIN                   ttyd binary to run (default: the fork's build)
#   TTYD_SESSION_ARGS          Default wrapper args (overridden by -- ARG...)
#   TTYD_TABS_FILE             Where the UI stores its tab layout
#                              (default: ~/.local/state/ttyd/tabs.json,
#                              empty = keep the layout per-browser)
# ══════════════════════════════════════════════════════════════

PIDFILE_TTYD="/tmp/ttyd.pid"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_WRAPPER="$SCRIPT_DIR/ttyd-session.sh"
# These deploy scripts live at <fork>/deploy/scripts, so the fork root — which
# holds the C sources and the embedded UI in src/html.h — is two levels up.
FORK_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# User-installed CLIs such as Claude Code commonly live here. Services often
# start with a minimal PATH that omits it, so make it available to ttyd and
# every session launched by the wrapper.
if [ -n "${HOME:-}" ]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

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

# Default values.
#
# One process, one port: the fork's ttyd serves the vkbd UI itself (it is
# baked into the binary via src/html.h), so there is no webpack proxy in
# front of it any more. The default stays 10090 — the port this deployment
# has always been reached on — rather than ttyd's own 7681.
PORT="${TTYD_PORT:-${TTYD_UI_PORT:-10090}}"
BIND="${TTYD_BIND:-0.0.0.0}"
USERNAME="${TTYD_USERNAME:-user}"
PASSWORD="${TTYD_PASSWORD:-$(generate_password)}"
# Whether the password was chosen rather than generated. A service must not get
# a fresh random password on every restart, so foreground mode insists on one.
PASSWORD_SET=false
[ -n "${TTYD_PASSWORD:-}" ] && PASSWORD_SET=true
NO_AUTH=false
FOREGROUND=false

# Wrapper args used when the URL carries none of its own (?arg=...). The UI
# sends per-tab args, so these only decide what a bare "/" opens — which is how
# a service pins the deployment's home session.
SESSION_ARGS=()
if [ -n "${TTYD_SESSION_ARGS:-}" ]; then
    read -r -a SESSION_ARGS <<< "$TTYD_SESSION_ARGS"
fi

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--password)
            PASSWORD="$2"
            PASSWORD_SET=true
            shift 2
            ;;
        -P|--port)
            PORT="$2"
            shift 2
            ;;
        -b|--bind)
            BIND="$2"
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
        -F|--foreground)
            FOREGROUND=true
            shift
            ;;
        --)
            shift
            SESSION_ARGS=("$@")
            break
            ;;
        -h|--help)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  -p, --password PASSWORD    Set terminal password (default: random 8-char)"
            echo "  -P, --port PORT            Public port to serve on (default: 10090)"
            echo "  -u, --username USERNAME    Set username (default: user)"
            echo "  -b, --bind ADDRESS         Address to bind (default: 0.0.0.0)"
            echo "  -n, --no-auth              Disable authentication"
            echo "  -F, --foreground           Run ttyd in the foreground (for systemd)"
            echo "  -h, --help                 Show this help"
            echo "  -- ARG...                  Default wrapper args for a bare URL"
            echo ""
            echo "Examples:"
            echo "  $0                         # Local with random password"
            echo "  $0 -p mysecret             # Custom password"
            echo "  $0 -n                      # No authentication"
            echo "  $0 -u admin -p secret123   # Custom user/pass"
            echo "  $0 -b 127.0.0.1            # Reachable only through a local proxy/tunnel"
            echo "  $0 -F -- name:main codex   # Foreground, bare URL opens tmux \"main\" + codex"
            echo ""
            echo "Environment variables:"
            echo "  TTYD_PASSWORD, TTYD_USERNAME, TTYD_PORT, TTYD_BIND, TTYD_BIN,"
            echo "  TTYD_SESSION_ARGS"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage"
            exit 1
            ;;
    esac
done

# A generated password is fine for an interactive start — it is printed right
# there — but a service would mint a new one on every restart and nobody would
# ever see it. Make the caller supply one instead of failing silently later.
if [ "$FOREGROUND" = true ] && [ "$NO_AUTH" = false ] && [ "$PASSWORD_SET" = false ]; then
    echo "Error: --foreground needs a fixed password: pass -p, set TTYD_PASSWORD, or use -n." >&2
    exit 1
fi

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

# Resolve the ttyd binary to run.
#
# It must be THIS fork's build, not a distro/nix ttyd: the vkbd UI, the tab
# bar and the /image-upload endpoint all live in the binary now. Stock ttyd
# would come up serving its own default UI and image paste would 404, which is
# a confusing way to fail — so build from the checkout rather than fall back.
#
# Rebuild only when the binary is missing or older than a source file, so a
# normal restart stays instant.
#
# A failed rebuild must never take the terminal down. On an IDX workspace the
# bare cmake call cannot succeed at all — IDX materializes .idx/dev.nix packages
# in /usr/bin as their *default* output only, so gcc and cmake are on PATH while
# zlib.h and libwebsockets.pc are not. Two fallbacks cover that:
#   1. retry the build inside nix-shell, which does expose the -dev outputs;
#   2. if that is unavailable or also fails, run the binary already in build/.
# Stale code is a far smaller failure than no web terminal — on 2026-08-03 this
# exact rebuild failed and left ttyd dead for 45 minutes with the watchdog
# looping restart→fail, because a start script cannot fix a broken toolchain.

# Packages the fork needs to compile; kept next to the nix-shell call that is
# the only consumer, so adding a dependency to CMakeLists means editing one list.
NIX_BUILD_DEPS="libwebsockets json_c libuv zlib openssl pkg-config cmake gcc gnumake"

# Both build attempts append to the same log so a failure report is complete.
bare_build() {
    cmake -S "$FORK_ROOT" -B "$FORK_ROOT/build" -DCMAKE_BUILD_TYPE=Release >/tmp/ttyd-build.log 2>&1 \
        && cmake --build "$FORK_ROOT/build" -j "$(nproc)" >>/tmp/ttyd-build.log 2>&1
}

# A failed configure leaves a CMakeCache.txt pinning the toolchain it rejected,
# and cmake refuses to reconfigure the same build dir with a different compiler.
# Clearing it is what makes the nix-shell retry meaningful rather than a replay.
nix_shell_build() {
    rm -rf "$FORK_ROOT/build/CMakeCache.txt" "$FORK_ROOT/build/CMakeFiles"
    nix-shell -p $NIX_BUILD_DEPS --run "
        cmake -S '$FORK_ROOT' -B '$FORK_ROOT/build' -DCMAKE_BUILD_TYPE=Release &&
        cmake --build '$FORK_ROOT/build' -j \"\$(nproc)\"
    " >>/tmp/ttyd-build.log 2>&1
}

resolve_ttyd_bin() {
    if [ -n "${TTYD_BIN:-}" ]; then
        [ -x "$TTYD_BIN" ] || { echo -e "${RED}Error: TTYD_BIN=$TTYD_BIN is not executable${NC}"; return 1; }
        return 0
    fi

    TTYD_BIN="$FORK_ROOT/build/ttyd"
    if [ ! -f "$FORK_ROOT/CMakeLists.txt" ]; then
        echo -e "${RED}Error: fork sources not found at $FORK_ROOT${NC}"
        return 1
    fi

    local newest
    newest=$(find "$FORK_ROOT/src" "$FORK_ROOT/CMakeLists.txt" -newer "$TTYD_BIN" -print -quit 2>/dev/null)
    if [ -x "$TTYD_BIN" ] && [ -z "$newest" ]; then
        return 0
    fi

    if ! command -v cmake >/dev/null 2>&1; then
        echo -e "${RED}Error: cmake not found — needed to build the ttyd fork.${NC}"
        echo -e "${YELLOW}Run deploy/scripts/setup-ubuntu-vps.sh, or set TTYD_BIN to a prebuilt fork binary.${NC}"
        return 1
    fi

    echo -e "${YELLOW}Building ttyd from $FORK_ROOT (sources changed or no binary yet)...${NC}"
    if bare_build; then
        echo -e "${GREEN}✓ built $TTYD_BIN${NC}"
        return 0
    fi

    if command -v nix-shell >/dev/null 2>&1; then
        echo -e "${YELLOW}Build failed — retrying inside nix-shell (dev outputs)...${NC}"
        if nix_shell_build; then
            echo -e "${GREEN}✓ built $TTYD_BIN via nix-shell${NC}"
            return 0
        fi
    fi

    # Every build path failed. Serving the previous binary keeps the terminal
    # reachable, which is also the only way in to fix the build.
    if [ -x "$TTYD_BIN" ]; then
        echo -e "${RED}Error: build failed. See /tmp/ttyd-build.log${NC}"
        echo -e "${YELLOW}⚠ running the existing binary instead — it predates the current sources.${NC}"
        return 0
    fi

    echo -e "${RED}Error: build failed and no previous binary exists. See /tmp/ttyd-build.log${NC}"
    return 1
}

# Repair a stale libwebsockets RUNPATH.
#
# On a nix-backed box (this workspace) the binary is linked with a RUNPATH that
# pins the exact /nix/store/<hash>-libwebsockets-<ver> directory present at build
# time. When that store path is later collected or rotated to a new version, the
# binary still asks for the dead path and dies at exec with
# "libwebsockets.so.19: cannot open shared object file" — which is what took the
# terminal down after the 2026-08-01 reboot (4.3.2 built, 4.3.5 installed).
#
# /usr/lib/libwebsockets.so.19 is the stable, version-agnostic handle: it is a
# symlink that always points at whichever store path is current. Resolving it at
# START time and prepending its directory means a rotated store path is picked up
# on the next restart instead of bricking the binary.
#
# Only prepend the libwebsockets dir, never the aggregate idx-env lib dir — that
# one also carries a libc.so.6 that conflicts with the binary's own glibc
# ("undefined symbol: __tunable_is_initialized").
#
# No-op when the binary loads fine (a non-nix VPS, or a still-valid RUNPATH).
repair_lws_runpath() {
    "$TTYD_BIN" --version >/dev/null 2>&1 && return 0

    local lws_dir
    lws_dir=$(dirname "$(readlink -f /usr/lib/libwebsockets.so.19 2>/dev/null)" 2>/dev/null)
    [ -f "$lws_dir/libwebsockets.so.19" ] || return 0

    export LD_LIBRARY_PATH="$lws_dir${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    if "$TTYD_BIN" --version >/dev/null 2>&1; then
        echo -e "${GREEN}✓ libwebsockets resolved via $lws_dir (build-time RUNPATH is stale)${NC}"
    fi
}

# Ensure dependencies (auto-install if missing)
resolve_ttyd_bin || exit 1
repair_lws_runpath
ensure_package "tmux" "tmux" || echo -e "${YELLOW}Warning: tmux missing, default sessions will fall back to shell${NC}"
command -v screen >/dev/null 2>&1 || echo -e "${YELLOW}Warning: screen not installed, /screen/<name> routes will fall back to shell${NC}"

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
# make sure the plugins it needs are actually on disk, then kick the tmux
# server so tmux-continuum auto-restores saved sessions on boot — before any
# browser connects.

# resurrect and continuum are plain shell scripts; TPM only ever downloaded
# them. Nix installs them when dev.nix is in play, and everywhere else a git
# checkout in ~/.tmux/plugins does the same job — which matters because a
# missing plugin is silent: the config's guards turn the whole persistence
# layer into a no-op and layouts are lost at the next reboot without a word.
TMUX_PLUGIN_DIR="$HOME/.tmux/plugins"
ensure_tmux_plugin() {
    local repo="$1" name="$2"
    [ -x "$HOME/.nix-profile/share/tmux-plugins/$name/$name.tmux" ] && return 0
    [ -x "$TMUX_PLUGIN_DIR/$repo/$name.tmux" ] && return 0
    if ! command -v git >/dev/null 2>&1; then
        echo -e "${YELLOW}Warning: git missing, cannot install tmux-$name — sessions won't survive a reboot${NC}"
        return 1
    fi
    echo -e "${YELLOW}Installing tmux-$name into $TMUX_PLUGIN_DIR...${NC}"
    mkdir -p "$TMUX_PLUGIN_DIR"
    if ! git clone --depth 1 -q "https://github.com/tmux-plugins/$repo.git" "$TMUX_PLUGIN_DIR/$repo" 2>/dev/null; then
        rm -rf "${TMUX_PLUGIN_DIR:?}/$repo"
        echo -e "${YELLOW}Warning: could not fetch tmux-$name — sessions won't survive a reboot${NC}"
        return 1
    fi
    return 0
}

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

    PERSIST_READY=true
    ensure_tmux_plugin tmux-resurrect resurrect || PERSIST_READY=false
    ensure_tmux_plugin tmux-continuum continuum || PERSIST_READY=false

    # The hook that turns saved claude/codex panes into resume commands. The
    # persistence config is sourced by absolute path and so cannot locate its
    # own checkout; this symlink is the fixed name it refers to.
    mkdir -p "$HOME/.tmux"
    ln -sfn "$SCRIPT_DIR/resurrect-agent-hook.sh" "$HOME/.tmux/ttyd-agent-hook.sh"

    if [ "$PERSIST_READY" = true ]; then
        echo -e "${GREEN}✓ tmux persistence ready (layout + agent sessions restore on reboot)${NC}"
    fi

    # Starting the server loads the config → continuum restores saved
    # sessions. Harmless (idle empty server) if there's nothing to restore.
    # An already-running server predates any of the above, so re-source the
    # config there instead: continuum only auto-restores on a server that
    # started seconds ago, so this picks up the plugins without disturbing
    # the sessions already open.
    if ! tmux has-session 2>/dev/null; then
        tmux start-server 2>/dev/null || true
    else
        tmux source-file "$USER_TMUX_CONF" 2>/dev/null || true
    fi
fi

print_banner() {
    echo ""
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  WEB TERMINAL READY${NC}"
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
    echo ""

    echo -e "  ${CYAN}URL:${NC} http://localhost:$PORT"
    echo ""
    echo -e "  ${CYAN}Session routing (auto-attach):${NC}"
    echo -e "    default (tmux main):   http://localhost:$PORT/"
    echo -e "    tmux <name>:           http://localhost:$PORT/?arg=<name>"
    echo -e "    screen <name>:         http://localhost:$PORT/?arg=screen&arg=<name>"
    echo -e "  ${CYAN}Modifiers (stack before session spec):${NC}"
    echo -e "    cwd:<path>             chdir before launch"
    echo -e "    codex                  run \`codex\` (no args) on first-create"
    echo -e "    codex:<args>           run \`codex <args>\` on first-create"
    echo -e "    claude                 run \`claude\` (no args) on first-create"
    echo -e "    claude:<args>          run \`claude <args>\` on first-create"
    echo -e "    e.g.  http://localhost:$PORT/?arg=cwd:/home/user/MetrixCRM&arg=codex&arg=crm"
    if [ ${#SESSION_ARGS[@]} -gt 0 ]; then
        echo -e "  ${CYAN}Bare-URL default:${NC} ${SESSION_ARGS[*]}"
    fi

    echo ""
    if [ "$NO_AUTH" = true ]; then
        echo -e "  ${CYAN}Auth:${NC} ${YELLOW}Disabled (open access)${NC}"
    else
        echo -e "  ${CYAN}Username:${NC} $USERNAME"
        # Under a service this line goes to the journal, so print where the
        # password came from rather than the password itself.
        if [ "$FOREGROUND" = true ]; then
            echo -e "  ${CYAN}Password:${NC} (as configured)"
        else
            echo -e "  ${CYAN}Password:${NC} $PASSWORD"
        fi
    fi

    echo ""
    if [ "$FOREGROUND" = true ]; then
        echo -e "  Stop: ${CYAN}systemctl stop ttyd${NC} (if run as the packaged service)"
    else
        echo -e "  Stop: ${CYAN}bash $SCRIPT_DIR/stop-ttyd.sh${NC}"
    fi
    echo -e "${GREEN}══════════════════════════════════════════════════════════════${NC}"
}

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
# -i $BIND: ttyd is the public entry point now, so it binds publicly by
#   default. Pass -b 127.0.0.1 to keep it local and put a tunnel or reverse
#   proxy in front.
echo -e "${YELLOW}Starting ttyd on $BIND:$PORT...${NC}"
COMMON_OPTS=(-p "$PORT" -i "$BIND" -W -a
    -t "theme=$TTYD_THEME"
    -t "fontFamily=$TTYD_FONT"
    -t "fontSize=14"
    -t "cursorBlink=true"
    -t "macOptionClickForcesSelection=true"
)

# Tab layout storage. Without this the UI keeps its tab list in localStorage,
# so the same deployment opened on a phone and a laptop shows two unrelated
# sets of tabs and clearing site data loses the list while every tmux session
# behind it keeps running. Set TTYD_TABS_FILE= (empty) to opt back out.
TABS_FILE="${TTYD_TABS_FILE-$HOME/.local/state/ttyd/tabs.json}"
if [ -n "$TABS_FILE" ]; then
    if mkdir -p "$(dirname "$TABS_FILE")" 2>/dev/null; then
        COMMON_OPTS+=(--tabs-file "$TABS_FILE")
    else
        echo -e "${YELLOW}Warning: cannot create $(dirname "$TABS_FILE") — tab layout stays per-browser${NC}"
    fi
fi
# Credential file. ttyd itself does not read it — it only exists for the
# webpack dev server (start-ttyd-ui.sh), which still proxies to this instance
# when you are iterating on html/. Keep it in sync so switching to dev mode
# needs no restart.
CRED_FILE="/tmp/ttyd.cred"
if [ "$NO_AUTH" = true ]; then
    rm -f "$CRED_FILE"
else
    printf '%s' "$USERNAME:$PASSWORD" | base64 -w0 > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    COMMON_OPTS+=(-c "$USERNAME:$PASSWORD")
fi

# Foreground mode: ttyd replaces this shell, so there is no pid to record and
# no post-start check to run — print the banner first, then hand over. systemd
# supervises the process from there, and its journal keeps ttyd's own output.
if [ "$FOREGROUND" = true ]; then
    print_banner
    exec "$TTYD_BIN" "${COMMON_OPTS[@]}" "$SESSION_WRAPPER" "${SESSION_ARGS[@]}"
fi

"$TTYD_BIN" "${COMMON_OPTS[@]}" "$SESSION_WRAPPER" "${SESSION_ARGS[@]}" &
echo $! > $PIDFILE_TTYD
sleep 2

# Check ttyd started
if ! kill -0 $(cat $PIDFILE_TTYD) 2>/dev/null; then
    echo -e "${RED}Error: ttyd failed to start${NC}"
    exit 1
fi
echo -e "${GREEN}✓ ttyd started ($BIND:$PORT) — UI, WebSocket and image paste all in one process${NC}"

print_banner
