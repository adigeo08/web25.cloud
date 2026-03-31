// @ts-check

export function normalizeToTransferableArrayBuffer(input) {
    if (input instanceof ArrayBuffer) {
        return input;
    }

    if (ArrayBuffer.isView(input)) {
        const { buffer, byteOffset, byteLength } = input;
        return buffer.slice(byteOffset, byteOffset + byteLength);
    }

    if (Array.isArray(input)) {
        return new Uint8Array(input).buffer;
    }

    if (input == null) {
        return null;
    }

    return new Uint8Array(input).buffer;
}

