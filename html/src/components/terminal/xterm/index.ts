import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { OverlayAddon } from './addons/overlay';
import { ZmodemAddon } from './addons/zmodem';
import { bytesForKeyEvent, bytesForText } from '../../vkbd/actions';
import { loadSettings as loadVkbdSettings } from '../../vkbd/storage';

import '@xterm/xterm/css/xterm.css';

interface TtydTerminal extends Terminal {
    fit(): void;
}

export interface VirtualModHook {
    getMods: () => { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
    consume: () => void;
}

export interface TtydBridge {
    sendBytes: (data: string | Uint8Array) => void;
    scrollLines: (n: number) => void;
    scrollPages: (n: number) => void;
    scrollToBottom: () => void;
    paste: () => Promise<void>;
    copySelection: () => Promise<void>;
    setSelectMode: (on: boolean) => void;
    focus: () => void;
    vkbdHook?: VirtualModHook;
}

declare global {
    interface Window {
        term: TtydTerminal;
        ttyd: TtydBridge;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
}
type Preferences = ITerminalOptions & ClientOptions;

export type RendererType = 'dom' | 'canvas' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
    closeOnDisconnect: boolean;
}

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
}

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

function addEventListener(target: EventTarget, type: string, listener: EventListener): IDisposable {
    target.addEventListener(type, listener);
    return toDisposable(() => target.removeEventListener(type, listener));
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    private clipboardAddon = new ClipboardAddon();
    private webLinksAddon = new WebLinksAddon();
    private webglAddon?: WebglAddon;
    private canvasAddon?: CanvasAddon;
    private zmodemAddon?: ZmodemAddon;

    private socket?: WebSocket;
    private token: string;
    private opened = false;
    private title?: string;
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    private closeOnDisconnect = false;
    private reconnecting = false;
    private autoReconnectSetup = false;
    private resumeDisposables: IDisposable[] = [];
    private pendingReconnectKey?: IDisposable;

    private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));
    private fitRaf = 0;

    private selTip: HTMLDivElement | null = null;
    private selTipDismiss: (() => void) | null = null;
    private selTipDebounce = 0;
    private lastSel = '';

    // Touch "select mode" (mobile): xterm builds selections from mouse drags,
    // which never happen on a touchscreen. When on, each terminal tap is
    // turned into a synthetic mouse gesture — first tap = drag start (cell
    // anchor), second tap = drag end — so xterm's own selection logic runs
    // and the copy tooltip appears. Stays on until toggled off.
    private selectMode = false;
    private selStage: 0 | 1 = 0;
    private selAnchorPt: { x: number; y: number } | null = null;
    private selBanner: HTMLDivElement | null = null;
    private onSelectPointer: ((e: PointerEvent) => void) | null = null;

    constructor(
        private options: XtermOptions,
        private sendCb: () => void
    ) {}

    // Coalesce fit() calls to one per frame, skip invalid/no-op dims, and
    // resize only when the WriteBuffer has drained. terminal.write() is
    // async — data is queued and processed across multiple ticks. If
    // fitAddon.fit() resizes between ticks of one batch, the next tick
    // parses against new geometry with stale buffer.y, so
    // buffer.lines.get(ybase + y) returns undefined and crashes inside
    // print() with "Cannot read properties of undefined (reading
    // 'setCellFromCodepoint')" or inside lineFeed() with "...setting
    // 'isWrapped'". terminal.write('', cb) fires cb after all currently
    // queued data is processed, giving us a safe resize window.
    @bind
    private safeFit() {
        if (this.fitRaf) return;
        this.fitRaf = requestAnimationFrame(() => {
            this.fitRaf = 0;
            const t = this.terminal;
            if (!t || !t.element || !t.element.parentElement) return;
            t.write('', () => {
                if (!this.terminal || !this.terminal.element || !this.terminal.element.parentElement) return;
                const dims = this.fitAddon.proposeDimensions();
                if (!dims) return;
                if (!Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;
                if (dims.cols < 2 || dims.rows < 1) return;
                if (this.terminal.cols === dims.cols && this.terminal.rows === dims.rows) return;
                try {
                    this.fitAddon.fit();
                } catch (e) {
                    console.warn('[ttyd] fit failed', e);
                }
            });
        });
    }

    dispose() {
        if (this.fitRaf) {
            cancelAnimationFrame(this.fitRaf);
            this.fitRaf = 0;
        }
        this.hideSelTip();
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    // Copy text to clipboard: modern API first, textarea-execCommand fallback
    // for HTTP contexts where navigator.clipboard is unavailable.
    // Must be called within a user-gesture handler (click/keydown).
    private doCopy(text: string): Promise<void> {
        if (!text) return Promise.resolve();
        if (navigator.clipboard?.writeText) {
            return navigator.clipboard.writeText(text);
        }
        return new Promise((res, rej) => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;top:0;left:0;width:2px;height:2px;opacity:0;';
            document.body.appendChild(ta);
            ta.focus({ preventScroll: true });
            ta.select();
            const ok = (() => {
                try {
                    return document.execCommand('copy');
                } catch {
                    return false;
                }
            })();
            document.body.removeChild(ta);
            ok ? res() : rej(new Error('copy failed'));
        });
    }

    private showSelTip(sel: string) {
        // Debounce: only commit the tooltip 180ms after the last selection
        // change so it doesn't flicker during mouse-drag.
        window.clearTimeout(this.selTipDebounce);
        this.selTipDebounce = window.setTimeout(() => {
            this._renderSelTip(sel);
        }, 180);
    }

    private _renderSelTip(sel: string) {
        // Remove any previous tip before creating a new one.
        this.selTipDismiss?.();
        this.selTipDismiss = null;
        this.selTip?.remove();
        this.selTip = null;

        const tip = document.createElement('div');
        tip.className = 'ttyd-sel-tip';

        const txt = document.createElement('span');
        txt.className = 'ttyd-sel-tip-text';
        const firstLine = sel.split('\n')[0].trimEnd();
        txt.textContent = firstLine.length > 72 ? firstLine.slice(0, 72) + '…' : firstLine || sel.slice(0, 72);

        const btn = document.createElement('button');
        btn.className = 'ttyd-sel-tip-copy';
        btn.textContent = '⎘ Copy';
        btn.addEventListener('click', e => {
            e.stopPropagation();
            void this.doCopy(sel).then(() => this.overlayAddon?.showOverlay('✂', 300));
            this.hideSelTip();
        });

        tip.appendChild(txt);
        tip.appendChild(btn);
        tip.addEventListener('pointerdown', e => e.stopPropagation());

        const el = this.terminal?.element;
        const pos = this.terminal?.getSelectionPosition?.();
        if (pos && el) {
            const rect = el.getBoundingClientRect();
            const cellH = rect.height / Math.max(1, this.terminal.rows);
            const cellW = rect.width / Math.max(1, this.terminal.cols);
            const tx = Math.max(4, Math.min(rect.left + pos.end.x * cellW, window.innerWidth - 248));
            const ty = Math.max(4, Math.min(rect.top + (pos.end.y + 1) * cellH + 6, window.innerHeight - 44));
            tip.style.left = tx + 'px';
            tip.style.top = ty + 'px';
        } else if (el) {
            const rect = el.getBoundingClientRect();
            tip.style.left = rect.left + 8 + 'px';
            tip.style.top = Math.min(rect.bottom - 48, window.innerHeight - 44) + 'px';
        }

        document.body.appendChild(tip);
        this.selTip = tip;

        const dismiss = () => this.hideSelTip();
        // Small delay so the pointerup that ended the drag doesn't immediately dismiss.
        const t = window.setTimeout(() => {
            document.addEventListener('pointerdown', dismiss, { once: true });
            this.selTipDismiss = () => {
                window.clearTimeout(t);
                document.removeEventListener('pointerdown', dismiss);
            };
        }, 250);
        this.selTipDismiss = () => {
            window.clearTimeout(t);
            document.removeEventListener('pointerdown', dismiss);
        };
    }

    private hideSelTip() {
        window.clearTimeout(this.selTipDebounce);
        this.selTipDebounce = 0;
        this.selTipDismiss?.();
        this.selTipDismiss = null;
        this.selTip?.remove();
        this.selTip = null;
    }

    // ── Touch select mode ────────────────────────────────────────────────
    private setSelectMode(on: boolean) {
        if (on === this.selectMode) return;
        this.selectMode = on;
        if (on) this.enterSelectMode();
        else this.exitSelectMode();
    }

    private enterSelectMode() {
        const el = this.terminal?.element;
        if (!el) {
            this.selectMode = false;
            return;
        }
        this.selStage = 0;
        this.selAnchorPt = null;
        this.terminal?.clearSelection();
        this.hideSelTip();
        // Capture-phase so the tap never reaches xterm's own pointerdown
        // (which would focus the helper textarea and pop the OS keyboard).
        this.onSelectPointer = (e: PointerEvent) => this.handleSelectTap(e);
        el.addEventListener('pointerdown', this.onSelectPointer, true);
        this.showSelBanner('✂ Tap selection start');
    }

    private exitSelectMode() {
        const el = this.terminal?.element;
        if (el && this.onSelectPointer) el.removeEventListener('pointerdown', this.onSelectPointer, true);
        this.onSelectPointer = null;
        // Release any half-finished drag so xterm's document listeners detach.
        if (this.selStage === 1 && this.selAnchorPt) {
            this.synthMouse('mouseup', this.selAnchorPt.x, this.selAnchorPt.y, document);
        }
        this.selStage = 0;
        this.selAnchorPt = null;
        this.hideSelBanner();
    }

    private handleSelectTap(e: PointerEvent) {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        const el = this.terminal?.element;
        if (!el) return;
        const x = e.clientX;
        const y = e.clientY;
        if (this.selStage === 0) {
            // First tap: start a drag at the tapped cell (no mouseup yet, so
            // xterm stays in "dragging" state until the second tap).
            this.terminal?.clearSelection();
            this.synthMouse('mousedown', x, y, el);
            this.selAnchorPt = { x, y };
            this.selStage = 1;
            this.showSelBanner('✂ Tap selection end');
        } else {
            // Second tap: extend to here and release — onSelectionChange then
            // fires and the copy tooltip appears.
            this.synthMouse('mousemove', x, y, document);
            this.synthMouse('mouseup', x, y, document);
            this.selStage = 0;
            this.selAnchorPt = null;
            this.showSelBanner('✂ Tap selection start');
        }
        // xterm's own capture pointerdown handler runs before ours and flips
        // the helper textarea to inputmode=text; undo that so the tap doesn't
        // pop the OS keyboard while the user is selecting.
        const ta = el.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
        if (ta) {
            ta.inputMode = 'none';
            ta.blur();
        }
    }

    private synthMouse(type: 'mousedown' | 'mousemove' | 'mouseup', x: number, y: number, target: EventTarget) {
        target.dispatchEvent(
            new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: x,
                clientY: y,
                screenX: x,
                screenY: y,
                button: 0,
                buttons: type === 'mouseup' ? 0 : 1,
                // xterm's selection mousedown only starts on detail===1.
                detail: type === 'mousedown' ? 1 : 0,
            })
        );
    }

    private showSelBanner(text: string) {
        if (!this.selBanner) {
            const b = document.createElement('div');
            b.className = 'ttyd-sel-mode-banner';
            document.body.appendChild(b);
            this.selBanner = b;
        }
        this.selBanner.textContent = text;
    }

    private hideSelBanner() {
        this.selBanner?.remove();
        this.selBanner = null;
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        this.zmodemAddon?.sendFile(files);
    }

    @bind
    public async refreshToken() {
        // Persist the credential client-side so an expiring browser Basic-Auth
        // cache (Chrome/Safari drop it after a few hours) doesn't pop a fresh
        // login dialog on the next reconnect. ttyd's /token returns
        // base64("user:pass") — the exact string its check_auth() wants in the
        // Authorization header — so a saved token can be replayed verbatim.
        const CRED_KEY = 'ttyd.cred.v1';
        const stored = localStorage.getItem(CRED_KEY) || '';
        const fetchToken = (cred: string) =>
            fetch(this.options.tokenUrl, cred ? { headers: { Authorization: `Basic ${cred}` } } : undefined);
        try {
            let resp = await fetchToken(stored);
            // Saved credential rejected (e.g. password rotated server-side):
            // forget it and retry unauthenticated so the browser prompts once
            // to re-capture, restoring the original gating behaviour.
            if (resp.status === 401 && stored) {
                localStorage.removeItem(CRED_KEY);
                resp = await fetchToken('');
            }
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
                // Empty token = server started with --no-auth; nothing to save.
                if (this.token) localStorage.setItem(CRED_KEY, this.token);
                else localStorage.removeItem(CRED_KEY);
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
        }
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        event.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        return undefined;
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, clipboardAddon, webLinksAddon } = this;
        window.term = terminal as TtydTerminal;
        window.term.fit = () => this.safeFit();

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        terminal.loadAddon(clipboardAddon);
        terminal.loadAddon(webLinksAddon);

        terminal.open(parent);
        this.safeFit();

        // Intercept beforeinput on the xterm helper textarea so virtual
        // modifiers (tapped on the vkbd) apply to Android/IME keystrokes
        // typed directly on the terminal. Without this, composition events
        // from on-screen keyboards would bypass attachCustomKeyEventHandler
        // (which only sees keydown).
        try {
            const ta = terminal.element?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
            const coarse = !!window.matchMedia?.('(pointer: coarse)').matches;
            // Android-only: the Gboard char-drop workaround below must not run
            // on iOS. WebKit ignores preventDefault() on `beforeinput` at
            // word-commit boundaries (i.e. the spacebar), so intercepting +
            // re-sending there delivers the char once to the PTY AND lets the
            // textarea mutate — xterm then sends it again, doubling every space.
            const isAndroid = /Android/i.test(navigator.userAgent || '');
            if (ta) {
                ta.addEventListener('beforeinput', (event: InputEvent) => {
                    if (event.inputType !== 'insertText' && event.inputType !== 'insertCompositionText') return;
                    const data = event.data;
                    const hook = window.ttyd?.vkbdHook;
                    const vm = hook?.getMods();
                    const hasMods = !!vm && (vm.ctrl || vm.shift || vm.alt || vm.meta);

                    // (1) Virtual modifiers tapped on the vkbd, applied to
                    // Android/IME keystrokes typed directly on the terminal.
                    if (hook && vm && hasMods) {
                        if (!data) return;
                        event.preventDefault();
                        let bytes = '';
                        for (const ch of data) bytes += bytesForText(ch, vm);
                        this.sendData(bytes);
                        hook.consume();
                        return;
                    }

                    // (2) Android reliability: xterm.js reads typed input from
                    // this hidden textarea via its CompositionHelper, and on
                    // Android (Gboard composes every word even with suggestions
                    // off) fast typing drops characters at composition
                    // boundaries. For COMMITTED, non-composition text deliver it
                    // straight to the PTY and preventDefault so the textarea
                    // never changes — xterm therefore can't double-send.
                    // Composition input (event.isComposing / Vietnamese Telex,
                    // CJK) is left untouched so diacritic/IME composition keeps
                    // working through xterm's normal path. Gated to Android only
                    // because iOS ignores preventDefault here and double-sends.
                    if (isAndroid && event.inputType === 'insertText' && !event.isComposing && data) {
                        event.preventDefault();
                        this.sendData(data);
                    }
                });

                // On coarse-pointer devices (mobile) the OS keyboard pops up
                // whenever this hidden textarea is focused — and xterm focuses
                // it from many non-typing paths: synthesized wheel events from
                // the vkbd scroll keys, reconnect-time focus, the vkbd's own
                // post-action focus, etc. That makes the Android keyboard
                // appear on plain vkbd button taps the user never meant as
                // "start typing". Default the textarea to inputmode="none" (it
                // stays focusable, so xterm keeps receiving key events, but the
                // OS keyboard never shows) and only promote it to
                // inputmode="text" when the user genuinely taps the terminal
                // itself. Reset on blur so the next programmatic focus stays
                // silent. The blur() defenses in the vkbd remain as backup.
                if (coarse) {
                    ta.inputMode = 'none';
                    terminal.element?.addEventListener(
                        'pointerdown',
                        (event: Event) => {
                            if (event.isTrusted) ta.inputMode = 'text';
                        },
                        true
                    );
                    ta.addEventListener('blur', () => {
                        ta.inputMode = 'none';
                    });
                }
            }
        } catch {
            // ignore
        }

        terminal.attachCustomKeyEventHandler((event: KeyboardEvent) => {
            if (event.type !== 'keydown') return true;

            // Mac Cmd+C or cross-platform Ctrl+Shift+C: copy selection.
            // Called directly in a keydown handler so navigator.clipboard is
            // available under the browser's user-gesture requirement (Safari
            // and Chrome both block clipboard writes outside trusted events).
            const isMacCopy = event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key === 'c';
            const isCtrlShiftCopy =
                event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey && event.key === 'C';
            if (isMacCopy || isCtrlShiftCopy) {
                const sel = terminal.getSelection();
                if (sel) {
                    void this.doCopy(sel)
                        .then(() => this.overlayAddon?.showOverlay('✂', 300))
                        .catch(e => console.warn('[ttyd] copy failed', e));
                    return false;
                }
                // No selection on Mac: suppress Cmd+C so it doesn't emit meta+c escape.
                if (isMacCopy) return false;
                return true;
            }

            const hook = window.ttyd?.vkbdHook;
            if (!hook) return true;
            const vm = hook.getMods();
            if (!vm.ctrl && !vm.shift && !vm.alt && !vm.meta) return true;
            const combined = {
                ctrl: vm.ctrl || event.ctrlKey,
                shift: vm.shift || event.shiftKey,
                alt: vm.alt || event.altKey,
                meta: vm.meta || event.metaKey,
            };
            const bytes = bytesForKeyEvent(event, combined);
            if (bytes === null) return true;
            event.preventDefault();
            this.sendData(bytes);
            hook.consume();
            return false;
        });

        const getViewport = (): HTMLElement | null =>
            (terminal.element?.querySelector('.xterm-viewport') as HTMLElement | null) ?? null;
        const getRowHeight = (): number => {
            const vp = getViewport();
            if (!vp || terminal.rows <= 0) return 20;
            return vp.clientHeight / terminal.rows;
        };
        const dispatchWheel = (deltaY: number) => {
            const el = terminal.element;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            el.dispatchEvent(
                new WheelEvent('wheel', {
                    deltaY,
                    deltaMode: 0,
                    clientX: rect.left + rect.width / 2,
                    clientY: rect.top + rect.height / 2,
                    bubbles: true,
                    cancelable: true,
                })
            );
        };

        const prevHook = window.ttyd?.vkbdHook;
        window.ttyd = {
            sendBytes: data => this.sendData(data),
            scrollLines: n => dispatchWheel(n * getRowHeight()),
            scrollPages: n => {
                const vp = getViewport();
                const h = vp ? vp.clientHeight : getRowHeight() * terminal.rows;
                dispatchWheel(n * h);
            },
            scrollToBottom: () => {
                const vp = getViewport();
                if (vp) vp.scrollTop = vp.scrollHeight;
                else terminal.scrollToBottom();
            },
            paste: async () => {
                try {
                    const txt = await navigator.clipboard.readText();
                    if (txt) this.sendData(txt);
                } catch (e) {
                    console.warn('[ttyd] paste failed', e);
                }
            },
            copySelection: async () => {
                // Use last known selection so copy still works if terminal
                // output arrived after the selection was made.
                const sel = terminal.getSelection() || this.lastSel;
                if (!sel) return;
                try {
                    await this.doCopy(sel);
                    this.overlayAddon?.showOverlay('✂', 300);
                } catch (e) {
                    console.warn('[ttyd] copy failed', e);
                }
            },
            setSelectMode: on => this.setSelectMode(on),
            focus: () => terminal.focus(),
            vkbdHook: prevHook,
        };

        this.setupAutoReconnect();
    }

    // Auto-reconnect when the page becomes visible again. On mobile
    // (iOS/Android) backgrounding the browser or locking the screen freezes
    // the page and tears down the WebSocket — often with an `error` event
    // first, which clears doReconnect, so the normal close path lands on the
    // "Press ⏎ to Reconnect" prompt that's awkward to trigger on a phone.
    // Listening for visibility/focus/pageshow/online lets us reconnect the
    // moment the user returns to the tab, with no keypress needed. Registered
    // once and intentionally kept for the page lifetime — it must survive the
    // per-socket dispose() that runs on every reconnect.
    @bind
    private setupAutoReconnect() {
        if (this.autoReconnectSetup) return;
        this.autoReconnectSetup = true;

        const resume = () => {
            if (document.visibilityState !== 'visible') return;
            if (!this.opened) return;
            // Respect explicit opt-outs.
            if (!this.reconnect || this.closeOnDisconnect) return;
            // A reconnect is already in flight, or the socket is still healthy.
            if (this.reconnecting) return;
            const rs = this.socket?.readyState;
            if (rs === WebSocket.OPEN || rs === WebSocket.CONNECTING) return;
            console.log('[ttyd] page visible, socket not open — auto-reconnecting');
            this.startReconnect();
        };

        this.resumeDisposables.push(
            addEventListener(document, 'visibilitychange', resume),
            addEventListener(window, 'pageshow', resume),
            addEventListener(window, 'focus', resume),
            addEventListener(window, 'online', resume)
        );
    }

    @bind
    private startReconnect() {
        this.reconnecting = true;
        this.doReconnect = true;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;
        this.overlayAddon.showOverlay('Reconnecting...');
        this.dispose();
        this.refreshToken().then(this.connect);
    }

    @bind
    private initListeners() {
        const { terminal, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                if (data && data !== '' && !this.titleFixed) {
                    document.title = data + ' | ' + this.title;
                }
            })
        );
        register(terminal.onData(data => sendData(data)));
        register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            })
        );
        register(
            terminal.onSelectionChange(() => {
                const sel = this.terminal.getSelection();
                if (!sel) {
                    this.lastSel = '';
                    this.hideSelTip();
                    return;
                }
                this.lastSel = sel;
                const lines = sel.split('\n').length;
                this.overlayAddon?.showOverlay(`${sel.length}c/${lines}L \u2702`, 1200);
                this.showSelTip(sel);
            })
        );
        register(addEventListener(window, 'resize', () => this.safeFit()));
        register(addEventListener(window, 'beforeunload', this.onWindowUnload));
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                if (this.pending < lowWater) {
                    this.socket?.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater) {
                this.socket?.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public sendData(data: string | Uint8Array) {
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    @bind
    public connect() {
        this.socket = new WebSocket(this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        register(addEventListener(socket, 'open', this.onSocketOpen));
        register(addEventListener(socket, 'message', this.onSocketData as EventListener));
        register(addEventListener(socket, 'close', this.onSocketClose as EventListener));
        register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        this.reconnecting = false;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;

        const { textEncoder, terminal, overlayAddon } = this;
        const msg = JSON.stringify({ AuthToken: this.token, columns: terminal.cols, rows: terminal.rows });
        this.socket?.send(textEncoder.encode(msg));

        if (this.opened) {
            terminal.reset();
            terminal.options.disableStdin = false;
            overlayAddon.showOverlay('Reconnected', 300);
        } else {
            this.opened = true;
        }

        this.doReconnect = this.reconnect;
        this.initListeners();
        // On coarse-pointer devices (mobile), focusing the helper textarea
        // pops up the OS keyboard. Reconnects happen often on flaky mobile
        // networks, so don't auto-focus there — the user can tap the
        // terminal to bring up the keyboard when they actually want it.
        const coarse = window.matchMedia?.('(pointer: coarse)').matches;
        if (!coarse) terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const { overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.reconnecting = false;
        this.pendingReconnectKey?.dispose();
        this.pendingReconnectKey = undefined;
        this.dispose();

        // 1000: CLOSE_NORMAL
        if (event.code !== 1000 && this.doReconnect) {
            this.startReconnect();
        } else if (this.closeOnDisconnect) {
            window.close();
        } else {
            // No auto-reconnect (normal close, or doReconnect was cleared by a
            // socket error). Offer a manual reconnect on Enter, but leave
            // `reconnecting` false so the visibility handler can still take over
            // when the user returns to a backgrounded mobile tab.
            const { terminal } = this;
            this.pendingReconnectKey = terminal.onKey(e => {
                if (e.domEvent.key === 'Enter') this.startReconnect();
            });
            overlayAddon.showOverlay('Press ⏎ to Reconnect');
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const { terminal } = this;
        const { clientOptions } = this.options;
        const prefs = {} as Preferences;
        const queryObj = Array.from(new URLSearchParams(query) as unknown as Iterable<[string, string]>);

        for (const [k, queryVal] of queryObj) {
            let v = clientOptions[k];
            if (v === undefined) v = terminal.options[k];
            switch (typeof v) {
                case 'boolean':
                    prefs[k] = queryVal === 'true' || queryVal === '1';
                    break;
                case 'number':
                case 'bigint':
                    prefs[k] = Number.parseInt(queryVal, 10);
                    break;
                case 'string':
                    prefs[k] = queryVal;
                    break;
                case 'object':
                    prefs[k] = JSON.parse(queryVal);
                    break;
                default:
                    console.warn(`[ttyd] maybe unknown option: ${k}=${queryVal}, treating as string`);
                    prefs[k] = queryVal;
                    break;
            }
        }

        return prefs;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
                this.writeFunc(data);
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                document.title = this.title;
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, register } = this;
        if (prefs.enableZmodem || prefs.enableTrzsz) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data => this.zmodemAddon?.consume(data);
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of Object.entries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        window.removeEventListener('beforeunload', this.onWindowUnload);
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        terminal.loadAddon(register(new ImageAddon()));
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'closeOnDisconnect':
                    if (value) {
                        console.log('[ttyd] close on disconnect enabled (Reconnect disabled)');
                        this.closeOnDisconnect = true;
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'titleFixed':
                    if (!value || value === '') return;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    document.title = value;
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    if (key === 'fontSize') {
                        const vkbd = loadVkbdSettings();
                        if (vkbd.termFontSize) {
                            console.log(`[ttyd] skipping server fontSize=${value}, user override=${vkbd.termFontSize}`);
                            break;
                        }
                    }
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) this.safeFit();
                    break;
            }
        }
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeCanvasRenderer = () => {
            try {
                this.canvasAddon?.dispose();
            } catch {
                // ignore
            }
            this.canvasAddon = undefined;
        };
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableCanvasRenderer = () => {
            if (this.canvasAddon) return;
            this.canvasAddon = new CanvasAddon();
            disposeWebglRenderer();
            try {
                this.terminal.loadAddon(this.canvasAddon);
                console.log('[ttyd] canvas renderer loaded');
            } catch (e) {
                console.log('[ttyd] canvas renderer could not be loaded, falling back to dom renderer', e);
                disposeCanvasRenderer();
            }
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            disposeCanvasRenderer();
            try {
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon?.dispose();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to canvas renderer', e);
                disposeWebglRenderer();
                enableCanvasRenderer();
            }
        };

        switch (value) {
            case 'canvas':
                enableCanvasRenderer();
                break;
            case 'webgl':
                enableWebglRenderer();
                break;
            case 'dom':
                disposeWebglRenderer();
                disposeCanvasRenderer();
                console.log('[ttyd] dom renderer loaded');
                break;
            default:
                break;
        }
    }
}
