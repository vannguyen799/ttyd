import { h, Component } from 'preact';
import { ROWS } from './keys';
import { keyId, genId, Settings } from './storage';
import { decodeEscapes, encodeForDisplay } from './decode';
import { bytesForNamed } from './actions';
import type { KeyAction, KeyDef, NamedKey } from './types';

interface Props {
    settings: Settings;
    onChange: (s: Settings) => void;
    onClose: () => void;
    onReset: () => void;
}

interface FormState {
    editingId: string | null;
    label: string;
    sub: string;
    mode: 'raw' | 'text' | 'key';
    rawBytes: string;
    text: string;
    namedKey: NamedKey;
    ctrl: boolean;
    shift: boolean;
    alt: boolean;
    meta: boolean;
}

const NAMED_OPTIONS: NamedKey[] = [
    'up',
    'down',
    'left',
    'right',
    'home',
    'end',
    'pgup',
    'pgdn',
    'tab',
    'esc',
    'enter',
    'backspace',
    'delete',
    'insert',
    'f1',
    'f2',
    'f3',
    'f4',
    'f5',
    'f6',
    'f7',
    'f8',
    'f9',
    'f10',
    'f11',
    'f12',
];

const EMPTY_FORM: FormState = {
    editingId: null,
    label: '',
    sub: '',
    mode: 'text',
    rawBytes: '',
    text: '',
    namedKey: 'up',
    ctrl: false,
    shift: false,
    alt: false,
    meta: false,
};

export class SettingsPanel extends Component<Props, FormState> {
    constructor(props: Props) {
        super(props);
        this.state = { ...EMPTY_FORM };
    }

    private update = (patch: Partial<Settings>) => {
        this.props.onChange({ ...this.props.settings, ...patch });
    };

    private toggleBuiltin = (id: string) => {
        const disabled = new Set(this.props.settings.disabledIds);
        if (disabled.has(id)) disabled.delete(id);
        else disabled.add(id);
        this.update({ disabledIds: [...disabled] });
    };

    private toggleAllBuiltin = (enable: boolean) => {
        if (enable) {
            this.update({ disabledIds: [] });
        } else {
            const ids: string[] = [];
            ROWS.forEach((row, ri) => row.keys.forEach((k, ki) => ids.push(keyId(ri, ki, k))));
            this.update({ disabledIds: ids });
        }
    };

    private deleteCustom = (id: string) => {
        this.update({ custom: this.props.settings.custom.filter(k => k.id !== id) });
    };

    private startEdit = (k: KeyDef & { id: string }) => {
        const action = k.action;
        const form: FormState = {
            ...EMPTY_FORM,
            editingId: k.id,
            label: k.label,
            sub: k.sub || '',
        };
        if (action.type === 'send') {
            form.mode = 'raw';
            form.rawBytes = encodeForDisplay(action.bytes);
        } else if (action.type === 'text') {
            form.mode = 'text';
            form.text = action.text;
        }
        this.setState(form);
    };

    private saveForm = () => {
        const s = this.state;
        if (!s.label.trim()) return;
        let action: KeyAction;
        if (s.mode === 'raw') {
            action = { type: 'send', bytes: decodeEscapes(s.rawBytes) };
        } else if (s.mode === 'text') {
            action = { type: 'text', text: s.text };
        } else {
            const mods = { ctrl: s.ctrl, shift: s.shift, alt: s.alt, meta: s.meta };
            action = { type: 'send', bytes: bytesForNamed(s.namedKey, mods) };
        }
        const def: KeyDef & { id: string } = {
            id: s.editingId || genId(),
            label: s.label.trim(),
            sub: s.sub.trim() || undefined,
            action,
        };
        const existing = this.props.settings.custom;
        const next = s.editingId ? existing.map(k => (k.id === s.editingId ? def : k)) : [...existing, def];
        this.update({ custom: next });
        this.setState({ ...EMPTY_FORM });
    };

    private cancelForm = () => {
        this.setState({ ...EMPTY_FORM });
    };

