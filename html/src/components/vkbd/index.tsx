import { h, Component, JSX } from 'preact';
import { ROWS } from './keys';
import { bytesForText, dispatch, emptyMods, ModState } from './actions';
import { loadSettings, saveSettings, resetLayout, keyId, loadInputDraft, saveInputDraft, Settings } from './storage';
import { SettingsPanel } from './settings';
import type { KeyDef, ModKey } from './types';

interface State {
    mods: ModState;
    locked: { [K in ModKey]: boolean };
    settings: Settings;
    settingsOpen: boolean;
}

const MIN_WIDTH = 260;
const MIN_KEY_H = 28;
const MAX_KEY_H = 72;
const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 10;

export class VirtualKeyboard extends Component<Record<string, never>, State> {
    private hostEl: HTMLDivElement | null = null;
    private dragState: {
        pointerId: number;
        startX: number;
        startY: number;
        baseX: number;
        baseY: number;
    } | null = null;
    private resizeState: {
        pointerId: number;
        startX: number;
        startY: number;
        baseW: number;
        baseH: number;
    } | null = null;
    private modDown: {
        pointerId: number;
        target: Element;
        startX: number;
        startY: number;
        mod: ModKey;
        timer: number;
        fired: boolean;
    } | null = null;
    private scrollHold: {
        pointerId: number;
        target: Element;
        def: KeyDef;
        delayTimer: number;
        intervalTimer: number;
    } | null = null;
    private suppressNextClick = false;

    constructor() {
        super();
        this.state = {
            mods: emptyMods(),
            locked: { ctrl: false, shift: false, alt: false, meta: false },
            settings: loadSettings(),
            settingsOpen: false,
        };
    }

    private resizeObs?: ResizeObserver;

    componentDidMount() {
        window.addEventListener('resize', this.clampPosition);
        this.tryRegisterHook();
        this.syncDockedLayout();
        this.applyTermFontSize();
        if (typeof ResizeObserver !== 'undefined' && this.hostEl) {
            this.resizeObs = new ResizeObserver(() => this.syncDockedLayout());
            this.resizeObs.observe(this.hostEl);
        }
    }

    componentDidUpdate() {
        this.syncDockedLayout();
        this.applyTermFontSize();
    }

    private applyTermFontSize = () => {
        const fs = this.state.settings.termFontSize;
        if (!fs) return;
        const tryApply = () => {
            const term = (window as unknown as { term?: { options?: { fontSize?: number }; fit?: () => void } }).term;
            if (!term || !term.options) {
                window.setTimeout(tryApply, 100);
                return;
            }
            if (term.options.fontSize === fs) return;
            term.options.fontSize = fs;
            try {
                term.fit?.();
            } catch {
                // ignore
            }
        };
        tryApply();
    };

    componentWillUnmount() {
        window.removeEventListener('resize', this.clampPosition);
        if (window.ttyd) window.ttyd.vkbdHook = undefined;
        this.resizeObs?.disconnect();
        document.body.classList.remove('vkbd-docked-bottom', 'vkbd-docked-top');
        document.documentElement.style.removeProperty('--vkbd-dock-height');
    }

    private syncDockedLayout = () => {
        const { settings } = this.state;
        const docked = !settings.pos && settings.visible;
        const dockBottom = docked && settings.position !== 'top';
        const dockTop = docked && settings.position === 'top';
        document.body.classList.toggle('vkbd-docked-bottom', dockBottom);
        document.body.classList.toggle('vkbd-docked-top', dockTop);
        if (docked && this.hostEl) {
            const h = this.hostEl.getBoundingClientRect().height;
            document.documentElement.style.setProperty('--vkbd-dock-height', h + 'px');
        } else {
            document.documentElement.style.removeProperty('--vkbd-dock-height');
        }
        this.tryFit();
    };

    private tryFit = (attempts = 0) => {
        const term = (window as unknown as { term?: { fit?: () => void } }).term;
        if (term && term.fit) {
            requestAnimationFrame(() => {
                try {
                    term.fit!();
                } catch {
                    // ignore
                }
            });
            return;
        }
        if (attempts < 50) {
            window.setTimeout(() => this.tryFit(attempts + 1), 100);
        }
    };

    private tryRegisterHook = () => {
        if (window.ttyd) {
            window.ttyd.vkbdHook = {
                getMods: () => this.state.mods,
                consume: () => this.clearMods(),
            };
        } else {
            window.setTimeout(this.tryRegisterHook, 50);
        }
    };

