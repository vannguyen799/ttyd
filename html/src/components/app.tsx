import { bind } from 'decko';
import { h, Component } from 'preact';

import { Terminal } from './terminal';
import { VirtualKeyboard } from './vkbd';
import { loadSettings } from './vkbd/storage';
import { TabBar } from './tabs/tabbar';
import {
    BarMode,
    TabInfo,
    TabsState,
    backendFromSearch,
    loadTabsState,
    makeTab,
    nextSessionName,
    saveTabsState,
    tabsInView,
} from './tabs/model';

import type { ITerminalOptions, ITheme } from '@xterm/xterm';
import type { ClientOptions, FlowControl } from './terminal/xterm';

const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const path = window.location.pathname.replace(/[/]+$/, '');
const wsUrlFor = (search: string) => [protocol, '//', window.location.host, path, '/ws', search].join('');
const tokenUrl = [window.location.protocol, '//', window.location.host, path, '/token'].join('');
const clipboardUrl = [window.location.protocol, '//', window.location.host, path, '/clipboard-image'].join('');
const isMobile = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
const savedVkbd = loadSettings();
const clientOptions = {
    rendererType: isMobile ? 'dom' : 'webgl',
    // No "Leave site? changes may not be saved" prompt on tab close: the
    // session lives in tmux (start-ttyd.sh) and survives disconnect, so the
    // warning is misleading — closing the tab loses nothing.
    disableLeaveAlert: true,
    disableResizeOverlay: false,
    enableZmodem: false,
    enableTrzsz: false,
    enableSixel: false,
    closeOnDisconnect: false,
    isWindows: false,
    unicodeVersion: '11',
} as ClientOptions;
const termOptions = {
    fontSize: savedVkbd.termFontSize || (isMobile ? 9 : 8),
    fontFamily: 'Consolas,Liberation Mono,Menlo,Courier,monospace',
    theme: {
        foreground: '#d2d2d2',
        background: '#2b2b2b',
        cursor: '#adadad',
        black: '#000000',
        red: '#d81e00',
        green: '#5ea702',
        yellow: '#cfae00',
        blue: '#427ab3',
        magenta: '#89658e',
        cyan: '#00a7aa',
        white: '#dbded8',
        brightBlack: '#686a66',
        brightRed: '#f54235',
        brightGreen: '#99e343',
        brightYellow: '#fdeb61',
        brightBlue: '#84b0d8',
        brightMagenta: '#bc94b7',
        brightCyan: '#37e6e8',
        brightWhite: '#f1f1f0',
    } as ITheme,
    allowProposedApi: true,
} as ITerminalOptions;
const flowControl = {
    limit: 100000,
    highWater: 10,
    lowWater: 4,
} as FlowControl;

declare global {
    interface Window {
        // The active tab's tmux session name / backend, read by the vkbd for
        // per-session input history, drafts and the session-name label. Set by
        // App on every activation so the single vkbd instance follows tabs.
        ttydSession?: string;
        ttydBackend?: 'tmux' | 'screen';
    }
}

// After you switch away from a tab it stays connected ("warm") for this long,
// then goes to sleep — its WebSocket and WebGL context are released. Switching
// back wakes it and reconnects; the tmux session persists on the host the whole
// time, so the screen just redraws with nothing lost.
const SLEEP_MS = 180000;

interface AppState extends TabsState {
    // Tab ids that currently have a live Terminal (the active tab plus any
    // still within their warm window). Ephemeral — never persisted.
    live: string[];
}

export class App extends Component<Record<string, never>, AppState> {
    // Pending sleep timers, keyed by tab id.
    private sleepTimers = new Map<string, number>();

    constructor() {
        super();
        const base = loadTabsState();
        // Only the active tab starts live; the rest wake lazily when visited.
        this.state = { ...base, live: [base.activeId] };
        // Publish before the first render so the vkbd's initial paint already
        // reads the correct active session.
        this.applyActiveGlobals(base);
        this.syncUrlTab(base.activeId);
    }

    componentWillUnmount() {
        for (const h of this.sleepTimers.values()) window.clearTimeout(h);
        this.sleepTimers.clear();
    }

    private activeTab(s: TabsState): TabInfo | undefined {
        return s.tabs.find(t => t.id === s.activeId) ?? s.tabs[0];
    }

    // Publish the active session's identity to the globals the vkbd reads
    // (window.ttydSession/ttydBackend). Called synchronously before every
    // setState so children re-render against the new session, not the old one.
    private applyActiveGlobals(s: TabsState) {
        const t = this.activeTab(s);
        if (!t) return;
        window.ttydSession = t.session;
        window.ttydBackend = backendFromSearch(t.search);
    }

