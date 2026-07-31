#!/bin/bash
# ══════════════════════════════════════════════════════════════
# resurrect agent hook — restore claude/codex panes into their
# own conversation instead of a blank one
# ══════════════════════════════════════════════════════════════
#
# tmux-resurrect saves the command line of each pane's foreground process and
# re-runs it verbatim on restore. For an agent CLI that means the pane comes
# back as a brand-new, empty conversation: the layout survives a reboot, the
# work in it does not.
#
# Both CLIs keep their transcript on disk and can re-enter it by id, so the
# missing piece is only the id. This hook runs right after resurrect writes its
# save file (@resurrect-hook-post-save-layout, which passes the file path) and
# rewrites the agent pane lines in place:
#
#   claude --dangerously-skip-permissions --session-id <id>
#     →  claude --dangerously-skip-permissions --resume <id>
#   codex --search
#     →  codex resume --search <id>
#
# It runs BEFORE resurrect compares the new save against the last one, so a
# changed session id counts as a change and gets a fresh save.
#
# Where the id comes from:
#   • `--session-id <uuid>` on the command line — ttyd-session.sh mints one for
#     every claude pane it creates, so sessions opened through the web UI are
#     pinned exactly, with no guessing.
#   • otherwise the newest transcript recorded for the pane's working directory
#     (~/.claude/projects/<slug>/<id>.jsonl, ~/.codex/sessions/**/rollout-*.jsonl).
#     Two hand-started agents in one directory can only be told apart this way,
#     so each id is handed out once: the second pane takes the next-newest
#     transcript, and a pane that finds none is left untouched.
#
# Usage (normally invoked by resurrect, not by hand):
#   resurrect-agent-hook.sh <resurrect-save-file> [--dry-run]
#
#   --dry-run   print the rewritten file to stdout, leave the original alone
# ══════════════════════════════════════════════════════════════

set -u

FILE=""
DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) FILE="$arg" ;;
    esac
done

[ -n "$FILE" ] && [ -f "$FILE" ] || exit 0

# How many rollout files to look at when resolving a codex session. Codex keeps
# every session it has ever recorded and only the newest handful can plausibly
# belong to a pane that is still open — scanning the whole tree on every
# 15-minute autosave would not be free.
CODEX_SCAN_LIMIT="${TTYD_CODEX_SCAN_LIMIT:-300}"

# Ids already claimed by an earlier pane in this pass, so two panes in the same
# directory never resume the same conversation.
declare -A USED=()
# Per-directory candidate lists, so a directory is only scanned once.
declare -A CACHE=()
# Out-parameters. The rewrite helpers mutate USED, so they publish their result
# through globals instead of stdout — a command substitution would run them in a
# subshell and throw the bookkeeping away. TOKS/AGENT_* carry the command line
# under consideration in the other direction, for the same reason.
PICKED=""
NEW_CMD=""
TOKS=()
FIELDS=()
AGENT_IDX=-1
AGENT_NAME=""