    private clampPosition = () => {
        const { settings } = this.state;
        if (!settings.pos || !this.hostEl) return;
        const rect = this.hostEl.getBoundingClientRect();
        const maxX = Math.max(0, window.innerWidth - rect.width);
        const maxY = Math.max(0, window.innerHeight - rect.height);
        const x = Math.max(0, Math.min(maxX, settings.pos.x));
        const y = Math.max(0, Math.min(maxY, settings.pos.y));
        if (x !== settings.pos.x || y !== settings.pos.y) {
            this.persist({ ...settings, pos: { x, y } });
        }
    };

    private persist(next: Settings) {
        saveSettings(next);
        this.setState({ settings: next });
    }

    private updateState(next: Settings) {
        this.setState({ settings: next });
    }

    private toggleMod = (m: ModKey) => {
        this.setState(s => ({ mods: { ...s.mods, [m]: !s.mods[m] } }));
    };

    private clearMods = () => {
        this.setState(s => ({
            mods: {
                ctrl: s.locked.ctrl,
                shift: s.locked.shift,
                alt: s.locked.alt,
                meta: s.locked.meta,
            },
        }));
    };

    private toggleModLock = (m: ModKey) => {
        this.setState(s => {
            const nextLocked = !s.locked[m];
            return {
                locked: { ...s.locked, [m]: nextLocked },
                mods: { ...s.mods, [m]: nextLocked },
            };
        });
    };

    private hide = () => {
        this.persist({ ...this.state.settings, visible: false });
    };

    private show = () => {
        this.persist({ ...this.state.settings, visible: true });
    };

    private openSettings = () => {
        this.setState({ settingsOpen: true });
    };

    private closeSettings = () => {
        this.setState({ settingsOpen: false });
    };

    private onSettingsChange = (s: Settings) => {
        this.persist(s);
    };

    private inputEl: HTMLTextAreaElement | null = null;

