import type { KeyAction, ModKey, NamedKey } from './types';

export type ModState = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };

export const emptyMods = (): ModState => ({ ctrl: false, shift: false, alt: false, meta: false });

function modBits(m: ModState): number {
    let n = 0;
    if (m.shift) n |= 1;
    if (m.alt) n |= 2;
    if (m.ctrl) n |= 4;
    if (m.meta) n |= 8;
    return n;
}

function csiMod(m: ModState): string {
    const b = modBits(m);
    return b ? `1;${b + 1}` : '';
}

const NAMED_CSI: Record<NamedKey, { csi?: string; ss3?: string; raw?: string; tilde?: number }> = {
    up: { csi: 'A', ss3: 'A' },
    down: { csi: 'B', ss3: 'B' },
    right: { csi: 'C', ss3: 'C' },
    left: { csi: 'D', ss3: 'D' },
    home: { csi: 'H', ss3: 'H' },
    end: { csi: 'F', ss3: 'F' },
    pgup: { tilde: 5 },
    pgdn: { tilde: 6 },
    insert: { tilde: 2 },
    delete: { tilde: 3 },
    tab: { raw: '\t' },
    esc: { raw: '\x1b' },
    enter: { raw: '\r' },
    backspace: { raw: '\x7f' },
    f1: { ss3: 'P' },
    f2: { ss3: 'Q' },
    f3: { ss3: 'R' },
    f4: { ss3: 'S' },
    f5: { tilde: 15 },
    f6: { tilde: 17 },
    f7: { tilde: 18 },
    f8: { tilde: 19 },
    f9: { tilde: 20 },
    f10: { tilde: 21 },
    f11: { tilde: 23 },
    f12: { tilde: 24 },
};

export function bytesForNamed(key: NamedKey, mods: ModState): string {
    const def = NAMED_CSI[key];
    const b = modBits(mods);
    if (def.raw && b === 0) return def.raw;
    if (def.raw && key === 'tab' && mods.shift) return '\x1b[Z';
    if (def.raw) return def.raw;
    if (def.tilde !== undefined) {
        return b ? `\x1b[${def.tilde};${b + 1}~` : `\x1b[${def.tilde}~`;
    }
    if (def.csi) {
        return b ? `\x1b[${csiMod(mods)}${def.csi}` : `\x1b[${def.csi}`;
    }
    if (def.ss3) {
        return b ? `\x1b[${csiMod(mods)}${def.ss3}` : `\x1bO${def.ss3}`;
    }
    return '';
}

export function bytesForText(text: string, mods: ModState): string {
    if (text.length === 0) return '';
    let ch = text;
    if (mods.shift && ch.length === 1) ch = ch.toUpperCase();
    let out = ch;
    if (mods.ctrl && ch.length === 1) {
        const code = ch.toUpperCase().charCodeAt(0);
        if (code >= 0x40 && code <= 0x5f) out = String.fromCharCode(code - 0x40);
        else if (ch === ' ') out = '\x00';
        else if (ch === '?') out = '\x7f';
    }
    if (mods.alt) out = '\x1b' + out;
    return out;
}

const NAMED_FROM_KEY: Record<string, NamedKey> = {
    ArrowUp: 'up',
    ArrowDown: 'down',
    ArrowLeft: 'left',
    ArrowRight: 'right',
    Home: 'home',
    End: 'end',
    PageUp: 'pgup',
    PageDown: 'pgdn',
    Tab: 'tab',
    Escape: 'esc',
    Enter: 'enter',
    Backspace: 'backspace',
    Delete: 'delete',
    Insert: 'insert',
    F1: 'f1',
    F2: 'f2',
    F3: 'f3',
    F4: 'f4',
    F5: 'f5',
    F6: 'f6',
    F7: 'f7',
    F8: 'f8',
    F9: 'f9',
    F10: 'f10',
    F11: 'f11',
    F12: 'f12',
};

export function bytesForKeyEvent(event: KeyboardEvent, mods: ModState): string | null {
    const named = NAMED_FROM_KEY[event.key];
    if (named) return bytesForNamed(named, mods);
    if (event.key.length === 1) return bytesForText(event.key, mods);
    return null;
}

export interface Dispatcher {
    mods: ModState;
    clearMods: () => void;
    toggleMod: (m: ModKey) => void;
    hideKeyboard: () => void;
}

export function dispatch(action: KeyAction, d: Dispatcher): boolean {
    const bridge = window.ttyd;
    if (!bridge && action.type !== 'mod' && action.type !== 'hide') return false;

    switch (action.type) {
        case 'mod':
            d.toggleMod(action.mod);
            return false;
        case 'send':
            bridge.sendBytes(action.bytes);
            return true;
        case 'text':
            bridge.sendBytes(bytesForText(action.text, d.mods));
            return true;
        case 'named':
            bridge.sendBytes(bytesForNamed(action.key, d.mods));
            return true;
        case 'scroll': {
            const dir = action.dir ?? 1;
            if (action.by === 'bottom') bridge.scrollToBottom();
            else if (action.by === 'top') bridge.scrollLines(-1e9);
            else if (action.by === 'page') bridge.scrollPages(dir);
            else bridge.scrollLines((action.amount ?? 3) * dir);
            return false;
        }
        case 'paste':
            void bridge.paste();
            return true;
        case 'copy':
            void bridge.copySelection();
            return false;
        case 'hide':
            d.hideKeyboard();
            return false;
    }
}