# Session ids recorded for `dir`, newest first, one per line.
claude_ids_for_dir() {
    local dir="$1" slug proj f
    # Claude Code names its per-project transcript directory after the working
    # directory with every non-alphanumeric character replaced by a dash
    # (/home/dev/tools_repo/ttyd-pro → -home-dev-tools-repo-ttyd-pro).
    slug="$(printf '%s' "$dir" | sed 's/[^A-Za-z0-9]/-/g')"
    proj="$HOME/.claude/projects/$slug"
    [ -d "$proj" ] || return 0
    while IFS= read -r f; do
        [ -f "$f" ] || continue
        f="${f##*/}"
        printf '%s\n' "${f%.jsonl}"
    done < <(ls -t "$proj"/*.jsonl 2>/dev/null)
}

codex_ids_for_dir() {
    local dir="$1" root="$HOME/.codex/sessions" f meta id
    [ -d "$root" ] || return 0
    while IFS= read -r f; do
        # The first line of a rollout is its session_meta, carrying both the
        # session id and the directory the session was started in.
        meta="$(head -n 1 "$f" 2>/dev/null)" || continue
        printf '%s' "$meta" | grep -qF "\"cwd\":\"$dir\"" || continue
        id="${meta#*\"session_id\":\"}"
        id="${id%%\"*}"
        [ -n "$id" ] && [ "$id" != "$meta" ] && printf '%s\n' "$id"
    done < <(find "$root" -name 'rollout-*.jsonl' -printf '%T@ %p\n' 2>/dev/null |
        sort -rn | head -n "$CODEX_SCAN_LIMIT" | cut -d' ' -f2-)
}

# Newest unclaimed session id for <agent> in <dir> → PICKED. Fails when the
# directory has no transcript left to hand out.
pick_id() {
    local agent="$1" dir="$2" key="$1|$2" id
    PICKED=""
    if [ -z "${CACHE[$key]+set}" ]; then
        CACHE[$key]="$("${agent}_ids_for_dir" "$dir")"
    fi
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        [ -n "${USED[$id]+set}" ] && continue
        USED[$id]=1
        PICKED="$id"
        return 0
    done <<<"${CACHE[$key]}"
    return 1
}

# ── claude ───────────────────────────────────────────────────
# Keeps every flag the pane was started with; only the session-selecting ones
# are rewritten. Fails when there is no id to resume, which leaves the saved
# command exactly as resurrect wrote it.
rewrite_claude() {
    local dir="$1"
    local -a out=("${TOKS[@]:0:AGENT_IDX+1}")
    local IFS=' '
    local -a toks=("${TOKS[@]}")
    local i=$((AGENT_IDX + 1)) n=${#TOKS[@]} sid=""

    while [ "$i" -lt "$n" ]; do
        case "${toks[$i]}" in
            # Already a resume command — restoring it again is idempotent, so
            # there is nothing to do (this is what a pane looks like after the
            # first reboot).
            --resume | -r | --resume=*) return 1 ;;
            --session-id)
                sid="${toks[$((i + 1))]:-}"
                i=$((i + 2))
                ;;
            --session-id=*)
                sid="${toks[$i]#*=}"
                i=$((i + 1))
                ;;
            # Superseded by the explicit --resume we are about to add.
            -c | --continue)
                i=$((i + 1))
                ;;
            *)
                out+=("${toks[$i]}")
                i=$((i + 1))
                ;;
        esac
    done

    if [ -n "$sid" ]; then
        USED[$sid]=1
    else
        pick_id claude "$dir" || return 1
        sid="$PICKED"
    fi
    [ -n "$sid" ] || return 1

    out+=(--resume "$sid")
    NEW_CMD="${out[*]}"
}

# ── codex ────────────────────────────────────────────────────
# codex has no launch-time equivalent of --session-id, so the id always comes
# from the rollout files. Flags are carried over only when `codex resume`
# accepts them (see `codex resume --help`); anything else — including a
# positional prompt — is dropped rather than guessed at.
CODEX_VALUE_FLAGS=" -c --config --enable --disable --remote --remote-auth-token-env -i --image -m --model --local-provider -p --profile -s --sandbox -C --cd --add-dir -a --ask-for-approval "
CODEX_BOOL_FLAGS=" --include-non-interactive --strict-config --oss --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --search --no-alt-screen "

rewrite_codex() {
    local dir="$1"
    local -a out=("${TOKS[@]:0:AGENT_IDX+1}" resume)
    local IFS=' '
    local -a toks=("${TOKS[@]}")
    local i=$((AGENT_IDX + 1)) n=${#TOKS[@]} tok flag

    # `codex resume ...`, `codex exec ...` — already a subcommand, leave it be.
    case "${toks[$i]:-}" in
        -* | "") ;;
        *) return 1 ;;
    esac

    pick_id codex "$dir" || return 1
    [ -n "$PICKED" ] || return 1

    while [ "$i" -lt "$n" ]; do
        tok="${toks[$i]}"
        flag="${tok%%=*}"
        if [[ "$CODEX_VALUE_FLAGS" == *" $flag "* ]]; then
            if [ "$tok" = "$flag" ]; then
                out+=("$tok" "${toks[$((i + 1))]:-}")
                i=$((i + 2))
            else
                out+=("$tok")
                i=$((i + 1))
            fi
        elif [[ "$CODEX_BOOL_FLAGS" == *" $flag "* ]]; then
            out+=("$tok")
            i=$((i + 1))
        else
            i=$((i + 1))
        fi
    done

    out+=("$PICKED")
    NEW_CMD="${out[*]}"
}

# Locate the agent inside the saved command → AGENT_IDX / AGENT_NAME.
#
# argv[0] is not always the CLI: ps reports codex as `node /usr/bin/codex …`
# because that is what actually runs. So the interpreter is allowed to come
# first, and nothing else is — a token further along is an argument (`vim
# claude.md`, `git commit -m codex`), not the program being run.
INTERPRETERS=" node bun deno npx python python3 "

find_agent() {
    local idx name
    AGENT_IDX=-1
    AGENT_NAME=""
    for idx in 0 1; do
        [ "$idx" -lt "${#TOKS[@]}" ] || break
        [ "$idx" -eq 1 ] && [[ "$INTERPRETERS" != *" ${TOKS[0]##*/} "* ]] && break
        name="${TOKS[$idx]##*/}"
        case "$name" in
            claude | codex)
                AGENT_IDX="$idx"
                AGENT_NAME="$name"
                return 0
                ;;
        esac
    done
    return 1
}

# Split a tab-separated line into the global array FIELDS, keeping empty fields.
# `read -a` cannot do this: tab is IFS whitespace, so it would collapse a run of
# tabs into one separator and shift every field after an empty one.
split_tabs() {
    local fld
    FIELDS=()
    while IFS= read -r fld; do
        FIELDS+=("$fld")
    done < <(printf '%s\n' "$1" | tr '\t' '\n')
}

# ── rewrite the save file ────────────────────────────────────
# A pane line is 11 tab-separated fields (scripts/save.sh in tmux-resurrect):
#   pane, session, window, window_active, :window_flags, pane_index,
#   pane_title, :dir, pane_active, pane_command, :full_command
# Every other line is copied through untouched.
TMP="$(mktemp "${TMPDIR:-/tmp}/ttyd-resurrect.XXXXXX")" || exit 0
trap 'rm -f "$TMP"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
    if [[ "$line" != pane$'\t'* ]]; then
        printf '%s\n' "$line"
        continue
    fi

    split_tabs "$line"
    if [ "${#FIELDS[@]}" -lt 11 ]; then
        printf '%s\n' "$line"
        continue
    fi

    dir="${FIELDS[7]#:}"
    dir="${dir//\\ / }" # save.sh escapes spaces in the path
    cmd="${FIELDS[10]#:}"

    read -r -a TOKS <<<"$cmd"
    NEW_CMD=""
    if find_agent; then
        case "$AGENT_NAME" in
            claude) rewrite_claude "$dir" || NEW_CMD="" ;;
            codex) rewrite_codex "$dir" || NEW_CMD="" ;;
        esac
    fi

    if [ -n "$NEW_CMD" ]; then
        FIELDS[10]=":$NEW_CMD"
        (
            IFS=$'\t'
            printf '%s\n' "${FIELDS[*]}"
        )
    else
        printf '%s\n' "$line"
    fi
done <"$FILE" >"$TMP"

if [ "$DRY_RUN" = 1 ]; then
    cat "$TMP"
else
    cat "$TMP" >"$FILE"
fi
