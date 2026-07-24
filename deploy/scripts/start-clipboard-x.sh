#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════
# Headless X server for the ttyd clipboard bridge
# ══════════════════════════════════════════════════════════════
#
# Claude Code reads pasted images straight off the X clipboard:
#
#   check: xclip -selection clipboard -t TARGETS -o | grep -E "image/(png|...)"
#   save:  xclip -selection clipboard -t image/png -o > <tmpfile>
#
# In a browser terminal there is no X session at all, so those calls have
# nothing to talk to and Ctrl+V silently finds no image. This script starts a
# 1x1 headless display whose *only* job is to hold a clipboard selection, so
# the web UI can push an image into it (see /clipboard-image in
# ../../html/webpack.config.js) and Ctrl+V then behaves exactly like a native
# terminal — Claude shows a real [Image #N] chip.
#
# Deliberately separate from the VNC (:1) and xpra (:100) displays: those are
# heavyweight, optional, and may be stopped independently. The clipboard must
# not depend on a desktop being up.
#
# Environment:
#   TTYD_CLIP_DISPLAY   display to run on (default :77)
# ══════════════════════════════════════════════════════════════

set -u

DISPLAY_NUM="${TTYD_CLIP_DISPLAY:-:77}"
PID_FILE="/tmp/ttyd-clipboard-x.pid"
LOG_FILE="/tmp/ttyd-clipboard-x.log"
SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM#:}"

if ! command -v Xvfb >/dev/null 2>&1; then
    echo "[clip-x] Xvfb not found — add pkgs.xorg.xorgserver to dev.nix" >&2
    exit 1
fi
if ! command -v xclip >/dev/null 2>&1; then
    echo "[clip-x] xclip not found — add pkgs.xclip to dev.nix" >&2
    exit 1
fi

# Already up? The socket alone can be stale, so probe a live process too.
if [ -e "$SOCKET" ] && [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    echo "[clip-x] already running on $DISPLAY_NUM (PID $(cat "$PID_FILE"))"
    exit 0
fi
rm -f "$SOCKET" "$PID_FILE" 2>/dev/null

# 1x1x24: nothing is ever drawn here, the display exists purely so an X
# clipboard owner has a server to register with. Costs ~3 MB RSS.
nohup Xvfb "$DISPLAY_NUM" -screen 0 1x1x24 -nolisten tcp >"$LOG_FILE" 2>&1 &
PID=$!
echo "$PID" > "$PID_FILE"

# Xvfb creates its socket asynchronously; xclip fails if it wins the race.
for _ in $(seq 1 40); do
    [ -e "$SOCKET" ] && break
    sleep 0.1
done

if ! kill -0 "$PID" 2>/dev/null || [ ! -e "$SOCKET" ]; then
    echo "[clip-x] failed to start on $DISPLAY_NUM — see $LOG_FILE" >&2
    rm -f "$PID_FILE"
    exit 1
fi

echo "[clip-x] started on $DISPLAY_NUM (PID $PID)"
