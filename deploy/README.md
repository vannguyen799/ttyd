# ttyd - Web Terminal (Local)

Lightweight web terminal accessible from any browser. **One process, one port** (`10090`): this fork's `ttyd` binary serves the custom virtual-keyboard (vkbd) UI, the terminal WebSocket and the image-paste endpoint itself. There is no proxy and no Node runtime in the deployment.

## What is ttyd?

[ttyd](https://github.com/tsl0922/ttyd) shares your terminal over HTTP/WebSocket:
- **Native terminal experience** in browser
- **Lightweight** (~3MB binary)
- **Fast** with minimal latency
- **Secure** with optional authentication

## ttyd vs sshx vs tmate

| Feature | ttyd | sshx | tmate |
|---------|------|------|-------|
| Web UI | Native terminal | Modern canvas | Basic |
| Multiple cursors | No | Yes | No |
| SSH access | No | No | Yes |
| Resource usage | Very light | Light | Light |
| Install | Nix packages | curl script | Nix package |
| Best for | Quick local terminal | Pair programming | SSH workflows |

**Recommendation:**
- Use **ttyd** for quick terminal access in browser
- Use **sshx** for collaborative work with multiple users
- Use **tmate** for SSH-based automation

---

## Requirements

Add to your `dev.nix`:

The `ttyd` binary is **built from this repo**, not installed from a package —
stock ttyd serves its own default UI and has no `/clipboard-image` endpoint.
`start-ttyd.sh` builds it for you; you only need the build and runtime deps:

```nix
packages = [
  # ... your packages

  # Web Terminal — build deps for this fork's ttyd
  pkgs.cmake
  pkgs.libwebsockets
  pkgs.json_c
  pkgs.libuv
  pkgs.zlib

  pkgs.tmux      # default session multiplexer
  pkgs.screen    # optional, for /screen/<name> routes

  # Optional: persist tmux sessions across reboots (see Session Persistence)
  pkgs.tmuxPlugins.resurrect
  pkgs.tmuxPlugins.continuum
];
```

Then rebuild your environment.

---

## Quick Start

```bash
bash deploy/scripts/start-ttyd.sh
```

Output:
```
══════════════════════════════════════════════════════════════
  WEB TERMINAL READY
══════════════════════════════════════════════════════════════

  URL: http://localhost:10090

  Username: user
  Password: abc12345

  Stop: bash deploy/scripts/stop-ttyd.sh
══════════════════════════════════════════════════════════════
```

> `start-ttyd.sh` builds the fork's binary if `build/ttyd` is missing or older
> than the sources, then runs it. A restart with unchanged sources skips the
> build and is instant.

---

## Usage

### Start Web Terminal

```bash
bash deploy/scripts/start-ttyd.sh
```

### With Custom Options

```bash
# Custom password
bash deploy/scripts/start-ttyd.sh -p mysecret

# Custom username and password
bash deploy/scripts/start-ttyd.sh -u admin -p secret123

# No authentication (open access)
bash deploy/scripts/start-ttyd.sh -n

# Custom port
bash deploy/scripts/start-ttyd.sh -P 8080
```

### Check Status

```bash
bash deploy/scripts/status-ttyd.sh
```

### Stop Web Terminal

```bash
bash deploy/scripts/stop-ttyd.sh
```

---

## Run as a Service (systemd)

`start-ttyd.sh` is meant to be run by hand. To have the terminal come back on
boot, install it as a unit:

```bash
sudo bash deploy/scripts/install-systemd.sh
```

That renders `deploy/systemd/ttyd.service` for this host (user = whoever owns
the checkout), seeds `/etc/default/ttyd` from
`deploy/systemd/ttyd.env.example` with a generated password, then enables and
starts it. The unit runs `start-ttyd.sh --foreground`, so the service and a
manual start share one code path — same flags, same clipboard bridge, same
tmux persistence.

```bash
systemctl status ttyd          # is it up
journalctl -u ttyd -f          # what it is doing
sudoedit /etc/default/ttyd     # port, credentials, bind address, landing session
systemctl restart ttyd         # apply
```

Two things worth knowing:

- **`KillMode=process` is load-bearing.** The terminal's tmux server is
  started by the service, so it lives in the service's cgroup. Under systemd's
  default `KillMode=control-group`, `systemctl restart ttyd` would kill every
  live session — the exact work the browser reconnects to. Signalling only ttyd
  keeps sessions running across restarts and upgrades.
- **The password must be fixed.** `--foreground` refuses to start with a
  generated one: a service would mint a new password on every restart and
  nobody would ever see it. Set `TTYD_PASSWORD` in the environment file (the
  installer does) or run with `-n`.

### Restarting without a password

Rebuilding `html/` means restarting the service, which otherwise asks for a
sudo password every time. `deploy/systemd/ttyd-deploy.sudoers.example` grants
exactly that and nothing else:

```bash
sudo install -m 0440 -o root -g root \
    deploy/systemd/ttyd-deploy.sudoers.example /etc/sudoers.d/ttyd-deploy
sudo visudo -c        # never skip: a broken sudoers file locks out sudo
```

It covers `systemctl start|stop|restart|try-restart ttyd` for the checkout's
owner. It deliberately leaves out the installer — that script sits in a
directory the same user can write, so a NOPASSWD rule on it would be a
NOPASSWD rule on anything they later put in the file. For logs, add the user
to `systemd-journal` rather than putting `journalctl` behind sudo, where its
pager's `!cmd` escape would hand out a root shell.

The installer also retires the old two-process deployment if it finds it
(`ttyd-backend.service` on `:7681` plus `ttyd-ui.service` running webpack on
the public port). It stops them without taking their cgroup — and therefore
your tmux sessions — down, and removes their private launcher scripts.

---

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --password` | Set terminal password | Random 8-char |
| `-P, --port` | Public port to serve on | 10090 |
| `-u, --username` | Set username | user |
| `-b, --bind` | Address to bind | 0.0.0.0 |
| `-n, --no-auth` | Disable authentication | false |
| `-F, --foreground` | Run ttyd in the foreground (systemd `Type=simple`) | false |
| `-- ARG...` | Wrapper args for a bare URL (no `?arg=`) | none |
| `-h, --help` | Show help | - |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TTYD_PASSWORD` | Terminal password |
| `TTYD_USERNAME` | Username |
| `TTYD_PORT` | Public port (default 10090) |
| `TTYD_BIND` | Bind address (default 0.0.0.0) |
| `TTYD_BIN` | ttyd binary to run (default: the fork's `build/ttyd`) |
| `TTYD_CLIP_DISPLAY` | X display holding the paste clipboard (default `:77`) |
| `TTYD_SESSION_ARGS` | Wrapper args for a bare URL, e.g. `cwd:/srv/app name:main` |

---

## How It Works

```
┌─────────────────┐
│ Browser         │
└────────┬────────┘
         │ HTTP/WebSocket
         ▼
┌──────────────────────────────────────────┐
│ ttyd (this fork)            port 10090   │  ← the only process
│   /                → vkbd UI (html.h)    │
│   /ws              → PTY                 │
│   /token           → basic-auth token    │
│   /clipboard-image → xclip (clipboard.c) │
│   /tabs            → tab layout store    │
└────────┬─────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ tmux → bash/zsh │
└─────────────────┘
```

The whole front-end is compiled into the binary: `yarn build` in `html/`
inlines the bundle into a single HTML file, gzips it and emits it as a C array
in `src/html.h`, which `src/http.c` serves at `/`. So there is no static file
tree to deploy, no Node runtime on the box, and no second port to firewall.

**Editing the front-end.** Rebuilding the binary on every CSS tweak is
miserable, so `start-ttyd-ui.sh` still exists: it runs the webpack dev server
(port 9000) with hot reload and proxies `/ws`, `/token`, `/clipboard-image`
and `/tabs` to the real ttyd. When you're happy, `yarn build` bakes the result back into
`src/html.h` and the next `start-ttyd.sh` picks it up.

---

## Copying Text Out of tmux

Getting terminal text onto your clipboard crosses two boundaries that both
tend to fail silently, so it is worth knowing which half is misbehaving.

### The tmux half — getting text into a buffer

With `mouse on`, a drag selects inside tmux (server side), so xterm.js has no
DOM selection for the browser to copy. Worse, **once the foreground app turns
on mouse reporting — Claude Code, vim, htop — tmux forwards the wheel to the
app and never enters copy-mode at all.** Scrolling does nothing, and a bare
`C-e` reaches the app as an ordinary end-of-line. That is why the wheel and the
old "⏷ Last" button appeared dead in exactly the app you use them in.

The prefix table is the way out: tmux claims the prefix before the pane does,
whatever the app has enabled. `tmux-persist.conf` binds:

| Keys | Does |
|---|---|
| `prefix C-p` / `C-n` | scroll up / down (enters copy-mode as needed) |
| `prefix C-e` | jump to the live bottom; no-op outside copy-mode |
| `prefix C-y` | push the current tmux buffer to the clipboard |
| `prefix C-w` | capture the last ~200 lines straight to the clipboard |

The vkbd `tmux` group drives all of these — **▲/▼ tmux**, **⏷ Last**,
**buf→clip**, **⧉ Screen**. Use these rather than the generic ▲/▼ Scroll keys
in the `fn` group, which synthesize a wheel event and so only reach a bare
shell. Once tmux *is* in copy-mode it takes the mouse back from the app, so
drag-to-select works again from there.

`⧉ Screen` skips selecting entirely — worth reaching for first on a phone.

### The browser half — getting the buffer onto the clipboard

tmux ships the buffer to the browser as an **OSC 52** escape (that is what
`load-buffer -w` emits; `set-clipboard off` only disables tmux's *own*
auto-copy, and `Ms` is forced because `tmux-256color` omits it). xterm's
`ClipboardAddon` receives it — but its stock provider calls
`navigator.clipboard.writeText` and nothing else, which fails on both paths
this UI actually runs on:

- **plain HTTP** — the UI is served on `0.0.0.0:10090`, not HTTPS, and
  `navigator.clipboard` does not exist outside a secure context;
- **no user gesture** — the escape arrives on the websocket long after the tap
  that asked for it, and Safari/Firefox reject writes outside a trusted event.

So the addon is constructed with a provider that degrades instead:

```
navigator.clipboard  →  execCommand('copy')  →  copy sheet ("tap to copy")
   HTTPS + gesture        plain HTTP              always works
```

The sheet is the normal path for server-originated copies on a plain-HTTP
origin, because no gesture is live when the escape lands — one extra tap, and
that tap *is* the gesture the tier above it was missing. **Serving the UI over
HTTPS promotes those copies to tier 1 and removes the sheet.**

> `ClipboardAddon` 0.1.0 ships typings that disagree with its build: the `.d.ts`
> says `constructor(provider?)`, the JS is `constructor(base64, provider)`.
> Passing a provider first installs it as the *base64 codec* and silently keeps
> the default provider — hence the `ClipboardAddonCtor` cast in `xterm/index.ts`.

Desktop shortcut, unchanged and bypassing all of the above: ⌥+drag (macOS) or
Shift+drag (Win/Linux) makes a real xterm selection, then Cmd/Ctrl+C.

### After changing this

tmux only reads its config at server start. Existing sessions keep the old
bindings until you reload:

```bash
tmux source-file ~/.tmux.conf
```

---

## Image Paste (screenshots into Claude Code)

Paste or drag an image into the terminal and Claude Code receives it as a real
`[Image #1]` chip — same as a native terminal.

**Why it needs machinery.** Claude Code doesn't read images from the terminal
stream; it reads them off the **X clipboard**:

```
xclip -selection clipboard -t TARGETS -o | grep image/png    # detect
xclip -selection clipboard -t image/png -o > tmpfile          # read
```

A browser tab can't reach the host clipboard, and a headless server has no X
session at all — so Ctrl+V finds nothing. The bridge supplies both halves:

```
Browser paste/drop  ──POST /clipboard-image──▶  ttyd (src/clipboard.c)
                                                      │ xclip -i (stdin)
                                                      ▼
                                            X clipboard on :77  (Xvfb, 1x1)
                                                      ▲
   UI sends Ctrl+V (0x16) ──▶ tmux ──▶ claude ────────┘  reads it, shows [Image #1]
```

The bytes are piped to `xclip` asynchronously on ttyd's libuv loop — an 8 MB
paste is far past a pipe buffer, and a blocking write would stall every other
terminal on the server. The reply waits for `xclip`'s parent to exit rather
than merely for the write to flush: `xclip` forks into the background only
*after* it has claimed the selection, so a missing display or a missing
`xclip` comes back as a real error instead of a success followed by a paste
that does nothing.

`start-clipboard-x.sh` runs a 1x1 headless display (~3 MB) whose only job is
holding a clipboard selection. It is deliberately separate from the VNC (`:1`)
and xpra (`:100`) displays so image paste doesn't depend on a desktop running.

**How to use it**

| Where | Gesture |
|---|---|
| Desktop | Ctrl/Cmd+V, or drag an image file onto the terminal |
| Mobile | the **🖼** key in the vkbd `readline` group (opens gallery/camera) |

Images are re-encoded to PNG in the browser and capped at 1568px on the long
edge — Claude's vision pipeline downscales past that anyway, so this costs no
fidelity and keeps mobile uploads small.

**Requirements**: `pkgs.xclip` and `pkgs.xorg.xorgserver` (both in
`dev.nix.template`). Without them everything else still works; only image paste
is disabled, and `status-ttyd.sh` reports it as stopped.

**Caveat — already-running sessions.** `DISPLAY` reaches the agent by being
exported before ttyd starts, so tmux panes created *before* the bridge came up
still have no `DISPLAY` and will silently find no image. Restart the affected
session (or `export DISPLAY=:77` in that pane) after enabling this the first
time.

**Security**: `/clipboard-image` is gated by the same credential as the
terminal — ttyd's `/token` hands the browser `base64("user:pass")` and the
client replays it in an `Authorization: Basic` header. Bodies over 12 MB are
rejected. Nothing is written to disk: the image is piped to `xclip` via stdin.

---

## Security Notes

- **One exposed port**: ttyd binds `0.0.0.0:10090` by default. Pass `-b 127.0.0.1` to keep it local and reach it through a tunnel or reverse proxy instead.
- **Password protection**: enabled by default with a random password. `/` and `/token` are gated by HTTP Basic Auth; `/clipboard-image` and `/tabs` by the same credential, replayed by the client in an `Authorization` header.
- **Tab layout file**: written `0600` and never served anywhere but `/tabs`, because it names every session the user has open. Nothing else about a session is in it — no scrollback, no credentials.
- **WebSocket auth**: the `/ws` upgrade deliberately does *not* require the `Authorization` header — WebKit never sends one on an upgrade, so requiring it locked out every iPhone and iPad. The gate is the `AuthToken` message instead: until it arrives and matches, ttyd refuses every other command and spawns no PTY. An unauthenticated peer can complete the handshake and nothing else.
- **Disable auth** (optional): Use `-n` flag for open access

```bash
# With password (default)
bash deploy/scripts/start-ttyd.sh

# Without password
bash deploy/scripts/start-ttyd.sh -n
```

---

## Add to package.json (Optional)

```json
{
  "scripts": {
    "terminal": "bash deploy/scripts/start-ttyd.sh",
    "terminal:stop": "bash deploy/scripts/stop-ttyd.sh",
    "terminal:status": "bash deploy/scripts/status-ttyd.sh"
  }
}
```

---

## Troubleshooting

### Build fails / ttyd not found

`start-ttyd.sh` builds `build/ttyd` from this checkout. If that fails it
prints the log path — `/tmp/ttyd-build.log` — and usually the cause is a
missing dev package (`libwebsockets`, `json-c`, `libuv`, `zlib`, `cmake`).
On Ubuntu, `deploy/scripts/setup-ubuntu-vps.sh` installs all of them; under
Nix, add the packages listed in Requirements to `dev.nix` and rebuild the
environment (`Ctrl+Shift+P` → "IDX: Rebuild Environment").

Already have a fork binary elsewhere? Point at it and skip the build:
```bash
TTYD_BIN=/usr/local/bin/ttyd bash deploy/scripts/start-ttyd.sh
```

### Default UI instead of the virtual keyboard

You are running a stock `ttyd`, not this fork. Check what started:
`ps aux | grep ttyd`. Unset `TTYD_BIN` (or point it at `build/ttyd`) and
restart.

### Connection refused

Check if ttyd is running:
```bash
bash deploy/scripts/status-ttyd.sh
```

### Multiple sessions

Each browser tab is a separate session by default. Use the session routing below to share tmux/screen sessions across tabs.

---

## Session Routing (tmux / screen auto-attach)

ttyd is launched with `--url-arg` and a wrapper script (`ttyd-session.sh`) that routes URL args to tmux or screen. Default backend is **tmux**.

The wrapper parses args as **`[modifier]... [session-type] [name]`**.

### Session spec

| URL | Action |
|-----|--------|
| `http://host:10090/` | `tmux new -A -s main` |
| `http://host:10090/?arg=work` | `tmux new -A -s work` |
| `http://host:10090/?arg=tmux&arg=dev` | `tmux new -A -s dev` |
| `http://host:10090/?arg=screen&arg=build` | `screen -xRR build` |

### Modifiers (stack before the session spec)

| Modifier | Effect |
|----------|--------|
| `cwd:<path>` | chdir to `<path>` before launching. If the path does not exist, it's auto-created with `mkdir -p`; if creation fails (e.g. no write permission) a warning is logged and the launch cwd is kept. |
| `codex` | On first-create of a tmux session, run `codex` (no args). Ignored for `screen`. |
| `codex:<args>` | Same as `codex`, plus forward `<args>` to Codex. Args are parsed with shell-style quoting (single/double quotes preserve spaces), then `%q`-quoted for safe embedding. The server injects no default flags. |
| `claude` | On first-create of a tmux session, run `claude` (no args). Ignored for `screen`. |
| `claude:<args>` | Same as `claude`, plus forward `<args>` to Claude. Args are parsed with shell-style quoting (single/double quotes preserve spaces), then `%q`-quoted for safe embedding. The server injects no default flags. |

Examples:

| URL | Action |
|-----|--------|
| `?arg=codex&arg=crm` | tmux `crm`; first-create runs `codex` |
| `?arg=codex:--help&arg=crm` | tmux `crm`; first-create runs `codex --help`, then drops to the shell |
| `?arg=cwd:/home/user/proj&arg=codex&arg=crm` | cd + tmux `crm` + codex |
| `?arg=codex:--help&arg=q` | tmux `q`; runs `codex --help`, then leaves the session in the shell |
| `?arg=claude&arg=work` | tmux `work`; first-create runs `claude` |

> **First-create vs attach:** the `codex`/`claude` modifier only runs on the initial session creation. Reattaching to an existing session never re-runs the agent CLI.
>
> **cwd & tmux:** tmux stores default-directory per session. `cwd:` only affects the first window when the session is *created*; reattaching keeps the original cwd.

- Opening the same URL in two tabs attaches both to the same session (shared view).
- Session names are sanitized: only `A-Z a-z 0-9 . _ -` are kept, max 64 chars.
- If `tmux`/`screen` is missing, the wrapper falls back to `$SHELL`.

> ttyd does not route on URL path segments natively. The `?arg=` query-string form is the native way to pass routing info. If you need literal `/screen/<name>` path URLs, put nginx/caddy in front and rewrite `/screen/NAME` → `/?arg=screen&arg=NAME`.

---

## Session Persistence (survive reboots)

A restart of the service costs nothing — the sessions live in tmux and ttyd
only attaches to them. A **reboot** is the real event: tmux keeps sessions in
RAM only, so without this layer every window, pane and agent goes with it.

Three things are saved, at three different levels:

| Level | What is kept | Where |
|--|--|--|
| Browser tabs | which sessions are open, their order, names and the bar layout | `--tabs-file` on the server (see [Tab layout](#tab-layout-shared-across-devices)) |
| tmux | window/pane layout, working dirs, scrollback, whitelisted programs | `~/.local/share/tmux/resurrect/` |
| Agents | the claude/codex conversation each pane was in | the CLIs' own transcripts, referenced by session id |

The tmux half is [tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect)
+ [tmux-continuum](https://github.com/tmux-plugins/tmux-continuum).

**Setup:** none, `start-ttyd.sh` does it on every start:

- appends a `source-file .../deploy/config/tmux-persist.conf` line to
  `~/.tmux.conf` (idempotent — runs once),
- makes sure both plugins are installed: the Nix profile is used when it has
  them (`pkgs.tmuxPlugins.resurrect` / `.continuum` in `dev.nix`), otherwise
  they are git-cloned into `~/.tmux/plugins/`,
- symlinks the agent hook to `~/.tmux/ttyd-agent-hook.sh`,
- starts the tmux server so continuum can **auto-restore** saved sessions on
  boot, before any browser connects.

**Behavior** (configured in `deploy/config/tmux-persist.conf`):

| | |
|--|--|
| Auto-save | every 5 min (`@continuum-save-interval`) |
| Auto-restore | on tmux server start (`@continuum-restore on`) |
| Backups kept | 7 days (`@resurrect-delete-backup-after`) |
| Manual save / restore | `prefix + Ctrl-s` / `prefix + Ctrl-r` |

The save interval is in whole **minutes**, and 5 is near the floor: continuum
hangs its save off a `status-right` interpolation rather than a timer, so it
is only evaluated once per `status-interval`, and a fractional value silently
disables auto-saving instead of going sub-minute.

**What persists:** window/pane layout, working dirs, scrollback at save
time, and re-launch of whitelisted programs (`@resurrect-processes`
includes `claude`, `codex`, `ssh`, `psql`, `node`, `python3`, `htop`).

**What does NOT persist:** live in-memory state. A process is re-launched, not
snapshotted, so anything a program held only in memory is gone — `htop` comes
back at its default view, an `ssh` session re-connects from scratch.

> Conflict with ttyd? **No.** resurrect/continuum operate at the tmux-server
> level; ttyd only attaches to tmux. The wrapper's `tmux new -A` simply
> attaches to whatever continuum restored.

### Agent conversations across a reboot

Agents are the exception to "re-launched fresh". `claude` and `codex` both keep
their transcript on disk and can re-enter one by id, so the pane can come back
into the same conversation — what is restored is the CLI's own saved history,
not a live process.

`resurrect-agent-hook.sh` runs as `@resurrect-hook-post-save-layout`,
rewriting the agent panes in the save file just before it is finalised:

```
claude --dangerously-skip-permissions --session-id <id>
  →  claude --dangerously-skip-permissions --resume <id>

node /usr/bin/codex --search
  →  node /usr/bin/codex resume --search <id>
```

Two ways the id is found:

- **Pinned at launch.** `ttyd-session.sh` gives every claude pane it creates an
  explicit `--session-id <uuid>`, so nothing has to be guessed for a session
  opened from the web UI.
- **Matched by directory.** For anything else — a hand-started agent, or codex,
  which has no launch-time equivalent — the newest transcript recorded for the
  pane's working directory wins (`~/.claude/projects/<slug>/<id>.jsonl`,
  `~/.codex/sessions/**/rollout-*.jsonl`). Each id is handed out once per save,
  so two agents in one directory take the two newest transcripts rather than
  both resuming the same one.

A pane with no transcript to point at is left exactly as resurrect saved it, so
the worst case is the old behaviour: the agent starts empty.

Inspect what a restore would do without touching anything:

```bash
deploy/scripts/resurrect-agent-hook.sh ~/.local/share/tmux/resurrect/last --dry-run
```

Flags are carried over, with one caveat: `codex resume` accepts a smaller set
of options than `codex` itself, so a flag it does not take is dropped rather
than guessed at (`codex resume --help` is the list).

### Tab layout, shared across devices

The web UI's tab list — which sessions are open, their order, their names, the
bar position — is stored on the server when ttyd is started with `--tabs-file`,
which `start-ttyd.sh` does by default:

```
~/.local/state/ttyd/tabs.json      # override with TTYD_TABS_FILE=, empty to disable
```

Without it the list lives only in that browser's `localStorage`: a phone and a
laptop pointed at the same deployment show two unrelated sets of tabs, and
clearing site data throws the list away while every tmux session behind it is
still running.

The endpoint is a single opaque JSON blob — `GET /tabs` to read, `POST /tabs`
to replace — under the same auth as everything else, stored `0600` because the
layout names every session the user has open. Each save carries a revision
stamp and the newer one wins on load; there is no merge, so a layout edited on
two devices at once resolves to whichever was touched last. A ttyd without
`--tabs-file` answers `404` and the UI silently falls back to `localStorage`.

---

## Files Structure

```
ttyd/                     # this ttyd fork (C source + html/ vkbd frontend)
└── deploy/               # operational layer (build + run the fork)
    ├── config/
    │   └── tmux-persist.conf # resurrect + continuum settings (sourced by ~/.tmux.conf)
    ├── systemd/
    │   ├── ttyd.service      # Unit template (@PLACEHOLDER@s filled in at install)
    │   ├── ttyd.env.example  # Seed for /etc/default/ttyd (port, creds, landing session)
    │   └── ttyd-deploy.sudoers.example # Password-free `systemctl restart ttyd`, nothing more
    ├── scripts/
    │   ├── setup-ubuntu-vps.sh # One-shot build + install + start on a fresh VPS
    │   ├── install-systemd.sh # Install the unit; retire the old two-process setup
    │   ├── start-ttyd.sh     # Build if needed, then start ttyd (+ tmux persistence)
    │   ├── stop-ttyd.sh      # Stop ttyd and the clipboard bridge
    │   ├── status-ttyd.sh    # Check status
    │   ├── start-ttyd-ui.sh  # DEV ONLY: webpack hot-reload server on :9000
    │   ├── stop-ttyd-ui.sh   # Stop the dev server
    │   ├── start-clipboard-x.sh # Headless X (:77) holding the paste clipboard
    │   ├── resurrect-agent-hook.sh # Restore claude/codex panes into their own conversation
    │   └── ttyd-session.sh   # URL-arg routing → tmux / screen
    └── README.md             # This file
```

---

## License

MIT - Use freely in your projects.
