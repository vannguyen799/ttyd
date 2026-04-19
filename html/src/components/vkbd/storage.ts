import type { KeyDef } from './types';

const STORAGE_KEY = 'ttyd.vkbd.v1';

export interface Settings {
    visible: boolean;
    position: 'bottom' | 'top';
    opacity: number;
    disabledIds: string[];
    custom: (KeyDef & { id: string })[];
    pos: { x: number; y: number } | null;
    width: number | null;
    keyHeight: number | null;
    scrollStep: number;
    autoRepeat: boolean;
    repeatDelayMs: number;
    repeatIntervalMs: number;
    showInput: boolean;
    termFontSize: number | null;
}

function isCoarse(): boolean {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch {
        return false;
    }
}

function defaultVisible(): boolean {
    return isCoarse();
}

function defaultFloating(): { pos: { x: number; y: number }; width: number } {
    try {
        const w = Math.min(window.innerWidth - 24, 520);
        const x = Math.max(12, Math.round((window.innerWidth - w) / 2));
        const estH = 200;
        const y = Math.max(12, window.innerHeight - estH - 24);
        return { pos: { x, y }, width: w };
    } catch {
        return { pos: { x: 24, y: 24 }, width: 400 };
    }
}

const DEFAULTS_STATIC: Omit<Settings, 'visible' | 'pos' | 'width'> = {
    position: 'bottom',
    opacity: 0.92,
    disabledIds: [],
    custom: [],
    keyHeight: null,
    scrollStep: 5,
    autoRepeat: true,
    repeatDelayMs: 350,
    repeatIntervalMs: 60,
    showInput: true,
    termFontSize: null,
};

export function keyId(rowIndex: number, keyIndex: number, def: KeyDef): string {
    return `b:${rowIndex}:${keyIndex}:${def.label}`;
}

export function loadSettings(): Settings {
    const coarse = isCoarse();
    const fd = defaultFloating();
    const base: Settings = {
        ...DEFAULTS_STATIC,
        visible: defaultVisible(),
        // Mobile-first default: dock at bottom (split screen with terminal).
        // Desktop default: float in center-bottom.
        pos: coarse ? null : fd.pos,
        width: coarse ? null : fd.width,
    };
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return applyUrlOverride(base);
        const parsed = JSON.parse(raw);
        return applyUrlOverride({ ...base, ...parsed });
    } catch {
        return applyUrlOverride(base);
    }
}

export function resetLayout(current: Settings): Settings {
    const coarse = isCoarse();
    if (coarse) {
        return { ...current, pos: null, width: null, keyHeight: null };
    }
    const fd = defaultFloating();
    return { ...current, pos: fd.pos, width: fd.width, keyHeight: null };
}

function applyUrlOverride(s: Settings): Settings {
    try {
        const arg = new URLSearchParams(window.location.search).get('vkbd');
        if (arg === '1' || arg === 'true') return { ...s, visible: true };
        if (arg === '0' || arg === 'false') return { ...s, visible: false };
    } catch {
        // ignore
    }
    return s;
}

export function saveSettings(s: Settings): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    } catch (e) {
        console.warn('[ttyd] vkbd save failed', e);
    }
}

export function genId(): string {
    return `c:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeName(s: string): string {
    return s.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

function ttydSessionName(): string {
    try {
        const args = new URLSearchParams(window.location.search).getAll('arg');
        let i = 0;
        while (i < args.length) {
            const a = args[i];
            if (a.startsWith('cwd:') || a === 'claude' || a.startsWith('claude:')) {
                i++;
            } else {
                break;
            }
        }
        const rest = args.slice(i);
        if (rest.length === 0) return 'main';
        if (rest[0] === 'screen' || rest[0] === 'tmux') {
            return sanitizeName(rest[1] ?? '') || 'main';
        }
        return sanitizeName(rest[0]) || 'main';
    } catch {
        return 'main';
    }
}

function sessionKey(prefix: string): string {
    return `${prefix}:${ttydSessionName()}`;
}

function inputKey(): string {
    return sessionKey('ttyd.vkbd.input.v1');
}

const MAX_HISTORY = 10;

export function loadInputHistory(): string[] {
    try {
        const raw = localStorage.getItem(sessionKey('ttyd.vkbd.hist.v1'));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export function pushInputHistory(text: string): void {
    if (!text.trim()) return;
    try {
        const k = sessionKey('ttyd.vkbd.hist.v1');
        const hist = loadInputHistory().filter(s => s !== text);
        hist.unshift(text);
        localStorage.setItem(k, JSON.stringify(hist.slice(0, MAX_HISTORY)));
    } catch {
        // ignore
    }
}

export function loadInputDraft(): string {
    try {
        return localStorage.getItem(inputKey()) || '';
    } catch {
        return '';
    }
}

export function saveInputDraft(text: string): void {
    try {
        const k = inputKey();
        if (text) localStorage.setItem(k, text);
        else localStorage.removeItem(k);
    } catch {
        // ignore
    }
}
