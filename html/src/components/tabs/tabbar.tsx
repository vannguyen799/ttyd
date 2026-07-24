import { h, Component, JSX } from 'preact';
import { clampColWidth } from './model';
import type { BarMode, BarPosition, TabInfo } from './model';

interface Props {
    tabs: TabInfo[];
    activeId: string;
    liveIds: string[]; // tabs with a live connection; others are asleep
    position: BarPosition;
    menuMode: boolean;
    scale: number;
    colWidth: number; // column width (px) in left/right mode
    onSelect: (id: string) => void;
    onClose: (id: string) => void;
    onAdd: () => void;
    onSetMode: (mode: BarMode) => void;
    onSetScale: (scale: number) => void;
    onSetColWidth: (width: number) => void;
    onReorder: (fromId: string, targetId: string) => void;
    onRename: (id: string, title: string) => void;
}

interface State {
    menuOpen: boolean; // popover list open (menu mode)
    posOpen: boolean; // position/options popover open
    dragId: string | null; // chip currently being dragged (for styling)
    editingId: string | null; // chip being renamed inline
    editValue: string; // in-progress rename text
    resizing: boolean; // column width drag in progress (left/right mode)
}

// Pointer travel (px) before a press on a chip becomes a drag rather than a tap.
const DRAG_THRESHOLD = 6;

// The five exclusive bar layouts, shown as one mode picker.
const MODES: { mode: BarMode; icon: string; label: string }[] = [
    { mode: 'top', icon: '▔', label: 'Top' },
    { mode: 'bottom', icon: '▁', label: 'Bottom' },
    { mode: 'left', icon: '▏', label: 'Left' },
    { mode: 'right', icon: '▕', label: 'Right' },
    { mode: 'menu', icon: '☰', label: 'Menu' },
];

// Chrome-like tab strip. Positionable on any edge (Edge-style vertical tabs on
// left/right), plus a collapsed "menu" mode where a single ☰ button toggles a
// dropdown list of tabs.
export class TabBar extends Component<Props, State> {
    state: State = { menuOpen: false, posOpen: false, dragId: null, editingId: null, editValue: '', resizing: false };

    componentDidMount() {
        document.addEventListener('pointerdown', this.onDocDown, true);
    }
    componentWillUnmount() {
        document.removeEventListener('pointerdown', this.onDocDown, true);
    }

    componentDidUpdate(_prev: Props, prevState: State) {
        // Focus + select the rename box the moment it appears.
        if (this.state.editingId && this.state.editingId !== prevState.editingId && this.renameEl) {
            this.renameEl.focus();
            this.renameEl.select();
        }
    }

    private rootEl: HTMLElement | null = null;
    private renameEl: HTMLInputElement | null = null;

    // Pointer-drag reorder state. `active` flips once the press passes the
    // threshold; until then the press is still a potential tap (select).
    private drag: { pointerId: number; id: string; startX: number; startY: number; active: boolean } | null = null;
    // After a drag, the trailing click on the same chip must not select it.
    private suppressClickId: string | null = null;

    // Column-width resize (left/right mode). Dragging the inner edge of the
    // vertical column widens/narrows it. `scale` (bar zoom) maps real pointer
    // pixels back to CSS width; `right` mode drags the opposite direction.
    private resize: { pointerId: number; startX: number; startWidth: number } | null = null;

