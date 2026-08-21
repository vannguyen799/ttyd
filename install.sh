#!/bin/sh
# User-scoped installer/updater for ttyd-pro.
#
# Quick install (Linux or macOS):
#   curl -fsSL https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/install.sh | sh
#
# Re-run the same command to update. Add --auto-update to install a daily,
# user-scoped update job (systemd user timer, launchd, or cron fallback).
set -eu

REPO="${TTYD_PRO_REPO:-vannguyen799/ttyd-pro}"
INSTALL_DIR="${TTYD_PRO_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"
VERSION="latest"
AUTO_UPDATE=""
MODIFY_PATH=true
QUIET=false

log() {
    [ "$QUIET" = true ] || printf '%s\n' "$*"
}

die() {
    printf 'ttyd-pro installer: %s\n' "$*" >&2
    exit 1
}

usage() {
    cat <<'EOF'
Install or update ttyd-pro in the current user's account.

Usage: install.sh [options]

  --version VERSION       Install a specific release tag (default: latest)
  --bin-dir DIR           Install directory (default: ~/.local/bin)
  --auto-update           Enable a daily user-scoped update job
  --disable-auto-update   Remove the user-scoped update job
  --no-modify-path        Do not add the install directory to shell PATH
  --quiet                 Only print errors
  -h, --help              Show this help

No sudo is used. Re-run the installer at any time to update.
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --version)
            [ "$#" -ge 2 ] || die "--version needs a value"
            VERSION=$2
            shift 2
            ;;
        --bin-dir)
            [ "$#" -ge 2 ] || die "--bin-dir needs a value"
            INSTALL_DIR=$2
            shift 2
            ;;
        --auto-update)
            AUTO_UPDATE=enable
            shift
            ;;
        --disable-auto-update)
            AUTO_UPDATE=disable
            shift
            ;;
        --no-modify-path)
            MODIFY_PATH=false
            shift
            ;;
        --quiet)
            QUIET=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *) die "unknown option: $1 (try --help)" ;;
    esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS" in
    Linux) PLATFORM=linux ;;
    Darwin) PLATFORM=macos ;;
    *) die "unsupported operating system: $OS" ;;
esac

case "$ARCH" in
    x86_64|amd64) RELEASE_ARCH=x86_64 ;;
    arm64|aarch64) RELEASE_ARCH=aarch64 ;;
    i386|i486|i586|i686) RELEASE_ARCH=i686 ;;
    armv7|armv7l) RELEASE_ARCH=armhf ;;
    armv6|armv6l) RELEASE_ARCH=arm ;;
    mips|mipsel|mips64|mips64el|ppc64|ppc64le|s390x) RELEASE_ARCH=$ARCH ;;
    *) die "unsupported CPU architecture: $ARCH" ;;
esac

if [ "$PLATFORM" = macos ]; then
    case "$RELEASE_ARCH" in
        x86_64|aarch64) ;;
        *) die "macOS releases are only available for x86_64 and Apple Silicon" ;;
    esac
    command -v brew >/dev/null 2>&1 || die "Homebrew is required for the macOS runtime libraries: https://brew.sh"
    log "Ensuring macOS runtime libraries are installed..."
    brew list --versions libwebsockets json-c libuv openssl@3 >/dev/null 2>&1 ||
        brew install libwebsockets json-c libuv openssl@3
fi

ASSET="ttyd-pro-${PLATFORM}-${RELEASE_ARCH}"
if [ "$VERSION" = latest ]; then
    RELEASE_BASE="https://github.com/$REPO/releases/latest/download"
else
    case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
    RELEASE_BASE="https://github.com/$REPO/releases/download/$VERSION"
fi

TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t ttyd-pro)
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

log "Downloading $ASSET from GitHub Releases..."
curl --proto '=https' --tlsv1.2 -fL "$RELEASE_BASE/$ASSET" -o "$TMP_DIR/$ASSET" ||
    die "release asset not found; check that the requested release is published"
curl --proto '=https' --tlsv1.2 -fL "$RELEASE_BASE/SHA256SUMS" -o "$TMP_DIR/SHA256SUMS" ||
    die "release checksum file not found"

EXPECTED=$(awk -v name="$ASSET" '$2 == name || $2 == "*" name { print $1; exit }' "$TMP_DIR/SHA256SUMS")
[ -n "$EXPECTED" ] || die "no checksum published for $ASSET"
if command -v sha256sum >/dev/null 2>&1; then
    ACTUAL=$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')
else
    ACTUAL=$(shasum -a 256 "$TMP_DIR/$ASSET" | awk '{print $1}')
fi
[ "$ACTUAL" = "$EXPECTED" ] || die "SHA-256 verification failed"

