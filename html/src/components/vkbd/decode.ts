export function decodeEscapes(input: string): string {
    let out = '';
    let i = 0;
    while (i < input.length) {
        const ch = input[i];
        if (ch !== '\\') {
            out += ch;
            i++;
            continue;
        }
        const next = input[i + 1];
        switch (next) {
            case 'n':
                out += '\n';
                i += 2;
                break;
            case 'r':
                out += '\r';
                i += 2;
                break;
            case 't':
                out += '\t';
                i += 2;
                break;
            case 'b':
                out += '\b';
                i += 2;
                break;
            case 'f':
                out += '\f';
                i += 2;
                break;
            case 'v':
                out += '\v';
                i += 2;
                break;
            case '0':
                out += '\0';
                i += 2;
                break;
            case 'e':
            case 'E':
                out += '\x1b';
                i += 2;
                break;
            case '\\':
                out += '\\';
                i += 2;
                break;
            case 'x': {
                const hex = input.slice(i + 2, i + 4);
                if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 4;
                } else {
                    out += ch;
                    i++;
                }
                break;
            }
            case 'u': {
                const hex = input.slice(i + 2, i + 6);
                if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                    out += String.fromCharCode(parseInt(hex, 16));
                    i += 6;
                } else {
                    out += ch;
                    i++;
                }
                break;
            }
            default:
                out += ch;
                i++;
                break;
        }
    }
    return out;
}

export function encodeForDisplay(bytes: string): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const code = bytes.charCodeAt(i);
        if (code === 0x1b) out += '\\x1b';
        else if (code === 0x09) out += '\\t';
        else if (code === 0x0a) out += '\\n';
        else if (code === 0x0d) out += '\\r';
        else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
        else out += bytes[i];
    }
    return out;
}
