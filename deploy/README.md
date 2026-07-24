# ttyd - Web Terminal (Local)

Lightweight web terminal accessible from any browser. A custom virtual-keyboard (vkbd) UI is served on a **single public port `10090`**; it proxies to a **localhost-only `ttyd` backend** (port `7681`) that runs the PTY + tmux. Only `10090` is meant to be exposed/tunneled — `7681` is internal.

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

```nix
packages = [
  # ... your packages

  # Web Terminal
  pkgs.ttyd
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

  URL: http://localhost:10090       # public vkbd UI (the one you open)

  Username: user
  Password: abc12345

  Stop: bash deploy/scripts/stop-ttyd.sh
══════════════════════════════════════════════════════════════
```

> `start-ttyd.sh` brings up **both** the localhost `ttyd` backend and the
> public vkbd UI on `10090` in one shot; `stop-ttyd.sh` stops both. You only
> ever open / tunnel port **10090**.

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

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --password` | Set terminal password | Random 8-char |
| `-P, --port` | Internal ttyd backend port (localhost only) | 7681 |
| `-u, --username` | Set username | user |
| `-n, --no-auth` | Disable authentication | false |
| `-h, --help` | Show help | - |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `TTYD_PASSWORD` | Terminal password |
| `TTYD_USERNAME` | Username |
| `TTYD_PORT` | Internal ttyd backend port (default 7681) |
| `TTYD_UI_PORT` | Public vkbd UI port (default 10090) |

---

## How It Works

```
┌─────────────────┐
│ Browser         │
└────────┬────────┘
         │ HTTP/WebSocket   (public)
         ▼
┌────────────────────────────┐
│ vkbd web UI (webpack)      │  port 10090  ← the only exposed port
│ serves custom UI + proxies │
└────────┬───────────────────┘
         │ proxy /ws + /token   (localhost)
         ▼
┌────────────────────────────┐
│ ttyd backend               │  127.0.0.1:7681  (internal, not exposed)
└────────┬───────────────────┘
         │
         ▼
┌─────────────────┐
│ tmux → bash/zsh │
└─────────────────┘
```

1. **vkbd UI** (webpack dev server, `start-ttyd-ui.sh`) serves the custom
   virtual-keyboard front-end on the public port **10090**.
2. It proxies `/ws` + `/token` to the **ttyd backend**, which is bound to
   `127.0.0.1:7681` and never exposed externally.
3. **ttyd** runs the PTY and attaches to tmux (see Session Routing).

> Why two processes? The stock `ttyd` binary (`pkgs.ttyd`) only serves its
> own default UI. The custom vkbd UI lives in the `_ttyd` submodule and is
> served by webpack, which proxies the terminal traffic to ttyd. To collapse
> to a single process you'd have to build the fork's ttyd binary with the UI
> embedded.

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
Browser paste/drop  ──POST /clipboard-image──▶  webpack (webpack.config.js)
                                                      │ xclip -i (stdin)
                                                      ▼
                                            X clipboard on :77  (Xvfb, 1x1)
                                                      ▲
   UI sends Ctrl+V (0x16) ──▶ tmux ──▶ claude ────────┘  reads it, shows [Image #1]
```

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

- **Backend is localhost-only**: the `ttyd` backend binds to `127.0.0.1:7681` and is never exposed. Only the vkbd UI on `10090` is public — expose/tunnel just that port.
- **Password protection**: Enabled by default with random password. The UI's webpack proxy injects the same credential onto the `/ws` upgrade (Safari/iOS can't send the auth header there), while `/token` stays password-gated.
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

### ttyd not found

Rebuild your IDX environment after adding packages to `dev.nix`:
- Press `Ctrl+Shift+P` → "IDX: Rebuild Environment"

Or install via nix-env:
```bash
nix-env -iA nixpkgs.ttyd
```

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

By default tmux keeps sessions only in RAM — a reboot wipes them. To save
sessions and auto-restore them on boot, the kit uses
[tmux-resurrect](https://github.com/tmux-plugins/tmux-resurrect) +
[tmux-continuum](https://github.com/tmux-plugins/tmux-continuum), wired up
the Nix way (no TPM).

**Setup:**

1. Add the plugins to `dev.nix` (already in `dev.nix.template`):
   ```nix
   pkgs.tmuxPlugins.resurrect
   pkgs.tmuxPlugins.continuum
   ```
   Then rebuild the environment (IDX: Rebuild Environment).

2. `start-ttyd.sh` does the rest automatically on every start:
   - appends a `source-file .../deploy/config/tmux-persist.conf` line to
     `~/.tmux.conf` (idempotent — runs once),
   - starts the tmux server so continuum can **auto-restore** saved
     sessions on boot, before any browser connects.

**Behavior** (configured in `deploy/config/tmux-persist.conf`):

| | |
|--|--|
| Auto-save | every 15 min (`@continuum-save-interval`) |
| Auto-restore | on tmux server start (`@continuum-restore on`) |
| Manual save / restore | `prefix + Ctrl-s` / `prefix + Ctrl-r` |

**What persists:** window/pane layout, working dirs, scrollback at save
time, and re-launch of whitelisted programs (`@resurrect-processes`
includes `claude`, `codex`, `ssh`, `psql`, `node`, `python3`, `htop`).

**What does NOT persist:** live in-memory state. Agents like `claude`/`codex`
are re-launched **fresh** — their conversation/history is not restored.

> Conflict with ttyd? **No.** resurrect/continuum operate at the tmux-server
> level; ttyd only attaches to tmux. The wrapper's `tmux new -A` simply
> attaches to whatever continuum restored.

---

## Files Structure

```
ttyd/                     # this ttyd fork (C source + html/ vkbd frontend)
└── deploy/               # operational layer (build + run the fork)
    ├── config/
    │   └── tmux-persist.conf # resurrect + continuum settings (sourced by ~/.tmux.conf)
    ├── scripts/
    │   ├── setup-ubuntu-vps.sh # One-shot build + install + start on a fresh VPS
    │   ├── start-ttyd.sh     # Start backend + public vkbd UI (+ tmux persistence)
    │   ├── stop-ttyd.sh      # Stop both UI and backend
    │   ├── status-ttyd.sh    # Check status (UI + backend)
    │   ├── start-ttyd-ui.sh  # Public vkbd UI (webpack) on :10090, proxies to backend
    │   ├── stop-ttyd-ui.sh   # Stop the vkbd UI server
    │   ├── start-clipboard-x.sh # Headless X (:77) holding the paste clipboard
    │   └── ttyd-session.sh   # URL-arg routing → tmux / screen
    └── README.md             # This file
```

---

## License

MIT - Use freely in your projects.
