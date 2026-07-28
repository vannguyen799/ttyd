// Tab model + persistence for the multi-terminal (Chrome-like) UI.
//
// Each tab is an independent terminal wired to its own WebSocket. Session
// identity is the tmux session name carried in the WS query string
// (`?arg=name:<session>`): the ttyd-session.sh wrapper attaches to that tmux
// session, so a distinct name per tab yields a distinct, independent session
// (same name would mirror the same screen). New tabs therefore mint a fresh
// unique name; the first tab keeps whatever the page was opened with so
// deep-links (cwd:/claude/codex/screen routing) still work.
//
// The whole tab list is persisted to localStorage so a reload reconnects to
// exactly the same sessions — matching the tmux-continuum persistence the
// server already runs (the sessions survive on the host regardless).

export type BarPosition = 'top' | 'bottom' | 'left' | 'right';

// The five mutually-exclusive bar layouts the user picks between: the four
// strip/column positions plus the collapsed floating "menu" overlay.
export type BarMode = BarPosition | 'menu';

export interface TabInfo {
    id: string; // stable unique id (React key + localStorage identity)
    session: string; // tmux session name (display + routing)
    title: string; // label shown on the chip; updated from terminal title events
    search: string; // full WS query string incl. leading '?' (preserves routing)
    renamed?: boolean; // user renamed the tab — terminal title events no longer overwrite it
    group: string; // entry namespace: the session name the page was opened with when
    // this cluster of tabs was spawned. Lets the bar scope the list to "just this
    // session" vs "all sessions". An entry tab's group equals its own session.
}

export interface BarState {
    position: BarPosition;
    menuMode: boolean; // collapsed to a single ☰ menu button
    scale?: number; // proportional zoom of the whole bar (1 = default)
    colWidth?: number; // column width (px) in left/right mode, drag-resizable
    autoHide?: boolean; // hide the bar after a few idle seconds; reveal on edge-hover
    showAllGroups?: boolean; // show every tab (all sessions) vs only the active tab's group
}

// Clamp for the drag-resizable column width (left/right mode). Wide enough to
// read a couple of session names, capped so the column can't eat the stage.
export const COL_WIDTH_MIN = 140;
export const COL_WIDTH_MAX = 560;
export const COL_WIDTH_DEFAULT = 190;

export function clampColWidth(w: number): number {
    if (!Number.isFinite(w)) return COL_WIDTH_DEFAULT;
    return Math.max(COL_WIDTH_MIN, Math.min(COL_WIDTH_MAX, Math.round(w)));
}

export interface TabsState {
    tabs: TabInfo[];
    activeId: string;
    bar: BarState;
}

const STORE_KEY = 'ttyd.tabs.v1';

