export type ModKey = 'ctrl' | 'shift' | 'alt' | 'meta';

export type NamedKey =
    | 'up'
    | 'down'
    | 'left'
    | 'right'
    | 'home'
    | 'end'
    | 'pgup'
    | 'pgdn'
    | 'tab'
    | 'esc'
    | 'enter'
    | 'backspace'
    | 'delete'
    | 'insert'
    | 'f1'
    | 'f2'
    | 'f3'
    | 'f4'
    | 'f5'
    | 'f6'
    | 'f7'
    | 'f8'
    | 'f9'
    | 'f10'
    | 'f11'
    | 'f12';

export type ScrollUnit = 'line' | 'page' | 'bottom' | 'top';

export type KeyAction =
    | { type: 'mod'; mod: ModKey }
    | { type: 'send'; bytes: string }
    | { type: 'text'; text: string }
    | { type: 'named'; key: NamedKey }
    | { type: 'scroll'; by: ScrollUnit; dir?: -1 | 1; amount?: number }
    | { type: 'paste' }
    | { type: 'copy' }
    | { type: 'hide' };

export interface KeyDef {
    label: string;
    sub?: string;
    action: KeyAction;
    flex?: number;
    class?: string;
    stickyClear?: boolean;
}

export interface KeyRow {
    keys: KeyDef[];
}
