// @ts-check

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concatChunks(chunks) {
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function parseValue(bytes, indexRef) {
    const token = bytes[indexRef.index];

    if (token === 0x69) {
        indexRef.index += 1;
        const start = indexRef.index;
        while (bytes[indexRef.index] !== 0x65) indexRef.index += 1;
        const num = Number(decoder.decode(bytes.slice(start, indexRef.index)));
        indexRef.index += 1;
        return num;
    }

    if (token === 0x6c) {
        indexRef.index += 1;
        const list = [];
        while (bytes[indexRef.index] !== 0x65) {
            list.push(parseValue(bytes, indexRef));
        }
        indexRef.index += 1;
        return list;
    }

    if (token === 0x64) {
        indexRef.index += 1;
        const dict = {};
        while (bytes[indexRef.index] !== 0x65) {
            const keyBytes = /** @type {Uint8Array} */ (parseValue(bytes, indexRef));
            const key = decoder.decode(keyBytes);
            dict[key] = parseValue(bytes, indexRef);
        }
        indexRef.index += 1;
        return dict;
    }

    if (token >= 0x30 && token <= 0x39) {
        const lenStart = indexRef.index;
        while (bytes[indexRef.index] !== 0x3a) indexRef.index += 1;
        const len = Number(decoder.decode(bytes.slice(lenStart, indexRef.index)));
        indexRef.index += 1;
        const value = bytes.slice(indexRef.index, indexRef.index + len);
        indexRef.index += len;
        return value;
    }

    throw new Error('Invalid bencode token');
}

/** @param {ArrayBuffer | Uint8Array} input */
export function bdecode(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const indexRef = { index: 0 };
    return parseValue(bytes, indexRef);
}

function encodeValue(value) {
    if (typeof value === 'number') {
        return encoder.encode(`i${Math.floor(value)}e`);
    }

    if (typeof value === 'string') {
        const asBytes = encoder.encode(value);
        return concatChunks([encoder.encode(`${asBytes.length}:`), asBytes]);
    }

    if (value instanceof Uint8Array) {
        return concatChunks([encoder.encode(`${value.length}:`), value]);
    }

    if (Array.isArray(value)) {
        const chunks = [new Uint8Array([0x6c])];
        value.forEach((item) => chunks.push(encodeValue(item)));
        chunks.push(new Uint8Array([0x65]));
        return concatChunks(chunks);
    }

    if (value && typeof value === 'object') {
        const obj = /** @type {Record<string, any>} */ (value);
        const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const chunks = [new Uint8Array([0x64])];
        keys.forEach((key) => {
            chunks.push(encodeValue(key));
            chunks.push(encodeValue(obj[key]));
        });
        chunks.push(new Uint8Array([0x65]));
        return concatChunks(chunks);
    }

    throw new Error('Unsupported bencode type');
}

/** @param {any} value */
export function bencode(value) {
    return encodeValue(value);
}

/** @param {Uint8Array | string | undefined} value */
export function decodeUtf8(value) {
    if (!value) return '';
    if (typeof value === 'string') return value;
    return decoder.decode(value);
}