    render(props: Props, s: FormState) {
        const { settings } = props;
        const disabled = new Set(settings.disabledIds);
        return (
            <div class="vkbd-settings" onClick={e => e.stopPropagation()}>
                <div class="vkbd-settings-header">
                    <span>Keyboard Settings</span>
                    <button class="vkbd-icon-btn" onClick={props.onClose} aria-label="Close">
                        ✕
                    </button>
                </div>

                <div class="vkbd-section">
                    <div class="vkbd-section-title">Appearance</div>
                    <div class="vkbd-row-setting">
                        <label>Position</label>
                        <select
                            value={settings.position}
                            onChange={e =>
                                this.update({ position: (e.target as HTMLSelectElement).value as 'bottom' | 'top' })
                            }
                        >
                            <option value="bottom">Bottom</option>
                            <option value="top">Top</option>
                        </select>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Opacity</label>
                        <input
                            type="range"
                            min="0.4"
                            max="1"
                            step="0.05"
                            value={settings.opacity}
                            onInput={e => this.update({ opacity: parseFloat((e.target as HTMLInputElement).value) })}
                        />
                        <span>{Math.round(settings.opacity * 100)}%</span>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Layout</label>
                        <button class="vkbd-text-btn" onClick={props.onReset}>
                            Reset to default
                        </button>
                        <button class="vkbd-text-btn" onClick={() => this.update({ pos: null })}>
                            Dock {settings.position}
                        </button>
                        <span class="vkbd-hint">
                            {settings.pos
                                ? `float · ${Math.round(settings.width || 0)}×${settings.keyHeight || 38}`
                                : 'docked'}
                        </span>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Input field</label>
                        <input
                            type="checkbox"
                            checked={settings.showInput}
                            onChange={e => this.update({ showInput: (e.target as HTMLInputElement).checked })}
                        />
                        <span class="vkbd-hint">compose buffer + Send button</span>
                    </div>
                </div>

                <div class="vkbd-section">
                    <div class="vkbd-section-title">Scroll</div>
                    <div class="vkbd-row-setting">
                        <label>Lines/click</label>
                        <input
                            type="range"
                            min="1"
                            max="40"
                            step="1"
                            value={settings.scrollStep}
                            onInput={e =>
                                this.update({ scrollStep: parseInt((e.target as HTMLInputElement).value, 10) })
                            }
                        />
                        <span class="vkbd-hint">{settings.scrollStep} line(s)</span>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Auto-repeat</label>
                        <input
                            type="checkbox"
                            checked={settings.autoRepeat}
                            onChange={e => this.update({ autoRepeat: (e.target as HTMLInputElement).checked })}
                        />
                        <span class="vkbd-hint">hold scroll button to repeat</span>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Hold delay</label>
                        <input
                            type="range"
                            min="100"
                            max="1000"
                            step="50"
                            value={settings.repeatDelayMs}
                            disabled={!settings.autoRepeat}
                            onInput={e =>
                                this.update({ repeatDelayMs: parseInt((e.target as HTMLInputElement).value, 10) })
                            }
                        />
                        <span class="vkbd-hint">{settings.repeatDelayMs}ms</span>
                    </div>
                    <div class="vkbd-row-setting">
                        <label>Repeat rate</label>
                        <input
                            type="range"
                            min="20"
                            max="300"
                            step="10"
                            value={settings.repeatIntervalMs}
                            disabled={!settings.autoRepeat}
                            onInput={e =>
                                this.update({ repeatIntervalMs: parseInt((e.target as HTMLInputElement).value, 10) })
                            }
                        />
                        <span class="vkbd-hint">every {settings.repeatIntervalMs}ms</span>
                    </div>
                </div>

                <div class="vkbd-section">
                    <div class="vkbd-section-title">
                        Built-in keys
                        <span class="vkbd-actions">
                            <button class="vkbd-text-btn" onClick={() => this.toggleAllBuiltin(true)}>
                                Enable all
                            </button>
                            <button class="vkbd-text-btn" onClick={() => this.toggleAllBuiltin(false)}>
                                Disable all
                            </button>
                        </span>
                    </div>
                    <div class="vkbd-grid">
                        {ROWS.map((row, ri) =>
                            row.keys.map((k, ki) => {
                                const id = keyId(ri, ki, k);
                                const isDisabled = disabled.has(id);
                                return (
                                    <label key={id} class={`vkbd-check ${isDisabled ? 'off' : ''}`}>
                                        <input
                                            type="checkbox"
                                            checked={!isDisabled}
                                            onChange={() => this.toggleBuiltin(id)}
                                        />
                                        <span>{k.label}</span>
                                        {k.sub ? <em>{k.sub}</em> : null}
                                    </label>
                                );
                            })
                        )}
                    </div>
                </div>

                <div class="vkbd-section">
                    <div class="vkbd-section-title">Custom combos</div>
                    {settings.custom.length === 0 ? (
                        <div class="vkbd-empty">No custom combos yet.</div>
                    ) : (
                        <div class="vkbd-custom-list">
                            {settings.custom.map(k => (
                                <div key={k.id} class="vkbd-custom-item">
                                    <span class="vkbd-custom-label">
                                        <strong>{k.label}</strong>
                                        {k.sub ? <em> {k.sub}</em> : null}
                                    </span>
                                    <span class="vkbd-custom-preview">
                                        {k.action.type === 'send'
                                            ? encodeForDisplay(k.action.bytes)
                                            : k.action.type === 'text'
                                            ? `text: ${k.action.text}`
                                            : k.action.type}
                                    </span>
                                    <button class="vkbd-text-btn" onClick={() => this.startEdit(k)}>
                                        Edit
                                    </button>
                                    <button class="vkbd-text-btn danger" onClick={() => this.deleteCustom(k.id)}>
                                        Del
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div class="vkbd-form">
                        <div class="vkbd-form-title">{s.editingId ? 'Edit combo' : 'Add new combo'}</div>
                        <div class="vkbd-form-row">
                            <input
                                type="text"
                                placeholder="Label (e.g. ^⇧C)"
                                value={s.label}
                                onInput={e => this.setState({ label: (e.target as HTMLInputElement).value })}
                            />
                            <input
                                type="text"
                                placeholder="Sub (optional)"
                                value={s.sub}
                                onInput={e => this.setState({ sub: (e.target as HTMLInputElement).value })}
                            />
                        </div>
                        <div class="vkbd-form-row">
                            <label>
                                <input
                                    type="radio"
                                    name="mode"
                                    checked={s.mode === 'raw'}
                                    onChange={() => this.setState({ mode: 'raw' })}
                                />
                                Raw bytes
                            </label>
                            <label>
                                <input
                                    type="radio"
                                    name="mode"
                                    checked={s.mode === 'text'}
                                    onChange={() => this.setState({ mode: 'text' })}
                                />
                                Text
                            </label>
                            <label>
                                <input
                                    type="radio"
                                    name="mode"
                                    checked={s.mode === 'key'}
                                    onChange={() => this.setState({ mode: 'key' })}
                                />
                                Key + mods
                            </label>
                        </div>
                        {s.mode === 'raw' ? (
                            <div class="vkbd-form-row">
                                <input
                                    type="text"
                                    class="wide"
                                    placeholder={'Escape seq, e.g. \\x1b[A or \\x03'}
                                    value={s.rawBytes}
                                    onInput={e => this.setState({ rawBytes: (e.target as HTMLInputElement).value })}
                                />
                            </div>
                        ) : null}
                        {s.mode === 'text' ? (
                            <div class="vkbd-form-row">
                                <input
                                    type="text"
                                    class="wide"
                                    placeholder={'Text to type (supports \\n, \\t)'}
                                    value={s.text}
                                    onInput={e => this.setState({ text: (e.target as HTMLInputElement).value })}
                                />
                            </div>
                        ) : null}
                        {s.mode === 'key' ? (
                            <div class="vkbd-form-row">
                                <select
                                    value={s.namedKey}
                                    onChange={e =>
                                        this.setState({ namedKey: (e.target as HTMLSelectElement).value as NamedKey })
                                    }
                                >
                                    {NAMED_OPTIONS.map(n => (
                                        <option key={n} value={n}>
                                            {n}
                                        </option>
                                    ))}
                                </select>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={s.ctrl}
                                        onChange={e => this.setState({ ctrl: (e.target as HTMLInputElement).checked })}
                                    />{' '}
                                    Ctrl
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={s.shift}
                                        onChange={e => this.setState({ shift: (e.target as HTMLInputElement).checked })}
                                    />{' '}
                                    Shift
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={s.alt}
                                        onChange={e => this.setState({ alt: (e.target as HTMLInputElement).checked })}
                                    />{' '}
                                    Alt
                                </label>
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={s.meta}
                                        onChange={e => this.setState({ meta: (e.target as HTMLInputElement).checked })}
                                    />{' '}
                                    Meta
                                </label>
                            </div>
                        ) : null}
                        <div class="vkbd-form-row right">
                            {s.editingId ? (
                                <button class="vkbd-text-btn" onClick={this.cancelForm}>
                                    Cancel
                                </button>
                            ) : null}
                            <button class="vkbd-primary-btn" onClick={this.saveForm}>
                                {s.editingId ? 'Save' : 'Add'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }
}
