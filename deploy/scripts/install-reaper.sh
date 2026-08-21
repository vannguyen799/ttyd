#!/bin/bash
# ══════════════════════════════════════════════════════════════
# Install the idle-session reaper as a systemd USER timer
# ══════════════════════════════════════════════════════════════
#
# Usage (as the user who owns the tmux sessions — no sudo):
#   bash deploy/scripts/install-reaper.sh [OPTIONS]
#
# Options:
#   -i, --idle SPEC     Idle threshold: 3d, 12h, 90m, seconds (default: 3d)
#   -e, --env-file PATH Environment file (default: ~/.config/ttyd-reap.env)
#   -N, --no-start      Install and enable, but don't start the timer now
#   -u, --uninstall     Stop, disable and remove the units
#   -h, --help          Show this help
#
# Why a user timer and not cron: this host ships no `crontab` binary at all,
# and the reaper has to run as the owner of the tmux server to see its
# sessions. A user unit satisfies both and needs no root. It does need
# lingering, or the timer only runs while the user has a login session open —
# the installer checks and tells you the one command that fixes it.
#
# Re-running it is safe: the units are regenerated, the environment file is
# left alone once it exists.
# ══════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/ttyd-reap.env"
ENV_EXAMPLE="$FORK_ROOT/deploy/systemd/ttyd-reap.env.example"
IDLE="3d"
DO_START=true
UNINSTALL=false
UNITS=(ttyd-reap-idle.service ttyd-reap-idle.timer)

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}==>${NC} $*"; }
ok() { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
die() { echo -e "${RED}Error:${NC} $*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case $1 in
        -i|--idle) IDLE="$2"; shift 2 ;;
        -e|--env-file) ENV_FILE="$2"; shift 2 ;;
        -N|--no-start) DO_START=false; shift ;;
        -u|--uninstall) UNINSTALL=true; shift ;;
        -h|--help) sed -n '2,23p' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) die "unknown option: $1 (try --help)" ;;
    esac
done

[[ $EUID -eq 0 ]] && die "run me as the session owner, not root — these are user units"
command -v systemctl >/dev/null 2>&1 || die "systemd not available on this host"

if $UNINSTALL; then
    log "removing the reaper timer"
    systemctl --user disable --now ttyd-reap-idle.timer 2>/dev/null || true
    for unit in "${UNITS[@]}"; do rm -f "$UNIT_DIR/$unit"; done
    systemctl --user daemon-reload
    ok "removed (the env file and any snapshots were left alone)"
    exit 0
fi

for unit in "${UNITS[@]}"; do
    [[ -f "$FORK_ROOT/deploy/systemd/$unit" ]] || die "missing unit template: $unit"
done
[[ -x "$FORK_ROOT/deploy/scripts/ttyd-reap-idle.sh" ]] || die "ttyd-reap-idle.sh is missing or not executable"

mkdir -p "$UNIT_DIR"

log "rendering units into $UNIT_DIR"
for unit in "${UNITS[@]}"; do
    sed -e "s|@FORK_ROOT@|$FORK_ROOT|g" \
        -e "s|@ENV_FILE@|$ENV_FILE|g" \
        -e "s|@IDLE@|$IDLE|g" \
        "$FORK_ROOT/deploy/systemd/$unit" >"$UNIT_DIR/$unit"
done
ok "units written"

if [[ -f $ENV_FILE ]]; then
    log "environment file already exists, leaving it alone: $ENV_FILE"
else
    mkdir -p "$(dirname "$ENV_FILE")"
    sed "s|^TTYD_REAP_IDLE=.*|TTYD_REAP_IDLE=$IDLE|" "$ENV_EXAMPLE" >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "seeded $ENV_FILE (threshold $IDLE)"
fi

systemctl --user daemon-reload

# Without lingering the user manager is torn down at logout, taking the timer
# with it — the reaper would then only ever run while someone is logged in,
# which is exactly the opposite of what an unattended sweep is for.
if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    warn "lingering is off for $USER — the timer will not run unless you are logged in."
    warn "fix it with:  sudo loginctl enable-linger $USER"
fi

if $DO_START; then
    systemctl --user enable --now ttyd-reap-idle.timer
    ok "timer enabled and started"
else
    systemctl --user enable ttyd-reap-idle.timer
    ok "timer enabled (not started — use: systemctl --user start ttyd-reap-idle.timer)"
fi

echo
log "check it with:"
echo "  systemctl --user list-timers ttyd-reap-idle.timer"
echo "  $FORK_ROOT/deploy/scripts/ttyd-reap-idle.sh --dry-run    # what would go now"
echo "  journalctl --user -u ttyd-reap-idle.service -n 50"
echo "  $FORK_ROOT/deploy/scripts/ttyd-snapshot.sh list          # parked sessions"
