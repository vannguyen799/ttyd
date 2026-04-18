import type { KeyRow } from './types';

export const ROWS: KeyRow[] = [
    {
        keys: [
            { label: 'Esc', action: { type: 'named', key: 'esc' } },
            { label: 'Tab', action: { type: 'named', key: 'tab' } },
            { label: 'Ctrl', action: { type: 'mod', mod: 'ctrl' }, class: 'mod' },
            { label: 'Shift', action: { type: 'mod', mod: 'shift' }, class: 'mod' },
            { label: 'Alt', action: { type: 'mod', mod: 'alt' }, class: 'mod' },
            { label: 'Super', action: { type: 'mod', mod: 'meta' }, class: 'mod' },
            { label: '←', action: { type: 'named', key: 'left' } },
            { label: '↓', action: { type: 'named', key: 'down' } },
            { label: '↑', action: { type: 'named', key: 'up' } },
            { label: '→', action: { type: 'named', key: 'right' } },
        ],
    },
    {
        keys: [
            { label: 'Home', action: { type: 'named', key: 'home' } },
            { label: 'End', action: { type: 'named', key: 'end' } },
            { label: 'PgUp', action: { type: 'named', key: 'pgup' } },
            { label: 'PgDn', action: { type: 'named', key: 'pgdn' } },
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
                sub: 'wheel up',
                action: { type: 'scroll', by: 'page', dir: -1 },
                class: 'scroll',
                flex: 2,
            },
            {
                label: '▼ Scroll',
                sub: 'wheel down',
                action: { type: 'scroll', by: 'page', dir: 1 },
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
];
