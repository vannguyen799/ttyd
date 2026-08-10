#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════════
# setup-ubuntu-vps.sh — one-shot ttyd + vkbd (virtual keyboard) installer
# ══════════════════════════════════════════════════════════════════════
# Builds the custom ttyd fork (vannguyen799/ttyd-pro) which has the on-screen
# virtual keyboard (vkbd) baked into the binary, installs it system-wide,
# and starts a web terminal with tmux session routing + persistence.
#
# Works on any fresh Ubuntu VPS (20.04 / 22.04 / 24.04, amd64 or arm64).
# Safe to re-run — every step is idempotent.
#
# Quick use (from anywhere):
#   curl -fsSL https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/deploy/scripts/setup-ubuntu-vps.sh | bash
#
# Or from a checkout:
#   bash ttyd/deploy/scripts/setup-ubuntu-vps.sh [OPTIONS]
#
# Options:
#   -P, --port PORT        Web terminal port            (default: 10090)
#   -u, --username USER    Basic-auth username          (default: user)
#   -p, --password PASS    Basic-auth password          (default: random)
#   -n, --no-auth          Disable authentication
#   -t, --tunnel           Also open a Cloudflare quick tunnel (public URL)
#       --no-start         Build + install only, don't start the server
#       --repo URL         ttyd fork git URL (default: vannguyen799/ttyd-pro)
#       --dir PATH         Where to clone the fork (default: ~/ttyd)
#   -h, --help             Show this help
# ══════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_URL_DEFAULT="https://github.com/vannguyen799/ttyd-pro.git"
TTYD_DIR_DEFAULT="$HOME/ttyd"

# The one public port: this ttyd serves the vkbd UI, the WebSocket and the
# image-paste endpoint itself, so there is nothing else to expose.
PORT=10090
USERNAME="user"
PASSWORD=""
NO_AUTH=false
TUNNEL=false
DO_START=true
REPO_URL="$REPO_URL_DEFAULT"
TTYD_DIR=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${CYAN}[setup]${NC} $*"; }
ok()   { echo -e "${GREEN}[setup]${NC} $*"; }
warn() { echo -e "${YELLOW}[setup]${NC} $*"; }
die()  { echo -e "${RED}[setup] error:${NC} $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -P|--port)     PORT="$2"; shift 2;;
    -u|--username) USERNAME="$2"; shift 2;;
    -p|--password) PASSWORD="$2"; shift 2;;
    -n|--no-auth)  NO_AUTH=true; shift;;
    -t|--tunnel)   TUNNEL=true; shift;;
    --no-start)    DO_START=false; shift;;
    --repo)        REPO_URL="$2"; shift 2;;
    --dir)         TTYD_DIR="$2"; shift 2;;
    -h|--help)     sed -n '2,40p' "$0"; exit 0;;
    *) die "unknown option: $1 (use --help)";;
  esac
done

# sudo helper (run as root → no sudo; else require sudo).
SUDO=""
if [[ "$(id -u)" -ne 0 ]]; then
  command -v sudo >/dev/null 2>&1 || die "need root or sudo to install packages"
  SUDO="sudo"
fi

# ── 1. system dependencies ────────────────────────────────────────────
log "installing build + runtime dependencies via apt..."
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq \
  build-essential cmake git pkg-config \
  libjson-c-dev libwebsockets-dev zlib1g-dev libssl-dev libuv1-dev \
  tmux screen ca-certificates curl >/dev/null
ok "dependencies installed"

# ── 2. fetch the ttyd fork (carries the vkbd source in src/html.h) ─────
# These deploy scripts live at <fork>/deploy/scripts. If this script is run
# from a checkout, reuse the fork root two levels up. Otherwise clone.
SCRIPT_SRC="${BASH_SOURCE[0]:-}"
if [[ -n "$SCRIPT_SRC" && -f "$SCRIPT_SRC" ]]; then
  MAYBE_FORK="$(cd "$(dirname "$SCRIPT_SRC")/../.." && pwd)"
  [[ -f "$MAYBE_FORK/CMakeLists.txt" && -f "$MAYBE_FORK/src/html.h" ]] && \
    TTYD_DIR="${TTYD_DIR:-$MAYBE_FORK}"
fi
TTYD_DIR="${TTYD_DIR:-$TTYD_DIR_DEFAULT}"

if [[ -d "$TTYD_DIR/.git" ]]; then
  log "using existing ttyd checkout at $TTYD_DIR"
else
  log "cloning ttyd fork → $TTYD_DIR"
  git clone --depth 1 "$REPO_URL" "$TTYD_DIR"
fi

SUB="$TTYD_DIR"
[[ -f "$SUB/CMakeLists.txt" && -f "$SUB/src/html.h" ]] || \
  die "ttyd checkout incomplete (missing CMakeLists.txt / src/html.h)"

# ── 3. build the ttyd binary (vkbd is pre-baked into src/html.h) ───────
log "building custom ttyd (this takes ~1-2 min)..."
BUILD_DIR="$SUB/build"
cmake -S "$SUB" -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "$BUILD_DIR" -j "$(nproc)" >/dev/null
BIN="$BUILD_DIR/ttyd"
[[ -x "$BIN" ]] || die "build produced no ttyd binary"

log "installing → /usr/local/bin/ttyd"
$SUDO install -m 0755 "$BIN" /usr/local/bin/ttyd
ok "ttyd $(/usr/local/bin/ttyd --version 2>&1 | head -1) installed (with vkbd)"

if [[ "$DO_START" != true ]]; then
  ok "build complete. Start later with: bash $TTYD_DIR/deploy/scripts/start-ttyd.sh"
  exit 0
fi

# ── 4. start the web terminal ─────────────────────────────────────────
START_ARGS=(-P "$PORT" -u "$USERNAME")
if [[ "$NO_AUTH" == true ]]; then
  START_ARGS+=(-n)
elif [[ -n "$PASSWORD" ]]; then
  START_ARGS+=(-p "$PASSWORD")
fi
log "starting web terminal on port $PORT..."
bash "$TTYD_DIR/deploy/scripts/start-ttyd.sh" "${START_ARGS[@]}"

# ── 5. optional public tunnel ─────────────────────────────────────────
if [[ "$TUNNEL" == true ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    warn "cloudflared not installed — installing..."
    CF_ARCH="$(dpkg --print-architecture)"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" \
      -o /tmp/cloudflared && $SUDO install -m0755 /tmp/cloudflared /usr/local/bin/cloudflared
  fi
  log "opening Cloudflare quick tunnel → public URL below (Ctrl-C stops the tunnel only)"
  nohup cloudflared tunnel --url "http://localhost:$PORT" >/tmp/ttyd-tunnel.log 2>&1 &
  sleep 6
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/ttyd-tunnel.log | head -1 \
    | sed "s/^/$(echo -e "${GREEN}  PUBLIC URL:${NC} ")/" \
    || warn "tunnel URL not ready yet — check /tmp/ttyd-tunnel.log"
fi

echo ""
ok "Done. Virtual keyboard (vkbd) appears automatically on touch devices,"
ok "or toggle it from the terminal toolbar in the browser."
