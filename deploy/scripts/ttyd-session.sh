#!/bin/bash
# ══════════════════════════════════════════════════════════════
# ttyd session wrapper — auto-attach to tmux or screen
# ══════════════════════════════════════════════════════════════
#
# Invoked by ttyd with URL args passed as positional args.
# Accessed via: http://host:port/?arg=<part1>&arg=<part2>
#
# Args are parsed as:
#   [modifier]... [session-type] [name]
#
# Modifiers (any order, before the session spec):
#   cwd:<path>            chdir to <path> before launching the session
#   name:<session>        explicit session name (takes precedence over the
#                         positional name; order-independent like cwd:).
#                         Use this to avoid the positional name being confused
#                         with the `tmux`/`screen` session-type keyword, and to
#                         guarantee every terminal gets a unique session instead
#                         of falling back to the shared default "main".
#   codex                 run `codex` (no args) on first-create
#   codex:<args>          run `codex <args>` on first-create. <args> is
#                         parsed with shell-style quoting (single/double
#                         quotes preserve spaces), then %q-escaped for
#                         safe embedding. The server does NOT inject any
#                         default flags; the caller is responsible for
#                         passing any required sandbox/approval flags.
#   claude                run `claude` (no args) on first-create
#   claude:<args>         run `claude <args>` on first-create
#
# Session spec (optional — default = tmux main):
#   (none)                tmux new -A -s main
#   <name>                tmux new -A -s <name>
#   tmux <name>           tmux new -A -s <name>
#   screen <name>         screen -xRR <name>   (agent modifier ignored)
#
# Examples:
#   ?arg=dev                              tmux "dev"
#   ?arg=codex&arg=crm                    tmux "crm", codex on first-create
#   ?arg=codex:--help&arg=crm             tmux "crm", codex --help
#   ?arg=cwd:/home/user/MetrixCRM&arg=codex&arg=crm
#                                         cd + tmux "crm" + codex on first-create
#   ?arg=screen&arg=build                 screen "build"
#
# Notes:
#   • First-create vs attach: if the tmux session already exists, we attach
#     only — the agent CLI will NOT be re-run.
#   • <path> must be an existing directory; otherwise a warning is logged
#     and the wrapper keeps ttyd's launch cwd.
#   • A new claude session is given an explicit --session-id so the
#     persistence layer can resume that exact conversation after a reboot
#     (see resurrect-agent-hook.sh).
#   • Session names are sanitized: only [A-Za-z0-9._-], max 64 chars.
#   • Agent args are split on whitespace then %q-quoted to prevent
#     injection into the tmux shell command.
# ══════════════════════════════════════════════════════════════

set -u

# Keep user-installed agent CLIs discoverable even when ttyd was started by a
# service with a minimal PATH.
if [ -n "${HOME:-}" ]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

SHELL_CMD="${SHELL:-/bin/bash}"

# Clipboard bridge: Claude Code reads a pasted image off the X clipboard
# (`xclip -selection clipboard -t image/png -o`), so a session only sees
# browser-pasted images if DISPLAY points at the headless display holding
# them — see start-clipboard-x.sh. start-ttyd.sh normally exports this and we
# inherit it; setting it here too keeps sessions working when ttyd was started
# some other way. Only filled in when unset, so a VNC/xpra session that chose
# its own DISPLAY keeps it.
: "${TTYD_CLIP_DISPLAY:=:77}"
if [ -z "${DISPLAY:-}" ] && [ -e "/tmp/.X11-unix/X${TTYD_CLIP_DISPLAY#:}" ]; then
    export DISPLAY="$TTYD_CLIP_DISPLAY"
fi

sanitize() {
    printf '%s' "$1" | tr -cd 'A-Za-z0-9._-' | cut -c1-64
}

fallback_shell() {
    exec "$SHELL_CMD"
}

# A lowercase RFC-4122 UUID, or nothing when the host offers no generator.
# Only ever fed to a flag we control, and validated anyway so a surprising
# generator can't inject a second token into the tmux command string.
new_uuid() {
    local id=""
    if [ -r /proc/sys/kernel/random/uuid ]; then
        read -r id < /proc/sys/kernel/random/uuid
    elif command -v uuidgen >/dev/null 2>&1; then
        id="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
    fi
    case "$id" in
        [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
            printf '%s' "$id"
            ;;
    esac
}

# ── Parse modifiers ──────────────────────────────────────────
AGENT_ENABLED=0
AGENT_CMD=""
AGENT_ARGS=""
NAME=""
NAME_EXPLICIT=0

while [ $# -gt 0 ]; do
    case "$1" in
        name:*)
            NAME="${1#name:}"
            NAME_EXPLICIT=1
            shift
            ;;
        cwd:*)
            REQ_DIR="${1#cwd:}"
            shift
            if [ -z "$REQ_DIR" ]; then
                echo "warn: empty cwd arg, staying in $(pwd)" >&2
            else
                if [ ! -d "$REQ_DIR" ]; then
                    if mkdir -p "$REQ_DIR" 2>/dev/null; then
                        echo "info: created cwd '$REQ_DIR'" >&2
                    else
                        echo "warn: could not create '$REQ_DIR', staying in $(pwd)" >&2
                    fi
                fi
                if [ -d "$REQ_DIR" ]; then
                    cd "$REQ_DIR" || echo "warn: cd '$REQ_DIR' failed, staying in $(pwd)" >&2
                fi
            fi
            ;;
        codex)
            AGENT_ENABLED=1
            AGENT_CMD="codex"
            AGENT_ARGS=""
            shift
            ;;
        codex:*)
            AGENT_ENABLED=1
            AGENT_CMD="codex"
            AGENT_ARGS="${1#codex:}"
            shift
            ;;
        claude)
            AGENT_ENABLED=1
            AGENT_CMD="claude"
            AGENT_ARGS=""
            shift
            ;;
        claude:*)
            AGENT_ENABLED=1
            AGENT_CMD="claude"
            AGENT_ARGS="${1#claude:}"
            shift
            ;;
        *)
            break
            ;;
    esac