mkdir -p "$INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable; choose a user-owned path with --bin-dir"
INSTALLED_SHA=""
if [ -f "$INSTALL_DIR/ttyd-pro" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
        INSTALLED_SHA=$(sha256sum "$INSTALL_DIR/ttyd-pro" | awk '{print $1}')
    else
        INSTALLED_SHA=$(shasum -a 256 "$INSTALL_DIR/ttyd-pro" | awk '{print $1}')
    fi
fi
if [ "$INSTALLED_SHA" = "$EXPECTED" ]; then
    log "ttyd-pro is already up to date in $INSTALL_DIR."
else
    chmod 0755 "$TMP_DIR/$ASSET"
    INSTALL_TMP="$INSTALL_DIR/.ttyd-pro.new.$$"
    cp "$TMP_DIR/$ASSET" "$INSTALL_TMP"
    chmod 0755 "$INSTALL_TMP"
    mv -f "$INSTALL_TMP" "$INSTALL_DIR/ttyd-pro"
    log "Installed ttyd-pro to $INSTALL_DIR/ttyd-pro"
fi

# The session wrapper and its helpers, next to the binary.
#
# Without the wrapper a deployment can only run a fixed child command, so every
# browser tab lands in the same tmux session and `?arg=cwd:…&arg=name:…` has
# nowhere to be interpreted — the routing the UI is built around simply does not
# happen.
#
# ttyd-snapshot.sh and ttyd-reap-idle.sh are its companions: the wrapper looks
# for ttyd-snapshot.sh beside itself to rebuild a session the reaper parked, and
# quietly does without it when absent. Installing them into the same directory
# is what makes parking and restoring reachable from a release, instead of only
# from a git checkout.
#
# Best-effort on purpose, all three: a release published before a given script
# became an asset still installs a working binary, and a plain terminal is a far
# better outcome than a failed install.
install_deploy_script() {
    WRAPPER="$1"
    curl --proto '=https' --tlsv1.2 -fL "$RELEASE_BASE/$WRAPPER" -o "$TMP_DIR/$WRAPPER" 2>/dev/null || {
        log "Note: $WRAPPER is not published in this release; skipping it."
        return 0
    }
    WRAPPER_EXPECTED=$(awk -v name="$WRAPPER" '$2 == name || $2 == "*" name { print $1; exit }' "$TMP_DIR/SHA256SUMS")
    if [ -n "$WRAPPER_EXPECTED" ]; then
        if command -v sha256sum >/dev/null 2>&1; then
            WRAPPER_ACTUAL=$(sha256sum "$TMP_DIR/$WRAPPER" | awk '{print $1}')
        else
            WRAPPER_ACTUAL=$(shasum -a 256 "$TMP_DIR/$WRAPPER" | awk '{print $1}')
        fi
        [ "$WRAPPER_ACTUAL" = "$WRAPPER_EXPECTED" ] || die "SHA-256 verification failed for $WRAPPER"
    fi
    WRAPPER_TMP="$INSTALL_DIR/.$WRAPPER.new.$$"
    cp "$TMP_DIR/$WRAPPER" "$WRAPPER_TMP"
    chmod 0755 "$WRAPPER_TMP"
    mv -f "$WRAPPER_TMP" "$INSTALL_DIR/$WRAPPER"
    log "Installed $WRAPPER to $INSTALL_DIR/$WRAPPER"
}
install_deploy_script ttyd-session.sh
install_deploy_script ttyd-snapshot.sh
install_deploy_script ttyd-reap-idle.sh

add_to_path() {
    case ":${PATH:-}:" in *":$INSTALL_DIR:"*) return ;; esac
    [ "$MODIFY_PATH" = true ] || {
        log "Add $INSTALL_DIR to PATH to run ttyd-pro from any directory."
        return
    }

    case "$OS:${SHELL:-}" in
        Darwin:*zsh*) PROFILE="$HOME/.zshrc" ;;
        *:*bash*) PROFILE="$HOME/.bashrc" ;;
        *) PROFILE="$HOME/.profile" ;;
    esac
    PATH_LINE="export PATH=\"$INSTALL_DIR:\$PATH\""
    if [ ! -f "$PROFILE" ] || ! grep -F "$PATH_LINE" "$PROFILE" >/dev/null 2>&1; then
        printf '\n# Added by ttyd-pro installer\n%s\n' "$PATH_LINE" >> "$PROFILE"
        log "Added $INSTALL_DIR to PATH in $PROFILE (open a new shell to apply)."
    fi
}

updater_dir() {
    printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/ttyd-pro"
}