    private onInputKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.sendInput(true);
        }
    };

    private onInputBeforeInput = (e: InputEvent) => {
        if (e.inputType !== 'insertText' && e.inputType !== 'insertCompositionText') return;
        const mods = this.state.mods;
        const any = mods.ctrl || mods.shift || mods.alt || mods.meta;
        if (!any) return;
        const data = e.data;
        if (!data) return;
        e.preventDefault();
        let bytes = '';
        for (const ch of data) {
            bytes += bytesForText(ch, mods);
        }
        window.ttyd?.sendBytes(bytes);
        this.clearMods();
        if (this.inputEl) {
            this.inputEl.value = '';
            this.inputEl.style.height = '';
        }
        saveInputDraft('');
    };

    private sendInput = (withNewline: boolean) => {
        const el = this.inputEl;
        if (!el) return;
        const text = el.value;
        const bytes = withNewline ? text + '\r' : text;
        if (bytes) window.ttyd?.sendBytes(bytes);
        el.value = '';
        el.style.height = '';
        saveInputDraft('');
    };

    private onInputAutoGrow = (e: Event) => {
        const ta = e.target as HTMLTextAreaElement;
        ta.style.height = 'auto';
        const cs = window.getComputedStyle(ta);
        const maxH = parseFloat(cs.maxHeight) || Infinity;
        ta.style.height = Math.min(ta.scrollHeight, maxH) + 'px';
        saveInputDraft(ta.value);
    };

    private restoreInputDraft = (el: HTMLTextAreaElement | null) => {
        this.inputEl = el;
        if (!el) return;
        const draft = loadInputDraft();
        if (draft && !el.value) {
            el.value = draft;
            // trigger auto-grow
            el.dispatchEvent(new Event('input', { bubbles: true }));
        }
    };

    private onKeyClick = (k: KeyDef) => {
        if (this.suppressNextClick) {
            this.suppressNextClick = false;
            return;
        }
        this.fireKey(k);
    };

    private fireKey = (k: KeyDef) => {
        const action = this.resolveAction(k.action);
        const shouldClear = dispatch(action, {
            mods: this.state.mods,
            clearMods: this.clearMods,
            toggleMod: this.toggleMod,
            hideKeyboard: this.hide,
        });
        if (shouldClear) this.clearMods();
        const t = action.type;
        const needsFocus = t === 'send' || t === 'text' || t === 'named' || t === 'paste';
        if (needsFocus) window.ttyd?.focus();
    };

    private resolveAction(a: KeyDef['action']): KeyDef['action'] {
        if (a.type === 'scroll' && a.by === 'line' && a.amount === undefined) {
            return { ...a, amount: this.state.settings.scrollStep };
        }
        return a;
    }

    private onScrollPointerDown = (k: KeyDef, e: PointerEvent) => {
        if (k.action.type !== 'scroll') return;
        const target = e.currentTarget as Element;
        try {
            target.setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        this.suppressNextClick = true;
        this.fireKey(k);
        if (!this.state.settings.autoRepeat) return;
        const delay = this.state.settings.repeatDelayMs;
        const interval = this.state.settings.repeatIntervalMs;
        const hold: NonNullable<typeof this.scrollHold> = {
            pointerId: e.pointerId,
            target,
            def: k,
            delayTimer: 0,
            intervalTimer: 0,
        };
        hold.delayTimer = window.setTimeout(() => {
            hold.intervalTimer = window.setInterval(() => this.fireKey(k), interval);
        }, delay);
        this.scrollHold = hold;
    };

    private onScrollPointerUp = (e: PointerEvent) => {
        const hold = this.scrollHold;
        if (!hold || hold.pointerId !== e.pointerId) return;
        window.clearTimeout(hold.delayTimer);
        window.clearInterval(hold.intervalTimer);
        this.scrollHold = null;
        try {
            hold.target.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };

    private onModPointerDown = (k: KeyDef, e: PointerEvent) => {
        if (k.action.type !== 'mod') return;
        const mod = k.action.mod;
        const target = e.currentTarget as Element;
        try {
            target.setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        const state: NonNullable<typeof this.modDown> = {
            pointerId: e.pointerId,
            target,
            startX: e.clientX,
            startY: e.clientY,
            mod,
            timer: 0,
            fired: false,
        };
        state.timer = window.setTimeout(() => {
            state.fired = true;
            this.toggleModLock(mod);
            if (navigator.vibrate) navigator.vibrate(30);
        }, LONG_PRESS_MS);
        this.modDown = state;
    };

    private onModPointerMove = (e: PointerEvent) => {
        if (!this.modDown || this.modDown.pointerId !== e.pointerId) return;
        const dx = Math.abs(e.clientX - this.modDown.startX);
        const dy = Math.abs(e.clientY - this.modDown.startY);
        if (dx > MOVE_CANCEL_PX || dy > MOVE_CANCEL_PX) {
            window.clearTimeout(this.modDown.timer);
            this.modDown = null;
        }
    };

    private onModPointerUp = (e: PointerEvent) => {
        if (!this.modDown || this.modDown.pointerId !== e.pointerId) return;
        window.clearTimeout(this.modDown.timer);
        const { fired, target } = this.modDown;
        this.modDown = null;
        try {
            target.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        if (fired) this.suppressNextClick = true;
    };

    private onModDblClick = (k: KeyDef) => {
        if (k.action.type !== 'mod') return;
        this.toggleModLock(k.action.mod);
        this.suppressNextClick = true;
    };

    private onDragPointerDown = (e: PointerEvent) => {
        if (!this.hostEl) return;
        const rect = this.hostEl.getBoundingClientRect();
        this.dragState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseX: rect.left,
            baseY: rect.top,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        e.preventDefault();
    };

    private onDragPointerMove = (e: PointerEvent) => {
        if (!this.dragState || this.dragState.pointerId !== e.pointerId || !this.hostEl) return;
        const rect = this.hostEl.getBoundingClientRect();
        const dx = e.clientX - this.dragState.startX;
        const dy = e.clientY - this.dragState.startY;
        const x = Math.max(0, Math.min(window.innerWidth - rect.width, this.dragState.baseX + dx));
        const y = Math.max(0, Math.min(window.innerHeight - rect.height, this.dragState.baseY + dy));
        this.updateState({ ...this.state.settings, pos: { x, y } });
    };

    private onDragPointerUp = (e: PointerEvent) => {
        if (!this.dragState || this.dragState.pointerId !== e.pointerId) return;
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        this.dragState = null;
        this.persist(this.state.settings);
    };

    private onDragDoubleClick = () => {
        this.persist({ ...this.state.settings, pos: null });
    };

    private onResizePointerDown = (e: PointerEvent) => {
        if (!this.hostEl) return;
        const rect = this.hostEl.getBoundingClientRect();
        const rows = this.countRows();
        const currentKeyH = this.state.settings.keyHeight ?? 38;
        this.resizeState = {
            pointerId: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            baseW: rect.width,
            baseH: currentKeyH + 0 * rows,
        };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    };

    private onResizePointerMove = (e: PointerEvent) => {
        if (!this.resizeState || this.resizeState.pointerId !== e.pointerId) return;
        const dx = e.clientX - this.resizeState.startX;
        const dy = e.clientY - this.resizeState.startY;
        const w = Math.max(MIN_WIDTH, Math.min(window.innerWidth, this.resizeState.baseW + dx));
        const rows = this.countRows();
        const addPerRow = rows > 0 ? dy / rows : dy;
        const kh = Math.max(MIN_KEY_H, Math.min(MAX_KEY_H, Math.round(this.resizeState.baseH + addPerRow)));
        this.updateState({ ...this.state.settings, width: w, keyHeight: kh });
    };

    private onResizePointerUp = (e: PointerEvent) => {
        if (!this.resizeState || this.resizeState.pointerId !== e.pointerId) return;
        (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        this.resizeState = null;
        this.persist(this.state.settings);
    };

    private onResizeDoubleClick = () => {
        this.persist({ ...this.state.settings, width: null, keyHeight: null });
    };

    private onResetLayout = () => {
        this.persist(resetLayout(this.state.settings));
    };

    private onFitScreen = () => {
        this.persist({
            ...this.state.settings,
            pos: null,
            width: null,
            keyHeight: null,
        });
    };

    private renderModsIndicator() {
        const { mods, locked } = this.state;
        const active: string[] = [];
        if (mods.ctrl) active.push(locked.ctrl ? '⎈*' : '⎈');
        if (mods.shift) active.push(locked.shift ? '⇧*' : '⇧');
        if (mods.alt) active.push(locked.alt ? '⌥*' : '⌥');
        if (mods.meta) active.push(locked.meta ? '◆*' : '◆');
        if (active.length === 0) return null;
        return (
            <div class="vkbd-mods-badge" title="Active modifiers (tap a key to combine)">
                {active.join('+')}
            </div>
        );
    }

    private isActive(k: KeyDef): boolean {
        if (k.action.type !== 'mod') return false;
        return this.state.mods[k.action.mod];
    }

    private isLocked(k: KeyDef): boolean {
        if (k.action.type !== 'mod') return false;
        return this.state.locked[k.action.mod];
    }

    private countRows(): number {
        return this.buildRows().length;
    }

    private buildRows(): { id: string; def: KeyDef }[][] {
        const disabled = new Set(this.state.settings.disabledIds);
        const rows: { id: string; def: KeyDef }[][] = [];
        ROWS.forEach((row, ri) => {
            const filtered = row.keys
                .map((k, ki) => ({ id: keyId(ri, ki, k), def: k }))
                .filter(x => !disabled.has(x.id));
            if (filtered.length) rows.push(filtered);
        });
        const custom = this.state.settings.custom.map(k => ({ id: k.id, def: k }));
        if (custom.length) rows.push(custom);
        return rows;
    }

    render() {
        const { settings, settingsOpen } = this.state;
        const free = !!settings.pos;
        const hostClass = [
            'vkbd-host',
            free ? 'pos-free' : settings.position === 'top' ? 'pos-top' : 'pos-bottom',
        ].join(' ');
        const hostStyle: JSX.CSSProperties = {};
        if (settings.pos) {
            hostStyle.left = settings.pos.x + 'px';
            hostStyle.top = settings.pos.y + 'px';
            hostStyle.right = 'auto';
            hostStyle.bottom = 'auto';
            hostStyle.width = 'auto';
        }
        const kbdStyle: JSX.CSSProperties = {
            background: `rgba(20,20,20,${settings.opacity})`,
        };
        if (settings.width) kbdStyle.width = settings.width + 'px';
        const keyStyleBase: JSX.CSSProperties = {};
        if (settings.keyHeight) keyStyleBase.minHeight = settings.keyHeight + 'px';

        return (
            <div class={hostClass} style={hostStyle} ref={el => (this.hostEl = el)}>
                {!settings.visible ? (
                    <button class="vkbd-fab" onClick={this.show} aria-label="Show keyboard">
                        ⌨
                    </button>
                ) : (
                    <div class="vkbd" style={kbdStyle} onContextMenu={e => e.preventDefault()}>
                        <div class="vkbd-toolbar">
                            <button class="vkbd-icon-btn" onClick={this.openSettings} aria-label="Settings">
                                ⚙
                            </button>
                            <button
                                class="vkbd-icon-btn"
                                onClick={this.onFitScreen}
                                title="Fit to screen (dock, reset size)"
                                aria-label="Fit screen"
                            >
                                ⇲
                            </button>
                            {this.renderModsIndicator()}
                            <div
                                class="vkbd-drag"
                                title="Drag to move · double-click to dock"
                                onPointerDown={this.onDragPointerDown}
                                onPointerMove={this.onDragPointerMove}
                                onPointerUp={this.onDragPointerUp}
                                onPointerCancel={this.onDragPointerUp}
                                onDblClick={this.onDragDoubleClick}
                            >
                                ⋮⋮ drag ⋮⋮
                            </div>
                            <button class="vkbd-icon-btn" onClick={this.hide} aria-label="Hide keyboard">
                                ✕
                            </button>
                        </div>
                        {settings.showInput ? (
                            <div class="vkbd-input-row">
                                <textarea
                                    class="vkbd-input"
                                    ref={this.restoreInputDraft}
                                    placeholder="Type here — Enter to send, Shift+Enter for newline"
                                    autocomplete="off"
                                    autocapitalize="off"
                                    autocorrect="off"
                                    spellcheck={false}
                                    rows={1}
                                    onInput={this.onInputAutoGrow}
                                    onKeyDown={this.onInputKeyDown}
                                    onBeforeInput={this.onInputBeforeInput}
                                />
                                <button
                                    class="vkbd-send-btn"
                                    onClick={() => this.sendInput(false)}
                                    title="Send text only (no Enter)"
                                >
                                    →
                                </button>
                                <button
                                    class="vkbd-send-btn primary"
                                    onClick={() => this.sendInput(true)}
                                    title="Send text + Enter"
                                >
                                    ↵
                                </button>
                            </div>
                        ) : null}
                        {this.buildRows().map((row, ri) => (
                            <div class="vkbd-row" key={ri}>
                                {row.map(({ id, def }) => {
                                    const active = this.isActive(def);
                                    const locked = this.isLocked(def);
                                    const isMod = def.action.type === 'mod';
                                    const isScroll = def.action.type === 'scroll';
                                    const cls = [
                                        'vkbd-key',
                                        def.class || '',
                                        active ? 'active' : '',
                                        locked ? 'locked' : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ');
                                    const style: JSX.CSSProperties = { ...keyStyleBase };
                                    if (def.flex) style.flex = def.flex;
                                    const onPointerDown = isMod
                                        ? (e: PointerEvent) => this.onModPointerDown(def, e)
                                        : isScroll
                                        ? (e: PointerEvent) => this.onScrollPointerDown(def, e)
                                        : undefined;
                                    const onPointerUp = isMod
                                        ? this.onModPointerUp
                                        : isScroll
                                        ? this.onScrollPointerUp
                                        : undefined;
                                    return (
                                        <button
                                            key={id}
                                            class={cls}
                                            style={style}
                                            onClick={() => this.onKeyClick(def)}
                                            onDblClick={isMod ? () => this.onModDblClick(def) : undefined}
                                            onPointerDown={onPointerDown}
                                            onPointerMove={isMod ? this.onModPointerMove : undefined}
                                            onPointerUp={onPointerUp}
                                            onPointerCancel={onPointerUp}
                                            onMouseDown={e => e.preventDefault()}
                                        >
                                            <span class="vkbd-label">{def.label}</span>
                                            {def.sub ? <span class="vkbd-sub">{def.sub}</span> : null}
                                        </button>
                                    );
                                })}
                            </div>
                        ))}
                        <div
                            class="vkbd-resize-corner"
                            title="Drag to resize · double-click to reset"
                            onPointerDown={this.onResizePointerDown}
                            onPointerMove={this.onResizePointerMove}
                            onPointerUp={this.onResizePointerUp}
                            onPointerCancel={this.onResizePointerUp}
                            onDblClick={this.onResizeDoubleClick}
                        />
                    </div>
                )}
                {settingsOpen ? (
                    <div class="vkbd-modal-backdrop" onClick={this.closeSettings}>
                        <SettingsPanel
                            settings={settings}
                            onChange={this.onSettingsChange}
                            onClose={this.closeSettings}
                            onReset={this.onResetLayout}
                        />
                    </div>
                ) : null}
            </div>
        );
    }
}
