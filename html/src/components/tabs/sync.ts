// Server-side tab layout, so the tab list is a property of the deployment
// rather than of one browser profile.
//
// localStorage alone means the phone and the laptop pointed at the same ttyd
// show two unrelated sets of tabs, and clearing site data throws the list away
// even though every tmux session behind it is still running. The `/tabs`
// endpoint (src/http.c) stores one opaque JSON blob for the whole deployment;
// this module is the client half.
//
// Conflicts are settled by a revision number rather than merged: each save
// stamps `Date.now()` and the higher number wins, so the device that touched
// its tabs most recently is the one whose layout survives. Merging two lists
// that both claim to be "the" layout has no good answer — the sessions in them
// are real and neither side is wrong — and last-writer-wins at least matches
// what a person expects from picking up a different device.
//
// The endpoint is optional: a ttyd started without --tabs-file answers 404 and
// everything here degrades to the localStorage-only behaviour it had before.

import { TabsState } from './model';

// Exported so the app can recognise a write from another browser tab of the
// same profile (see the `storage` listener in app.tsx).
export const REV_KEY = 'ttyd.tabs.rev';
const PUSH_DEBOUNCE_MS = 700;

const path = window.location.pathname.replace(/[/]+$/, '');
const tabsUrl = [window.location.protocol, '//', window.location.host, path, '/tabs'].join('');

export interface TabsSnapshot {
    rev: number;
    state: TabsState;
}

// The revision of the layout this browser currently holds. 0 means "never
// saved", which loses to any revision the server has.
export function loadRev(): number {
    try {
        const raw = localStorage.getItem(REV_KEY);
        const n = raw ? Number(raw) : 0;
        return Number.isFinite(n) ? n : 0;
    } catch {
        return 0;
    }
}

export function saveRev(rev: number): void {
    try {
        localStorage.setItem(REV_KEY, String(rev));
    } catch {
        // storage full / disabled — the layout still syncs this session, it
        // just can't remember afterwards which revision it was on.
    }
}

// Stamp a new revision for a local edit. Clamped to be greater than the one we
// already hold so a clock that jumps backwards can't make later edits look
// older than earlier ones.
export function nextRev(): number {
    return Math.max(Date.now(), loadRev() + 1);
}

// The layout stored on the server, or null when there is none to be had —
// endpoint disabled, request failed, blob not in the shape we expect. All of
// those mean the same thing to the caller: keep using the local copy.
export async function fetchRemote(): Promise<TabsSnapshot | null> {
    try {
        const res = await fetch(tabsUrl, { cache: 'no-store', credentials: 'same-origin' });
        if (!res.ok) return null;
        const body = (await res.json()) as Partial<TabsSnapshot>;
        if (!body || typeof body.rev !== 'number' || !body.state) return null;
        if (!Array.isArray(body.state.tabs) || body.state.tabs.length === 0) return null;
        return { rev: body.rev, state: body.state };
    } catch {
        return null;
    }
}

let pushTimer: number | undefined;
let pending: TabsSnapshot | null = null;

function send(snapshot: TabsSnapshot): void {
    fetch(tabsUrl, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
    }).catch(() => {
        // Offline, or a ttyd without --tabs-file. The layout is already in
        // localStorage; the next change tries again.
    });
}

// Queue a layout for upload. Debounced because a drag-to-reorder commits on
// every chip the pointer crosses, and each of those would otherwise be its own
// request.
export function pushRemote(snapshot: TabsSnapshot): void {
    pending = snapshot;
    if (pushTimer !== undefined) window.clearTimeout(pushTimer);
    pushTimer = window.setTimeout(() => {
        pushTimer = undefined;
        const next = pending;
        pending = null;
        if (next) send(next);
    }, PUSH_DEBOUNCE_MS);
}

// Send whatever is still queued right now. Called when the page is going away,
// where a debounce timer would never fire — closing a tab is exactly when the
// last change matters most. sendBeacon survives the unload; fetch may not.
export function flushRemote(): void {
    if (pushTimer !== undefined) {
        window.clearTimeout(pushTimer);
        pushTimer = undefined;
    }
    const next = pending;
    pending = null;
    if (!next) return;

    const body = JSON.stringify(next);
    try {
        if (navigator.sendBeacon) {
            navigator.sendBeacon(tabsUrl, new Blob([body], { type: 'application/json' }));
            return;
        }
    } catch {
        // fall through to the normal request
    }
    send(next);
}