    // Wake a tab: cancel any pending sleep and ensure it has a live Terminal.
    private wake(live: string[], id: string): string[] {
        this.cancelSleep(id);
        return live.includes(id) ? live : [...live, id];
    }

    private cancelSleep(id: string) {
        const h = this.sleepTimers.get(id);
        if (h !== undefined) {
            window.clearTimeout(h);
            this.sleepTimers.delete(id);
        }
    }

    // Arm the sleep timer for a tab that just lost focus. Fires unless the tab is
    // re-activated (or already gone) by the time it elapses.
    private scheduleSleep(id: string) {
        this.cancelSleep(id);
        const h = window.setTimeout(() => {
            this.sleepTimers.delete(id);
            if (this.state.activeId === id) return; // became active again
            if (!this.state.live.includes(id)) return; // already asleep/closed
            this.commit({ ...this.state, live: this.state.live.filter(x => x !== id) });
        }, SLEEP_MS);
        this.sleepTimers.set(id, h);
    }

    private commit(next: AppState) {
        this.applyActiveGlobals(next);
        // Persist only the durable tab data, never the ephemeral live set.
        saveTabsState({ tabs: next.tabs, activeId: next.activeId, bar: next.bar });
        this.syncUrlTab(next.activeId);
        this.setState(next);
    }

    // Mirror the active tab id into the URL hash (#tab=<id>) so a reload lands on
    // it. replaceState (not location.hash =) avoids piling up history entries.
    private syncUrlTab(id: string) {
        try {
            const hash = `#tab=${id}`;
            if (window.location.hash !== hash) {
                window.history.replaceState(window.history.state, '', hash);
            }
        } catch {
            // history unavailable — non-fatal, reload just falls back to storage.
        }
    }

    @bind
    private selectTab(id: string) {
        if (id === this.state.activeId) return;
        const prev = this.state.activeId;
        const live = this.wake(this.state.live, id);
        this.scheduleSleep(prev); // keep the tab we're leaving warm for SLEEP_MS
        this.commit({ ...this.state, activeId: id, live });
    }

    @bind
    private addTab() {
        const prev = this.state.activeId;
        const session = nextSessionName(this.state.tabs);
        // A new tab joins the active tab's namespace so it stays visible under
        // the current "only this session" scope.
        const group = this.activeTab(this.state)?.group;
        const tab = makeTab(session, `?arg=name:${session}`, session, group);
        this.scheduleSleep(prev);
        this.commit({
            ...this.state,
            tabs: [...this.state.tabs, tab],
            activeId: tab.id,
            live: [...this.state.live, tab.id],
        });
    }

    @bind
    private closeTab(id: string) {
        const { tabs, activeId, live } = this.state;
        if (tabs.length <= 1) return; // never close the last tab
        const idx = tabs.findIndex(t => t.id === id);
        const closing = tabs[idx];
        const nextTabs = tabs.filter(t => t.id !== id);
        this.cancelSleep(id);
        let nextLive = live.filter(x => x !== id);
        let nextActive = activeId;
        if (activeId === id) {
            // Focus the neighbour, but prefer one in the same namespace so a
            // scoped view doesn't jump to another session; only when the group is
            // now empty do we fall back to any remaining tab. Nearest-left wins,
            // Chrome-like.
            const sameGroup = nextTabs.filter(t => t.group === closing?.group);
            const pool = sameGroup.length ? sameGroup : nextTabs;
            const before = pool.filter(t => tabs.indexOf(t) < idx);
            nextActive = (before.length ? before[before.length - 1] : pool[0]).id;
            nextLive = this.wake(nextLive, nextActive);
        }
        this.commit({ ...this.state, tabs: nextTabs, activeId: nextActive, live: nextLive });
    }

    @bind
    private onTabTitle(id: string, title: string) {
        const clean = (title || '').trim();
        if (!clean) return;
        const tab = this.state.tabs.find(t => t.id === id);
        if (!tab || tab.title === clean) return;
        if (tab.renamed) return; // a manual rename pins the label; don't clobber it
        this.commit({
            ...this.state,
            tabs: this.state.tabs.map(t => (t.id === id ? { ...t, title: clean } : t)),
        });
    }

    // Drag-to-reorder: move `fromId` into `targetId`'s current slot. Called live
    // as the pointer crosses each chip, so the strip reflows during the drag.
    @bind
    private reorderTabs(fromId: string, targetId: string) {
        if (fromId === targetId) return;
        const tabs = [...this.state.tabs];
        const from = tabs.findIndex(t => t.id === fromId);
        const to = tabs.findIndex(t => t.id === targetId);
        if (from < 0 || to < 0) return;
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        this.commit({ ...this.state, tabs });
    }

