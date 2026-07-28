#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Install the ttyd web terminal as a systemd service
# ══════════════════════════════════════════════════════════════
#
# Usage (as root):
#   sudo bash deploy/scripts/install-systemd.sh [OPTIONS]
#
# Options:
#   -u, --user NAME     Run the service as this user (default: owner of the
#                       checkout, so the terminal lands in the right $HOME)
#   -e, --env-file PATH Environment file to read (default: /etc/default/ttyd)
#   -N, --no-start      Install and enable, but don't start now
#   -h, --help          Show this help
#
# What it does:
#   1. renders deploy/systemd/ttyd.service for this host
#   2. seeds the environment file (with a generated password) if absent
#   3. retires the legacy two-process units (ttyd-backend + ttyd-ui) without
#      taking running tmux sessions down with them
#   4. enables and starts ttyd.service
#
# Re-running it is safe: the unit is regenerated, the environment file is
# left alone once it exists.
# ══════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATE="$FORK_ROOT/deploy/systemd/ttyd.service"
ENV_EXAMPLE="$FORK_ROOT/deploy/systemd/ttyd.env.example"
UNIT_PATH="/etc/systemd/system/ttyd.service"
ENV_FILE="/etc/default/ttyd"
# The two units this replaces. Both ran under the default KillMode, so they
# own the cgroup every tmux session was started in — see retire_legacy().
LEGACY_UNITS=(ttyd-backend.service ttyd-ui.service)
DO_START=true
SERVICE_USER=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}==>${NC} $*"; }
ok() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die() { echo -e "${RED}Error:${NC} $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case $1 in
        -u|--user) SERVICE_USER="$2"; shift 2 ;;
        -e|--env-file) ENV_FILE="$2"; shift 2 ;;
        -N|--no-start) DO_START=false; shift ;;
        -h|--help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "unknown option: $1 (try --help)" ;;
    esac
done

[[ $EUID -eq 0 ]] || die "run me as root: sudo bash $0"
command -v systemctl >/dev/null 2>&1 || die "systemd not available on this host"
[[ -f $TEMPLATE ]] || die "missing unit template: $TEMPLATE"

# Run as whoever owns the checkout unless told otherwise: the terminal's shell,
# tmux sessions and agent CLIs all live in that user's $HOME.
[[ -n $SERVICE_USER ]] || SERVICE_USER="$(stat -c %U "$FORK_ROOT")"
id "$SERVICE_USER" >/dev/null 2>&1 || die "no such user: $SERVICE_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
[[ -n $SERVICE_HOME ]] || die "cannot resolve home directory for $SERVICE_USER"

# ── 1. environment file ────────────────────────────────────────
# Generated once and then owned by the operator. A service must not mint a new
# password on every restart, so start-ttyd.sh --foreground refuses to run
# without one; seed a real one here rather than let that fail at first start.
if [[ -f $ENV_FILE ]]; then
    ok "keeping existing $ENV_FILE"
else
    [[ -f $ENV_EXAMPLE ]] || die "missing $ENV_EXAMPLE"
    GENERATED="$(tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 20)"
    install -m 0600 -o root -g root "$ENV_EXAMPLE" "$ENV_FILE"
    sed -i "s|^TTYD_PASSWORD=.*|TTYD_PASSWORD=$GENERATED|" "$ENV_FILE"
    ok "wrote $ENV_FILE (password: ${CYAN}$GENERATED${NC})"
fi

# ── 2. retire the legacy two-process units ─────────────────────
# ttyd-backend ran ttyd on :7681 and ttyd-ui ran a webpack dev server on the
# public port in front of it. Both are obsolete now that the binary serves the
# UI itself. Stopping them naively is destructive: they were installed with the
# default KillMode=control-group, and the tmux server the terminal spawned sits
# in their cgroup — so `systemctl stop` would kill every live session. Drop in
# KillMode=process first, reload, and only then stop.
# Does this pid hang off a tmux/screen server — i.e. is it part of somebody's
# terminal session rather than the server we are retiring? Walks the parent
# chain via /proc/<pid>/status, whose PPid field survives comms with spaces.
under_session() {
    local p=$1 c
    while [[ -n $p && $p -gt 1 ]]; do
        c="$(cat "/proc/$p/comm" 2>/dev/null)" || return 1
        case "$c" in tmux*|screen*|SCREEN*) return 0 ;; esac
        p="$(awk '/^PPid:/{print $2}' "/proc/$p/status" 2>/dev/null)" || return 1
    done
    return 1
}

