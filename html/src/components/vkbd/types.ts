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
    // Multi-step send: each step's `delay` (ms) elapses before it is sent,
    // relative to the previous step. Needed for tmux mode switches (e.g.
    // prefix `:` opens the command prompt, which can't receive its payload
    // in the same write — tmux must process the mode change first).
    | { type: 'seq'; steps: { bytes: string; delay?: number }[] }
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
    repeat?: boolean;
}

export interface KeyRow {
    keys: KeyDef[];
    // Only render this row when the active session is a tmux session
    // (see ttydSessionBackend in storage.ts).
    tmuxOnly?: boolean;
}

// A named, toggleable cluster of rows. Groups give the keyboard a "level"
// of organisation above rows: each group can be enabled/disabled as a unit
// (settings.disabledGroups), individual keys inside it can still be toggled
// (settings.disabledIds), and custom buttons can be routed into any group.
export interface KeyGroup {
    id: string;
    title: string;
    rows: KeyRow[];
    // Only render this group for tmux-backed sessions.
    tmuxOnly?: boolean;
}