done

# ── Determine session type + name ────────────────────────────
# An explicit `name:` modifier always wins; the positional name is only used
# as a fallback when no `name:` was given (backward compat).
MODE="tmux"
case "${1:-}" in
    "")
        ;;
    screen)
        MODE="screen"
        [ "$NAME_EXPLICIT" = 0 ] && NAME="${2:-}"
        ;;
    tmux)
        MODE="tmux"
        [ "$NAME_EXPLICIT" = 0 ] && NAME="${2:-}"
        ;;
    *)
        [ "$NAME_EXPLICIT" = 0 ] && NAME="$1"
        ;;
esac

NAME="$(sanitize "$NAME")"
[ -z "$NAME" ] && NAME="main"

# Title shown in browser tab (document.title) + tmux set-titles-string.
TITLE="$NAME"
TMUX_TITLES_STRING='#S'
if [ "$AGENT_ENABLED" = 1 ]; then
    AGENT_LABEL="$(printf '%s' "$AGENT_CMD" | tr '[:lower:]' '[:upper:]')"
    TITLE="$NAME - $AGENT_LABEL"
    TMUX_TITLES_STRING="#S - $AGENT_LABEL"
fi

# Emit OSC-0 so xterm.js (ttyd frontend) picks up browser-tab title.
set_browser_title() {
    printf '\033]0;%s\007' "$1"
}

# ── Dispatch ─────────────────────────────────────────────────
if [ "$MODE" = "screen" ]; then
    if ! command -v screen >/dev/null 2>&1; then
        echo "screen not installed, falling back to shell" >&2
        fallback_shell
    fi
    if [ "$AGENT_ENABLED" = 1 ]; then
        echo "warn: agent modifier is ignored for screen sessions" >&2
        TITLE="$NAME"
    fi
    set_browser_title "$TITLE"
    exec screen -xRR "$NAME"
fi

# tmux path
if ! command -v tmux >/dev/null 2>&1; then
    echo "tmux not installed, falling back to shell" >&2
    fallback_shell
fi

# Exact-match target. tmux resolves a bare `-t name` as exact → prefix →
# fnmatch, so `-t foo` would attach to an existing `foo-bar` session. The
# leading `=` forces an exact-name match, otherwise two sessions where one
# name is a prefix of the other (e.g. "crm" vs "crm-terminal") collide.
TGT="=$NAME"

# Existing session → always just attach (don't re-run the agent CLI).
if tmux has-session -t "$TGT" 2>/dev/null; then
    tmux set-option -t "$TGT" -g set-titles on 2>/dev/null
    tmux set-option -t "$TGT" -g set-titles-string "$TMUX_TITLES_STRING" 2>/dev/null
    set_browser_title "$TITLE"
    exec tmux attach-session -t "$TGT"
fi

# Brand-new session.
if [ "$AGENT_ENABLED" = 1 ]; then
    if ! command -v "$AGENT_CMD" >/dev/null 2>&1; then
        echo "$AGENT_CMD CLI not found, creating plain tmux session" >&2
        tmux new-session -d -s "$NAME"
    else
        # Append user args (split on whitespace, then %q-quoted) so the
        # session runs the selected CLI safely in a shell-expansion context.
        quoted=""
        if [ -n "$AGENT_ARGS" ]; then
            # Parse args respecting shell-style quoting (`-p "hello world"`
            # stays as two tokens `-p` and `hello world`) using xargs -n1,
            # then %q-quote each token for safe embedding.
            while IFS= read -r tok; do
                [ -z "$tok" ] && continue
                quoted+="$(printf ' %q' "$tok")"
            done < <(printf '%s\n' "$AGENT_ARGS" | xargs -n1 2>/dev/null)
        fi
        # Pin the conversation id of a brand-new claude pane. Claude Code lets
        # the id be chosen up front, and knowing it is what makes the pane
        # restorable: resurrect-agent-hook.sh rewrites the saved
        # `--session-id <id>` into `--resume <id>`, so a reboot brings the pane
        # back into *this* conversation instead of an empty one. Skipped when
        # the caller already picked a session (`claude:--resume …`, `claude:-c`)
        # or when no source of UUIDs is available.
        if [ "$AGENT_CMD" = "claude" ]; then
            case " $AGENT_ARGS " in
                *" --session-id"* | *" --resume"* | *" -r "* | *" -c "* | *" --continue"*) ;;
                *)
                    SESSION_UUID="$(new_uuid)"
                    [ -n "$SESSION_UUID" ] && quoted+=" --session-id $SESSION_UUID"
                    ;;
            esac
        fi
        tmux new-session -d -s "$NAME" \
            "$AGENT_CMD${quoted}; exec $SHELL_CMD"
    fi
else
    tmux new-session -d -s "$NAME"
fi

tmux set-option -t "$TGT" -g set-titles on 2>/dev/null
tmux set-option -t "$TGT" -g set-titles-string "$TMUX_TITLES_STRING" 2>/dev/null
set_browser_title "$TITLE"
exec tmux attach-session -t "$TGT"
