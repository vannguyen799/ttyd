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
}

function defaultVisible(): boolean {
    try {
        return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    } catch {
        return false;
    }
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
};

export function keyId(rowIndex: number, keyIndex: number, def: KeyDef): string {
    return `b:${rowIndex}:${keyIndex}:${def.label}`;
}

export function loadSettings(): Settings {
    const fd = defaultFloating();
    const base: Settings = {
        ...DEFAULTS_STATIC,
        visible: defaultVisible(),
        pos: fd.pos,
        width: fd.width,
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