install_updater_script() {
    UPDATE_DIR=$(updater_dir)
    mkdir -p "$UPDATE_DIR"
    UPDATE_NEW="$UPDATE_DIR/install.sh.new"
    UPDATE_SUMS="$UPDATE_DIR/SHA256SUMS.new"
    curl --proto '=https' --tlsv1.2 -fL \
        "https://github.com/$REPO/releases/latest/download/install.sh" \
        -o "$UPDATE_NEW"
    curl --proto '=https' --tlsv1.2 -fL \
        "https://github.com/$REPO/releases/latest/download/SHA256SUMS" \
        -o "$UPDATE_SUMS"
    UPDATE_EXPECTED=$(awk '$2 == "install.sh" || $2 == "*install.sh" { print $1; exit }' "$UPDATE_SUMS")
    [ -n "$UPDATE_EXPECTED" ] || die "no checksum published for the auto-updater"
    if command -v sha256sum >/dev/null 2>&1; then
        UPDATE_ACTUAL=$(sha256sum "$UPDATE_NEW" | awk '{print $1}')
    else
        UPDATE_ACTUAL=$(shasum -a 256 "$UPDATE_NEW" | awk '{print $1}')
    fi
    [ "$UPDATE_ACTUAL" = "$UPDATE_EXPECTED" ] || die "auto-updater SHA-256 verification failed"
    mv -f "$UPDATE_NEW" "$UPDATE_DIR/install.sh"
    rm -f "$UPDATE_SUMS"
    chmod 0755 "$UPDATE_DIR/install.sh"
    printf '%s' "$UPDATE_DIR/install.sh"
}

enable_cron_fallback() {
    UPDATE_SCRIPT=$1
    command -v crontab >/dev/null 2>&1 || die "no supported user scheduler found (systemd user, launchd, or cron)"
    MARKER="# ttyd-pro-auto-update"
    CURRENT=$(crontab -l 2>/dev/null || true)
    CLEAN=$(printf '%s\n' "$CURRENT" | grep -Fv "$MARKER" || true)
    {
        printf '%s\n' "$CLEAN"
        printf '17 4 * * * /bin/sh "%s" --quiet --bin-dir "%s" --no-modify-path %s\n' "$UPDATE_SCRIPT" "$INSTALL_DIR" "$MARKER"
    } | crontab -
    log "Enabled daily auto-update with the current user's crontab."
}

enable_auto_update() {
    UPDATE_SCRIPT=$(install_updater_script)
    if [ "$OS" = Linux ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
        UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
        mkdir -p "$UNIT_DIR"
        cat > "$UNIT_DIR/ttyd-pro-update.service" <<EOF
[Unit]
Description=Update ttyd-pro from GitHub Releases

[Service]
Type=oneshot
ExecStart=/bin/sh "$UPDATE_SCRIPT" --quiet --bin-dir "$INSTALL_DIR" --no-modify-path
EOF
        cat > "$UNIT_DIR/ttyd-pro-update.timer" <<'EOF'
[Unit]
Description=Daily ttyd-pro update check

[Timer]
OnBootSec=15m
OnUnitActiveSec=1d
RandomizedDelaySec=2h
Persistent=true

[Install]
WantedBy=timers.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable --now ttyd-pro-update.timer >/dev/null
        log "Enabled daily auto-update with a systemd user timer."
        return
    fi

    if [ "$OS" = Darwin ] && command -v launchctl >/dev/null 2>&1; then
        AGENT_DIR="$HOME/Library/LaunchAgents"
        PLIST="$AGENT_DIR/io.github.vannguyen799.ttyd-pro.update.plist"
        mkdir -p "$AGENT_DIR"
        cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.github.vannguyen799.ttyd-pro.update</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string><string>$UPDATE_SCRIPT</string><string>--quiet</string>
    <string>--bin-dir</string><string>$INSTALL_DIR</string><string>--no-modify-path</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>86400</integer>
</dict></plist>
EOF
        launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
        if launchctl bootstrap "gui/$(id -u)" "$PLIST" >/dev/null 2>&1; then
            log "Enabled daily auto-update with a user LaunchAgent."
            return
        fi
        rm -f "$PLIST"
    fi

    enable_cron_fallback "$UPDATE_SCRIPT"
}

disable_auto_update() {
    UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl --user disable --now ttyd-pro-update.timer >/dev/null 2>&1 || true
    fi
    rm -f "$UNIT_DIR/ttyd-pro-update.service" "$UNIT_DIR/ttyd-pro-update.timer"

    PLIST="$HOME/Library/LaunchAgents/io.github.vannguyen799.ttyd-pro.update.plist"
    if [ -f "$PLIST" ] && command -v launchctl >/dev/null 2>&1; then
        launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    fi
    rm -f "$PLIST"

    if command -v crontab >/dev/null 2>&1; then
        CURRENT=$(crontab -l 2>/dev/null || true)
        printf '%s\n' "$CURRENT" | grep -Fv '# ttyd-pro-auto-update' | crontab - 2>/dev/null || true
    fi
    rm -rf "$(updater_dir)"
    log "Disabled ttyd-pro auto-update."
}

add_to_path
case "$AUTO_UPDATE" in
    enable) enable_auto_update ;;
    disable) disable_auto_update ;;
esac

log "Run: ttyd-pro --version"
log "Update later by re-running this installer."
