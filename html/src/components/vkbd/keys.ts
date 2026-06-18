import type { KeyRow } from './types';

// tmux prefix is Ctrl-b (\x02). These combos drive tmux's default key
// table — splits via %/", resize via prefix+Ctrl-arrow (repeatable),
// and an explicit :kill-pane command so closing works without the
// y/n confirm prompt (which has no key on a touch keyboard).
const TMUX = '\x02';

export const ROWS: KeyRow[] = [
    {
        keys: [
            { label: 'Esc', action: { type: 'named', key: 'esc' } },
            { label: 'Tab', action: { type: 'named', key: 'tab' } },
            { label: 'Ctrl', action: { type: 'mod', mod: 'ctrl' }, class: 'mod' },
            { label: 'Shift', action: { type: 'mod', mod: 'shift' }, class: 'mod' },
            { label: 'Alt', action: { type: 'mod', mod: 'alt' }, class: 'mod' },
            { label: 'Super', action: { type: 'mod', mod: 'meta' }, class: 'mod' },
            {
                label: '←',
                sub: 'hold',
                action: { type: 'named', key: 'left' },
                class: 'arrow arrow-first',
                repeat: true,
            },
            {
                label: '↑',
                sub: 'hold',
                action: { type: 'named', key: 'up' },
                class: 'arrow',
                repeat: true,
            },
            {
                label: '↓',
                sub: 'hold',
                action: { type: 'named', key: 'down' },
                class: 'arrow',
                repeat: true,
            },
            {
                label: '→',
                sub: 'hold',
                action: { type: 'named', key: 'right' },
                class: 'arrow',
                repeat: true,
            },
        ],
    },
    {
        keys: [
            { label: 'Home', action: { type: 'named', key: 'home' } },
            { label: 'End', action: { type: 'named', key: 'end' } },
            { label: 'PgUp', action: { type: 'named', key: 'pgup' } },
            { label: 'PgDn', action: { type: 'named', key: 'pgdn' } },
            { label: '⌫', sub: 'hold', action: { type: 'named', key: 'backspace' }, repeat: true },
            { label: 'Del', action: { type: 'named', key: 'delete' } },
            { label: 'Ins', action: { type: 'named', key: 'insert' } },
            { label: '^C', sub: 'int', action: { type: 'send', bytes: '\x03' } },
            { label: '^D', sub: 'eof', action: { type: 'send', bytes: '\x04' } },
            { label: '^Z', sub: 'sus', action: { type: 'send', bytes: '\x1a' } },
            { label: '^L', sub: 'clr', action: { type: 'send', bytes: '\x0c' } },
        ],
    },
    {
        keys: [
            { label: '^R', sub: 'hist', action: { type: 'send', bytes: '\x12' } },
            { label: '^W', sub: 'del-w', action: { type: 'send', bytes: '\x17' } },
            { label: '^U', sub: 'del-l', action: { type: 'send', bytes: '\x15' } },
            { label: '^A', sub: 'bol', action: { type: 'send', bytes: '\x01' } },
            { label: '^E', sub: 'eol', action: { type: 'send', bytes: '\x05' } },
            { label: '^K', sub: 'kill', action: { type: 'send', bytes: '\x0b' } },
            { label: 'Copy', sub: '^⇧C', action: { type: 'copy' } },
            { label: 'Paste', sub: '^⇧V', action: { type: 'paste' } },
            { label: 'F1', action: { type: 'named', key: 'f1' } },
            { label: 'F2', action: { type: 'named', key: 'f2' } },
        ],
    },
    {
        keys: [
            {
                label: '▲ Scroll',
                sub: 'hold = auto',
                action: { type: 'scroll', by: 'line', dir: -1 },
                class: 'scroll',
                flex: 2,
            },
            {
                label: '▼ Scroll',
                sub: 'hold = auto',
                action: { type: 'scroll', by: 'line', dir: 1 },
                class: 'scroll',
                flex: 2,
            },
            { label: 'F3', action: { type: 'named', key: 'f3' } },
            { label: 'F4', action: { type: 'named', key: 'f4' } },
            { label: 'F5', action: { type: 'named', key: 'f5' } },
            { label: 'F6', action: { type: 'named', key: 'f6' } },
            { label: 'F7', action: { type: 'named', key: 'f7' } },
            { label: 'F8', action: { type: 'named', key: 'f8' } },
            { label: 'F11', action: { type: 'named', key: 'f11' } },
            { label: 'F12', action: { type: 'named', key: 'f12' } },
        ],
    },
    {
        tmuxOnly: true,
        keys: [
            {
                label: 'Split │',
                sub: 'L | R',
                action: { type: 'send', bytes: TMUX + '%' },
                class: 'tmux',
            },
            {
                label: 'Split ─',
                sub: 'T / B',
                action: { type: 'send', bytes: TMUX + '"' },
                class: 'tmux',
            },
            {
                // prefix `:` opens tmux's command prompt; the command must
                // arrive in a *separate* write or tmux types it into the
                // shell instead (mode switch needs an event-loop tick).
                label: '✕ Pane',
                sub: 'kill',
                action: {
                    type: 'seq',
                    steps: [{ bytes: TMUX + ':' }, { bytes: 'kill-pane\r', delay: 80 }],
                },
                class: 'tmux danger',
            },
            {
                label: '⇲←',
                sub: 'size',
                action: { type: 'send', bytes: TMUX + '\x1b[1;5D' },
                class: 'tmux',
                repeat: true,
            },
            {
                label: '⇲↑',
                sub: 'size',
                action: { type: 'send', bytes: TMUX + '\x1b[1;5A' },
                class: 'tmux',
                repeat: true,
            },
            {
                label: '⇲↓',
                sub: 'size',
                action: { type: 'send', bytes: TMUX + '\x1b[1;5B' },
                class: 'tmux',
                repeat: true,
            },
            {
                label: '⇲→',
                sub: 'size',
                action: { type: 'send', bytes: TMUX + '\x1b[1;5C' },
                class: 'tmux',
                repeat: true,
            },
        ],
    },
];
