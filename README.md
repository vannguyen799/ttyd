# ttyd-pro — a mobile-first fork of ttyd

**ttyd-pro** is a fork of [tsl0922/ttyd](https://github.com/tsl0922/ttyd) that turns the classic
"share your terminal over the web" tool into a practical **phone-and-tablet terminal** for driving
`tmux`, `claude`, `codex`, and other TUIs from a browser.

It keeps everything the upstream binary does and layers on a custom front-end plus an operational
deploy kit:

- 📱 **On-screen virtual keyboard (vkbd)** — grouped, scalable keys with Ctrl/Alt/arrows, `tmux`
  controls, and one-tap Claude/Codex command shortcuts (`/resume`, `/rewind`, `/compact`, …).
- 🗂 **Multi-tab terminal UI** — several sessions in one browser tab, an auto-hiding overlay bar,
  and per-tab sleep/wake with auto-reconnect on mobile.
- 📋 **Copy & paste that actually works on mobile** — OSC 52 → `execCommand` → tap-to-copy sheet
  fallback for plain-HTTP origins, touch select-mode, and a floating copy tooltip.
- 🖼 **Image paste into Claude Code and Codex** — paste or drag a screenshot and it is uploaded to
  a private temporary file, then referenced directly in the agent; no desktop, clipboard, or X server required.
- 🔀 **URL-based session routing** — `?arg=work`, `?arg=claude&arg=dev`, `cwd:` modifiers, etc.,
  auto-attach to named `tmux`/`screen` sessions.
- 💾 **Sessions that survive a reboot** — tmux window/pane layout is saved and restored, the tab
  list lives on the server rather than in one browser, and `claude`/`codex` panes come back into
  the conversation they were in instead of an empty one.
- 🛠 **Deploy layer** — start/stop/status scripts that run a localhost-only ttyd backend behind a
  public vkbd UI.

> The upstream PTY/WebSocket protocol remains intact. Fork additions live in the C HTTP backend,
> the `html/` front-end, and the `deploy/` operational layer.

![screenshot](screenshot.gif)

# Fork features

| Area | What ttyd-pro adds |
|------|--------------------|
| Virtual keyboard | Grouped/scalable keys, tmux scroll & copy-mode controls, Claude/Codex slash-command shortcuts, custom buttons, Android/iOS input fixes |
| Tabs | Multi-tab UI, auto-hide overlay bar, per-session tab groups, new tabs inherit the active tab's `cwd:`, per-tab sleep/wake, server-side tab layout shared across devices (`--tabs-file`) |
| Mobile | Auto-reconnect on tab re-activation, client-side auth-token persistence, no leave-site alert (tmux persists) |
| Auth | One password prompt per 30 days instead of one per browser restart — a successful login gets a `HttpOnly` session cookie that survives a ttyd restart (`--auth-max-age`, `--session-file`) |
| Clipboard | Reliable copy-out under tmux, touch select mode, floating selection tooltip, Claude/Codex image paste-in |
| tmux | Mouse-driven pane switching, drag-to-copy, wheel/prefix scroll into copy-mode, buffer→clipboard keys |
| Persistence | Pane layout restored after a reboot (resurrect/continuum, installed automatically), agent panes resumed into their own `claude`/`codex` session |
| Deploy | One-command start of backend + UI, headless image-upload bridge, VPS bootstrap |

The `deploy/` directory has its own [README](deploy/README.md) covering the runtime architecture,
clipboard internals, session routing, and persistence in depth.

# Upstream features (inherited)

- Built on top of [libuv](https://libuv.org) and [WebGL2](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API) for speed
- Fully-featured terminal with [CJK](https://en.wikipedia.org/wiki/CJK_characters) and IME support
- [ZMODEM](https://en.wikipedia.org/wiki/ZMODEM) ([lrzsz](https://ohse.de/uwe/software/lrzsz.html)) / [trzsz](https://trzsz.github.io) file transfer support
- [Sixel](https://en.wikipedia.org/wiki/Sixel) image output support ([img2sixel](https://saitoha.github.io/libsixel) / [lsix](https://github.com/hackerb9/lsix))
- SSL support based on [OpenSSL](https://www.openssl.org) / [Mbed TLS](https://github.com/Mbed-TLS/mbedtls)
- Run any custom command with options
- Basic authentication support and many other custom options
- Cross platform: macOS, Linux, FreeBSD/OpenBSD, [OpenWrt](https://openwrt.org), Windows

# Install

The release installer is user-scoped: it writes to `~/.local/bin` and never invokes `sudo`.
Running the same command again updates the existing binary. The custom web UI is embedded in the
binary, so this is the complete CLI installation rather than a reduced client.

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/install.sh | sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/install.ps1 | iex"
```

Then start a writable terminal, for example:

```bash
ttyd-pro -W bash
```

## User-scoped auto-update

Auto-update is opt-in. It installs a daily job owned by the current user—systemd user timer on
Linux, LaunchAgent on macOS, or Task Scheduler on Windows. It downloads only published GitHub
Release assets and verifies `SHA256SUMS`. No root task or `sudo` rule is created.

macOS or Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/install.sh | sh -s -- --auto-update
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -c "& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/vannguyen799/ttyd-pro/main/install.ps1'))) -AutoUpdate"
```

On macOS/Linux, the updater atomically replaces the installed file; a running ttyd process keeps
using its current version until it is restarted, so the job does not kill live terminal/tmux
sessions. Windows skips unchanged releases too, but an in-use executable may need ttyd to be
stopped before a changed binary can be installed. Use `--disable-auto-update` (or
`-DisableAutoUpdate` on Windows) to remove the job.

# Deploy quick start

For a source checkout or a managed VPS service, use the deploy kit. One process serves everything
— the vkbd UI, the terminal WebSocket and image paste:

```bash
bash deploy/scripts/start-ttyd.sh
```

```
══════════════════════════════════════════════════════════════
  WEB TERMINAL READY
══════════════════════════════════════════════════════════════

  URL: http://localhost:10090       # public vkbd UI (the one you open)

  Username: user
  Password: abc12345

  Stop: bash deploy/scripts/stop-ttyd.sh
══════════════════════════════════════════════════════════════
```

Port **10090** is the only one to expose or tunnel; pass `-b 127.0.0.1` to keep ttyd local and put
a tunnel or reverse proxy in front. See [deploy/README.md](deploy/README.md) for options, session
routing, image paste, and persistence.

To have it come back on boot, install the systemd unit — it runs the same script in the foreground,
and restarts leave live tmux sessions untouched:

```bash
sudo bash deploy/scripts/install-systemd.sh
```

On a fresh Ubuntu VPS, `bash deploy/scripts/setup-ubuntu-vps.sh` installs OS build dependencies,
builds, and starts everything in one shot. That VPS bootstrap uses `sudo` for `apt` and
`/usr/local/bin`; use the release installer above when a user-scoped binary is what you want.

# Publishing a release

GitHub Actions builds Linux, macOS, and Windows binaries, publishes them with `SHA256SUMS`, and
publishes multi-architecture container images to this repository's GHCR namespace. To publish a
new CLI version, update `project(ttyd VERSION ...)` in `CMakeLists.txt`, then push the matching
`vMAJOR.MINOR.PATCH` tag. For example:

```bash
git tag v1.8.0
git push origin v1.8.0
```

The public installer starts working after that tag's release workflow completes. Releases are not
drafts; the newest semantic-version tag becomes GitHub's latest release.

# Build from source

## Backend (ttyd binary)

Standard CMake build, same as upstream:

```bash
mkdir build && cd build
cmake ..
make && sudo make install
```

See the upstream [build instructions](https://github.com/tsl0922/ttyd#build-from-source) for
dependencies (libwebsockets, libuv, json-c, OpenSSL/Mbed TLS).

## Front-end (vkbd UI)

The custom UI lives in `html/` and compiles to the embedded `src/html.h`.

> **NOTE:** Node.js 20+ and pnpm are required. Corepack can provide the pinned pnpm version.

```bash
cd html
corepack enable
pnpm install
pnpm build     # builds the UI and inlines it into ../src/html.h
```

For UI development, run `pnpm start` (webpack dev server) against a running `ttyd bash`.

# Usage

## Command-line Options

```
USAGE:
    ttyd [options] <command> [<arguments...>]

OPTIONS:
    -p, --port              Port to listen (default: 7681, use `0` for random port)
    -i, --interface         Network interface to bind (eg: eth0), or UNIX domain socket path (eg: /var/run/ttyd.sock)
    -U, --socket-owner      User owner of the UNIX domain socket file, when enabled (eg: user:group)
    -c, --credential        Credential for basic authentication (format: username:password)
    -H, --auth-header       HTTP Header name for auth proxy, this will configure ttyd to let a HTTP reverse proxy handle authentication
    -u, --uid               User id to run with
    -g, --gid               Group id to run with
    -s, --signal            Signal to send to the command when exit it (default: 1, SIGHUP)
    -w, --cwd               Working directory to be set for the child program
    -a, --url-arg           Allow client to send command line arguments in URL (eg: http://localhost:7681?arg=foo&arg=bar)
    -W, --writable          Allow clients to write to the TTY (readonly by default)
    -t, --client-option     Send option to client (format: key=value), repeat to add more options
    -T, --terminal-type     Terminal type to report, default: xterm-256color
    -O, --check-origin      Do not allow websocket connection from different origin
    -m, --max-clients       Maximum clients to support (default: 0, no limit)
    -o, --once              Accept only one client and exit on disconnection
    -q, --exit-no-conn      Exit on all clients disconnection
    -B, --browser           Open terminal with the default system browser
    -I, --index             Custom index.html path
    -b, --base-path         Expected base path for requests coming from a reverse proxy (eg: /mounted/here, max length: 128)
    -P, --ping-interval     Websocket ping interval(sec) (default: 5)
    -6, --ipv6              Enable IPv6 support
    -S, --ssl               Enable SSL
    -C, --ssl-cert          SSL certificate file path
    -K, --ssl-key           SSL key file path
    -A, --ssl-ca            SSL CA file path for client certificate verification
    -d, --debug             Set log level (default: 7)
    -v, --version           Print the version and exit
    -h, --help              Print this text and exit
```

Read the example usage on the upstream [wiki](https://github.com/tsl0922/ttyd/wiki/Example-Usage).

## Browser Support

Modern browsers, See [Browser Support](https://github.com/xtermjs/xterm.js#browser-support).

# Credits

ttyd-pro is built on [tsl0922/ttyd](https://github.com/tsl0922/ttyd) by Shuanglei Tao and
contributors. All upstream copyrights remain with their authors.

# License

MIT — see [LICENSE](LICENSE).