retire_legacy() {
    local unit=$1 dropin exec_start procs pid comm
    systemctl list-unit-files "$unit" >/dev/null 2>&1 || return 0
    [[ -f /etc/systemd/system/$unit ]] || return 0

    log "retiring $unit"
    # Both must be read while the unit is still up.
    exec_start="$(systemctl show -p ExecStart --value "$unit" 2>/dev/null |
        grep -oE 'path=[^ ;]+' | head -1 | cut -d= -f2 || true)"
    procs="/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$unit" 2>/dev/null)/cgroup.procs"

    dropin="/etc/systemd/system/$unit.d"
    mkdir -p "$dropin"
    printf '[Service]\nKillMode=process\n' > "$dropin/10-spare-sessions.conf"
    systemctl daemon-reload
    systemctl disable --now "$unit" >/dev/null 2>&1 || true

    # Sparing the cgroup is the point, but it also spares the retired server's
    # own children — and the webpack UI's real process is a child of yarn, so
    # it would keep the public port and the new unit could never bind. Retire
    # those by name; anything else in there (tmux, Xvfb, xclip) stays up.
    if [[ -f $procs ]]; then
        while read -r pid; do
            comm="$(cat "/proc/$pid/comm" 2>/dev/null)" || continue
            case "$comm" in
                ttyd|node|webpack|yarn|npm) ;;
                *) continue ;;
            esac
            # …unless it is someone's own process inside a terminal session: a
            # dev server running in tmux is a `node` too, and killing it would
            # be collateral damage from a deploy step.
            if under_session "$pid"; then continue; fi
            kill "$pid" 2>/dev/null && ok "stopped leftover $comm ($pid)"
        done < "$procs"
    fi
    rm -rf "$dropin" "/etc/systemd/system/$unit"

    # Its launcher, if it was a private script under the user's ~/.local/bin
    # rather than something from this checkout.
    if [[ -n $exec_start && $exec_start == "$SERVICE_HOME/.local/bin/"* && $exec_start != "$FORK_ROOT/"* ]]; then
        rm -f "$exec_start"
        ok "removed launcher $exec_start"
    fi
    ok "$unit removed"
}
for unit in "${LEGACY_UNITS[@]}"; do retire_legacy "$unit"; done

# ── 3. render and install the unit ─────────────────────────────
log "installing $UNIT_PATH"
sed -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@GROUP@|$SERVICE_GROUP|g" \
    -e "s|@HOME@|$SERVICE_HOME|g" \
    -e "s|@FORK_ROOT@|$FORK_ROOT|g" \
    -e "s|@ENV_FILE@|$ENV_FILE|g" \
    "$TEMPLATE" > "$UNIT_PATH"
chmod 0644 "$UNIT_PATH"
chmod 0755 "$FORK_ROOT/deploy/scripts/start-ttyd.sh"
systemctl daemon-reload
ok "unit installed (User=$SERVICE_USER, WorkingDirectory=$FORK_ROOT)"

# ── 4. enable / start ──────────────────────────────────────────
if [[ $DO_START != true ]]; then
    systemctl enable ttyd.service >/dev/null 2>&1
    ok "enabled. Start it with: systemctl start ttyd"
    exit 0
fi

log "starting ttyd.service"
systemctl enable ttyd.service >/dev/null 2>&1
systemctl restart ttyd.service
sleep 2

if ! systemctl is-active --quiet ttyd.service; then
    systemctl --no-pager --lines=20 status ttyd.service || true
    die "ttyd.service failed to start (see journalctl -u ttyd)"
fi

PORT="$(grep -oP '^TTYD_PORT=\K.*' "$ENV_FILE" 2>/dev/null || echo 10090)"
ok "ttyd.service running on port $PORT"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
case "$CODE" in
    401) ok "GET / → 401 (auth required, as configured)" ;;
    200) warn "GET / → 200 — the terminal is open to anyone who can reach the port" ;;
    *) warn "GET / → ${CODE:-no response}" ;;
esac
echo ""
echo -e "  Logs:    ${CYAN}journalctl -u ttyd -f${NC}"
echo -e "  Config:  ${CYAN}$ENV_FILE${NC} (restart after editing)"
echo -e "  Restart: ${CYAN}systemctl restart ttyd${NC} — tmux sessions survive it"