function sanitizeName(raw: string): string {
    return (raw || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

// Derive the tmux session name a given WS query string routes to. Mirrors the
// precedence in ttyd-session.sh and vkbd/storage.ts ttydSessionName().
export function sessionFromSearch(search: string): string {
    try {
        const args = new URLSearchParams(search).getAll('arg');
        const named = args.find(a => a.startsWith('name:'));
        if (named !== undefined) return sanitizeName(named.slice('name:'.length)) || 'main';
        let i = 0;
        while (i < args.length) {
            const a = args[i];
            if (
                a.startsWith('cwd:') ||
                a === 'codex' ||
                a.startsWith('codex:') ||
                a === 'claude' ||
                a.startsWith('claude:')
            ) {
                i++;
            } else {
                break;
            }
        }
        const rest = args.slice(i);
        if (rest.length === 0) return 'main';
        if (rest[0] === 'screen' || rest[0] === 'tmux') return sanitizeName(rest[1] ?? '') || 'main';
        return sanitizeName(rest[0]) || 'main';
    } catch {
        return 'main';
    }
}

export function backendFromSearch(search: string): 'tmux' | 'screen' {
    try {
        const args = new URLSearchParams(search).getAll('arg');
        let i = 0;
        while (i < args.length) {
            const a = args[i];
            if (
                a.startsWith('cwd:') ||
                a.startsWith('name:') ||
                a === 'codex' ||
                a.startsWith('codex:') ||
                a === 'claude' ||
                a.startsWith('claude:')
            ) {
                i++;
            } else {
                break;
            }
        }
        return args[i] === 'screen' ? 'screen' : 'tmux';
    } catch {
        return 'tmux';
    }
}

let idCounter = 0;
export function genTabId(): string {
    // Time-free unique id (Date.now/Math.random are fine in the browser, but a
    // counter keyed off performance.now avoids any collision within a session).
    idCounter += 1;
    const t = typeof performance !== 'undefined' ? Math.floor(performance.now()) : idCounter;
    return `t${t}_${idCounter}`;
}

// Pick a fresh session name not already used by an open tab, derived from the
// namespace's own default session name: main-2, main-3, … for a "main" entry,
// work-2, work-3, … for a "work" one. The base itself is the first tab, so the
// numbering starts at 2 and reads naturally. Falls back to "main" when no base
// is known (e.g. a legacy tab list with no group).
export function nextSessionName(tabs: TabInfo[], base?: string): string {
    const root = sanitizeName(base || '') || 'main';
    const used = new Set(tabs.map(t => t.session));
    let n = 2;
    while (used.has(`${root}-${n}`)) n++;
    return `${root}-${n}`;
}

export function makeTab(session: string, search: string, title?: string, group?: string): TabInfo {
    // An entry tab (opened directly from a URL) owns its own namespace, so group
    // defaults to the session name. Sub-tabs pass the active namespace explicitly.
    return { id: genTabId(), session, search, title: title || session, group: group || session };
}

// The tabs to show for the current view: everything when showAll, else only the
// tabs belonging to `group` (the active tab's entry namespace).
export function tabsInView(tabs: TabInfo[], group: string, showAll: boolean): TabInfo[] {
    if (showAll) return tabs;
    return tabs.filter(t => t.group === group);
}

// Active-tab persistence in the URL hash (`#tab=<id>`), so a reload lands on the
// same tab. Kept in the hash, not the query string, so it never interferes with
// the server routing args (`?arg=…`).
export function tabIdFromHash(): string | null {
    try {
        const h = window.location.hash || '';
        const id = new URLSearchParams(h.replace(/^#/, '')).get('tab');
        return id || null;
    } catch {
        return null;
    }
}

// The tab representing however the page was actually opened. Preserves the full
// original query string so all routing modifiers keep working.
export function initialTabFromUrl(): TabInfo {
    const search = window.location.search || '';
    const session = sessionFromSearch(search);
    return makeTab(session, search, session);
}

function defaultBar(): BarState {
    return {
        position: 'top',
        menuMode: false,
        scale: 1,
        colWidth: COL_WIDTH_DEFAULT,
        autoHide: true,
        showAllGroups: false,
    };
}

export function loadTabsState(): TabsState {
    let saved: TabsState | null = null;
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) saved = JSON.parse(raw) as TabsState;
    } catch {
        saved = null;
    }

    if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) {
        const first = initialTabFromUrl();
        return { tabs: [first], activeId: first.id, bar: defaultBar() };
    }

    // Restore, but make sure the session the page was *opened* with is present
    // and focused, so deep-links still land somewhere even with saved tabs.
    const bar: BarState = { ...defaultBar(), ...(saved.bar || {}) };
    bar.colWidth = clampColWidth(bar.colWidth ?? COL_WIDTH_DEFAULT);
    // Tabs saved before namespacing existed have no group. They were one flat
    // list, so fold them all into a single legacy group (the first tab's session)
    // — that keeps them grouped together and visible, never scattered or hidden.
    const legacyGroup = sanitizeName(saved.tabs[0]?.session || '') || 'main';
    const tabs: TabInfo[] = saved.tabs.map(t => ({
        id: t.id || genTabId(),
        session: t.session || sessionFromSearch(t.search || ''),
        search: t.search || `?arg=name:${t.session}`,
        title: t.title || t.session || 'shell',
        renamed: !!t.renamed,
        group: t.group || legacyGroup,
    }));

    const urlSearch = window.location.search || '';
    // Only honor an explicit deep-link (has ?arg=...), not a bare reload.
    const hasExplicit = new URLSearchParams(urlSearch).getAll('arg').length > 0;
    let activeId = tabs.find(t => t.id === saved!.activeId)?.id || tabs[0].id;
    if (hasExplicit) {
        const urlSession = sessionFromSearch(urlSearch);
        const existing = tabs.find(t => t.session === urlSession);
        if (existing) {
            activeId = existing.id;
        } else {
            const t = makeTab(urlSession, urlSearch, urlSession);
            tabs.unshift(t);
            activeId = t.id;
        }
    } else {
        // Bare reload: the URL hash (#tab=<id>) is the strongest signal for which
        // tab to focus, so a refresh returns to exactly where you were.
        const hashId = tabIdFromHash();
        if (hashId && tabs.some(t => t.id === hashId)) activeId = hashId;
    }

    return { tabs, activeId, bar };
}

export function saveTabsState(state: TabsState): void {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
        // storage full / disabled — non-fatal, tabs just won't persist.
    }
}