    // Double-click rename. An empty name falls back to the session name; setting
    // `renamed` stops terminal title events from overwriting the chosen label.
    @bind
    private renameTab(id: string, title: string) {
        const clean = (title || '').trim();
        this.commit({
            ...this.state,
            tabs: this.state.tabs.map(t => (t.id === id ? { ...t, title: clean || t.session, renamed: true } : t)),
        });
    }

    @bind
    private setBarMode(mode: BarMode) {
        // The five bar layouts are one exclusive choice: picking a strip/column
        // position turns menu mode off; picking "menu" flips to the overlay and
        // keeps the last position (used again if they switch back).
        const menuMode = mode === 'menu';
        const position = menuMode ? this.state.bar.position : mode;
        this.commit({ ...this.state, bar: { ...this.state.bar, position, menuMode } });
    }

    @bind
    private setBarScale(scale: number) {
        this.commit({ ...this.state, bar: { ...this.state.bar, scale } });
    }

    @bind
    private setBarColWidth(colWidth: number) {
        this.commit({ ...this.state, bar: { ...this.state.bar, colWidth } });
    }

    @bind
    private setBarAutoHide(autoHide: boolean) {
        this.commit({ ...this.state, bar: { ...this.state.bar, autoHide } });
        // Toggling this moves the bar in/out of the flex flow, so the stage gains
        // or loses the bar's extent exactly once — refit the terminal to it. (While
        // auto-hide is on the stage no longer changes as the bar slides, so there
        // is nothing to refit per hide/reveal.)
        const term = (window as unknown as { term?: { fit?: () => void } }).term;
        if (term?.fit) {
            requestAnimationFrame(() => {
                try {
                    term.fit!();
                } catch {
                    // ignore — the next resize/activation fits it
                }
            });
        }
    }

    @bind
    private setShowAll(showAllGroups: boolean) {
        this.commit({ ...this.state, bar: { ...this.state.bar, showAllGroups } });
    }

    render() {
        const { tabs, activeId, bar, live } = this.state;
        const active = this.activeTab(this.state);
        const showAll = bar.showAllGroups ?? false;
        // The namespace in view is the active tab's group; scope the strip to it
        // unless "show all sessions" is on.
        const group = active?.group ?? active?.session ?? '';
        const visibleTabs = tabsInView(tabs, group, showAll);
        const rootClass = ['app-root', `bar-${bar.position}`, bar.menuMode ? 'bar-menu' : ''].filter(Boolean).join(' ');
        return (
            <div class={rootClass}>
                <TabBar
                    tabs={visibleTabs}
                    totalTabs={tabs.length}
                    activeId={activeId}
                    liveIds={live}
                    position={bar.position}
                    menuMode={bar.menuMode}
                    scale={bar.scale ?? 1}
                    colWidth={bar.colWidth ?? 190}
                    autoHide={bar.autoHide ?? false}
                    showAllGroups={showAll}
                    groupLabel={group}
                    onSelect={this.selectTab}
                    onClose={this.closeTab}
                    onAdd={this.addTab}
                    onSetMode={this.setBarMode}
                    onSetScale={this.setBarScale}
                    onSetColWidth={this.setBarColWidth}
                    onSetAutoHide={this.setBarAutoHide}
                    onSetShowAll={this.setShowAll}
                    onReorder={this.reorderTabs}
                    onRename={this.renameTab}
                />
                <div class="term-stage">
                    {tabs.map(t => (
                        <div key={t.id} class={`term-pane${t.id === activeId ? ' active' : ''}`}>
                            {/* Sleeping tabs render no Terminal — socket + WebGL
                                released until the tab is activated again. The
                                active tab is always live, so its pane always
                                has a Terminal. */}
                            {live.includes(t.id) ? (
                                <Terminal
                                    id={`terminal-${t.id}`}
                                    active={t.id === activeId}
                                    wsUrl={wsUrlFor(t.search)}
                                    tokenUrl={tokenUrl}
                                    clipboardUrl={clipboardUrl}
                                    clientOptions={clientOptions}
                                    termOptions={termOptions}
                                    flowControl={flowControl}
                                    onTitle={title => this.onTabTitle(t.id, title)}
                                />
                            ) : null}
                        </div>
                    ))}
                </div>
                <VirtualKeyboard sessionName={active?.session} />
            </div>
        );
    }
}