    private onResizeDown = (e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();
        this.resize = { pointerId: e.pointerId, startX: e.clientX, startWidth: this.props.colWidth };
        this.setState({ resizing: true });
        try {
            (e.currentTarget as Element).setPointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };

    private onResizeMove = (e: PointerEvent) => {
        const r = this.resize;
        if (!r || r.pointerId !== e.pointerId) return;
        const dir = this.props.position === 'right' ? -1 : 1;
        const dx = (dir * (e.clientX - r.startX)) / (this.props.scale || 1);
        this.props.onSetColWidth(clampColWidth(r.startWidth + dx));
    };

    private onResizeUp = (e: PointerEvent) => {
        if (!this.resize || this.resize.pointerId !== e.pointerId) return;
        this.resize = null;
        this.setState({ resizing: false });
        try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
    };

    private onChipPointerDown = (id: string, e: PointerEvent) => {
        if (this.state.editingId) return; // no dragging while renaming
        if ((e.target as Element)?.closest?.('.tab-close')) return; // let close fire
        this.drag = { pointerId: e.pointerId, id, startX: e.clientX, startY: e.clientY, active: false };
    };

    private onChipPointerMove = (e: PointerEvent) => {
        const d = this.drag;
        if (!d || d.pointerId !== e.pointerId) return;
        if (!d.active) {
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
            d.active = true;
            this.setState({ dragId: d.id });
            try {
                (e.currentTarget as Element).setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        }
        // The chip under the pointer becomes the drop target; reorder live.
        const under = document.elementFromPoint(e.clientX, e.clientY) as Element | null;
        const chip = under?.closest?.('.tab-chip') as HTMLElement | null;
        const targetId = chip?.dataset?.tabId;
        if (targetId && targetId !== d.id) this.props.onReorder(d.id, targetId);
    };

    private onChipPointerUp = (e: PointerEvent) => {
        const d = this.drag;
        if (!d || d.pointerId !== e.pointerId) return;
        this.drag = null;
        try {
            (e.currentTarget as Element).releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        if (d.active) {
            this.suppressClickId = d.id; // swallow the click that follows the drag
            this.setState({ dragId: null });
        }
    };

    private onChipClick = (id: string, inMenu: boolean) => {
        if (this.suppressClickId === id) {
            this.suppressClickId = null;
            return;
        }
        this.props.onSelect(id);
        if (inMenu) this.setState({ menuOpen: false });
    };

    private startRename = (t: TabInfo) => {
        this.drag = null;
        this.setState({ editingId: t.id, editValue: t.title || t.session });
    };

    private commitRename = (id: string) => {
        if (this.state.editingId !== id) return;
        this.props.onRename(id, this.state.editValue);
        this.setState({ editingId: null, editValue: '' });
    };

    private onRenameKey = (id: string, e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            this.commitRename(id);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            this.setState({ editingId: null, editValue: '' });
        }
    };

    private onDocDown = (e: PointerEvent) => {
        if (!this.rootEl) return;
        if (!this.rootEl.contains(e.target as Node)) {
            if (this.state.menuOpen || this.state.posOpen) this.setState({ menuOpen: false, posOpen: false });
        }
    };

    private closePopovers = () => this.setState({ menuOpen: false, posOpen: false });

    // The 5-mode picker (Top/Bottom/Left/Right/Menu) as one exclusive choice.
    // Shared between the strip's ⋯ popover and the menu-mode list popover (where
    // it's folded in so the collapsed UI stays a single button). `onDone` closes
    // whichever popover hosts it.
    private renderModeControls(onDone: () => void) {
        const { position, menuMode, onSetMode } = this.props;
        const current: BarMode = menuMode ? 'menu' : position;
        return (
            <div class="tabbar-mode-controls">
                <div class="tabbar-pop-title">Bar layout</div>
                <div class="tabbar-mode-grid">
                    {MODES.map(m => (
                        <button
                            key={m.mode}
                            class={`tabbar-mode-btn${current === m.mode ? ' active' : ''}`}
                            title={m.label}
                            onClick={() => {
                                onSetMode(m.mode);
                                onDone();
                            }}
                        >
                            <span class="tabbar-mode-icon">{m.icon}</span>
                            {m.label}
                        </button>
                    ))}
                </div>
                {this.renderScaleControl()}
            </div>
        );
    }

    // Proportional zoom of the whole bar. Kept next to the layout picker since
    // both shape the bar's footprint. 60%–160%, snapped to a clean 100% default.
    private renderScaleControl() {
        const { scale, onSetScale } = this.props;
        return (
            <div class="tabbar-scale-control">
                <div class="tabbar-pop-title">
                    Bar size
                    <span class="tabbar-scale-val">{Math.round(scale * 100)}%</span>
                    {scale !== 1 ? (
                        <button class="tabbar-scale-reset" onClick={() => onSetScale(1)}>
                            reset
                        </button>
                    ) : null}
                </div>
                <input
                    type="range"
                    class="tabbar-scale-range"
                    min="0.6"
                    max="1.6"
                    step="0.05"
                    value={scale}
                    onInput={e => onSetScale(parseFloat((e.target as HTMLInputElement).value))}
                />
            </div>
        );
    }

    private renderPosMenu() {
        return (
            <div class="tabbar-pop tabbar-pop-pos" onPointerDown={e => e.stopPropagation()}>
                {this.renderModeControls(() => this.setState({ posOpen: false }))}
            </div>
        );
    }

    private renderChip(t: TabInfo, inMenu: boolean) {
        const { activeId, liveIds, onClose, tabs } = this.props;
        const active = t.id === activeId;
        const asleep = !liveIds.includes(t.id);
        const canClose = tabs.length > 1;
        const dragging = this.state.dragId === t.id;
        const editing = this.state.editingId === t.id;
        return (
            <div
                key={t.id}
                data-tab-id={t.id}
                class={`tab-chip${active ? ' active' : ''}${inMenu ? ' in-menu' : ''}${asleep ? ' sleeping' : ''}${
                    dragging ? ' dragging' : ''
                }`}
                title={
                    editing
                        ? undefined
                        : asleep
                        ? `${t.session} — sleeping (click to reconnect)`
                        : `${t.session} — double-click to rename`
                }
                onClick={() => this.onChipClick(t.id, inMenu)}
                onDblClick={() => this.startRename(t)}
                onPointerDown={e => this.onChipPointerDown(t.id, e)}
                onPointerMove={this.onChipPointerMove}
                onPointerUp={this.onChipPointerUp}
                onPointerCancel={this.onChipPointerUp}
            >
                <span class="tab-dot" aria-hidden="true" />
                {editing ? (
                    <input
                        class="tab-rename"
                        ref={el => (this.renameEl = el)}
                        value={this.state.editValue}
                        autocomplete="off"
                        spellcheck={false}
                        onInput={e => this.setState({ editValue: (e.target as HTMLInputElement).value })}
                        onKeyDown={e => this.onRenameKey(t.id, e)}
                        onBlur={() => this.commitRename(t.id)}
                        onClick={e => e.stopPropagation()}
                        onDblClick={e => e.stopPropagation()}
                        onPointerDown={e => e.stopPropagation()}
                    />
                ) : (
                    <span class="tab-title">{t.title || t.session}</span>
                )}
                {canClose && !editing ? (
                    <button
                        class="tab-close"
                        aria-label="Close tab"
                        title="Close tab"
                        onClick={e => {
                            e.stopPropagation();
                            onClose(t.id);
                        }}
                    >
                        ✕
                    </button>
                ) : null}
            </div>
        );
    }

    private optionsButton() {
        return (
            <button
                class="tabbar-btn tabbar-opts"
                title="Bar position & menu mode"
                aria-label="Bar options"
                onClick={e => {
                    e.stopPropagation();
                    this.setState(s => ({ posOpen: !s.posOpen, menuOpen: false }));
                }}
            >
                ⋯
            </button>
        );
    }

    private addButton() {
        return (
            <button class="tabbar-btn tabbar-add" title="New tab" aria-label="New tab" onClick={this.props.onAdd}>
                ＋
            </button>
        );
    }

    // Drag strip on the column's inner edge (left mode → right edge, right mode
    // → left edge) for resizing the column width. Only rendered in left/right.
    private resizeHandle() {
        return (
            <div
                class={`tabbar-resize${this.state.resizing ? ' resizing' : ''}`}
                title="Drag to resize"
                aria-label="Resize tab column"
                onPointerDown={this.onResizeDown}
                onPointerMove={this.onResizeMove}
                onPointerUp={this.onResizeUp}
                onPointerCancel={this.onResizeUp}
            />
        );
    }

    render() {
        const { tabs, activeId, position, menuMode, scale, colWidth } = this.props;
        const { menuOpen, posOpen } = this.state;
        const active = tabs.find(t => t.id === activeId);
        const isColumn = position === 'left' || position === 'right';
        // Real layout zoom (not transform) so the reflowed bar reserves the
        // right amount of space in the app's flex column; plus the resizable
        // column width in left/right mode. An empty object leaves both unset.
        const rootStyle: JSX.CSSProperties = {};
        if (scale !== 1) rootStyle.zoom = scale;
        if (!menuMode && isColumn) rootStyle.width = `${colWidth}px`;
        const styleProp = Object.keys(rootStyle).length ? rootStyle : undefined;

        if (menuMode) {
            // Collapsed: a single floating ☰ button (overlay, like the vkbd
            // icon) toggles the tab list. Click the button again, the ✕ in the
            // list header, or outside — all hide it. Options (bar position,
            // menu-mode toggle) live inside the list so the chrome stays one
            // button. Anchored top-left; the vkbd icon sits bottom-right.
            return (
                <div
                    class="tabbar tabbar-menu"
                    style={styleProp}
                    ref={el => (this.rootEl = el)}
                    onPointerDown={e => e.stopPropagation()}
                >
                    <button
                        class={`tabbar-fab${menuOpen ? ' active' : ''}`}
                        title="Tabs"
                        aria-label="Tabs menu"
                        onClick={e => {
                            e.stopPropagation();
                            this.setState(s => ({ menuOpen: !s.menuOpen, posOpen: false }));
                        }}
                    >
                        <span class="tabbar-fab-icon">☰</span>
                        {tabs.length > 1 ? <span class="tabbar-fab-count">{tabs.length}</span> : null}
                    </button>
                    {menuOpen ? (
                        <div class="tabbar-pop tabbar-pop-list" onPointerDown={e => e.stopPropagation()}>
                            <div class="tabbar-pop-head">
                                <span class="tabbar-pop-title">{active?.title || active?.session || 'Tabs'}</span>
                                <button
                                    class="tabbar-pop-close"
                                    aria-label="Close"
                                    title="Close"
                                    onClick={this.closePopovers}
                                >
                                    ✕
                                </button>
                            </div>
                            {tabs.map(t => this.renderChip(t, true))}
                            <button
                                class="tabbar-pop-row tabbar-pop-add"
                                onClick={() => {
                                    this.props.onAdd();
                                    this.setState({ menuOpen: false });
                                }}
                            >
                                ＋ New tab
                            </button>
                            <div class="tabbar-pop-opts">{this.renderModeControls(this.closePopovers)}</div>
                        </div>
                    ) : null}
                </div>
            );
        }

        return (
            <div
                class={`tabbar tabbar-strip tabbar-${position}`}
                style={styleProp}
                ref={el => (this.rootEl = el)}
                onPointerDown={e => e.stopPropagation()}
            >
                <div class="tabbar-tabs">{tabs.map(t => this.renderChip(t, false))}</div>
                {this.addButton()}
                <div class="tabbar-spacer" />
                {this.optionsButton()}
                {isColumn ? this.resizeHandle() : null}
                {posOpen ? this.renderPosMenu() : null}
            </div>
        );
    }
}
