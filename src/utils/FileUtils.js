// @ts-check

export function isMediaFile(filename) {
    const mediaExtensions = [
        '.mp4',
        '.webm',
        '.avi',
        '.mov',
        '.wmv',
        '.flv',
        '.mkv',
        '.mp3',
        '.wav',
        '.ogg',
        '.aac',
        '.flac',
        '.m4a',
        '.gif'
    ]; // Include GIF as it can be large
    return mediaExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
}

export function getContentType(filename) {
    const ext = filename.toLowerCase().split('.').pop();
    const mimeTypes = {
        // Documents
        html: 'text/html',
        htm: 'text/html',
        css: 'text/css',
        js: 'application/javascript',
        mjs: 'application/javascript',
        json: 'application/json',
        xml: 'application/xml',
        txt: 'text/plain',
        md: 'text/markdown',
        pdf: 'application/pdf',
        // Images
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        svg: 'image/svg+xml',
        webp: 'image/webp',
        ico: 'image/x-icon',
        // Fonts
        woff: 'font/woff',
        woff2: 'font/woff2',
        ttf: 'font/ttf',
        otf: 'font/otf',
        eot: 'application/vnd.ms-fontobject',
        // Video formats
        mp4: 'video/mp4',
        webm: 'video/webm',
        avi: 'video/avi',
        mov: 'video/quicktime',
        wmv: 'video/x-ms-wmv',
        flv: 'video/x-flv',
        mkv: 'video/x-matroska',
        // Audio formats
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        ogg: 'audio/ogg',
        aac: 'audio/aac',
        flac: 'audio/flac',
        m4a: 'audio/mp4'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

export function getFileBufferWithTimeout(file, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error(`File buffer timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        file.getBuffer((err, buffer) => {
            clearTimeout(timeout);
            if (err) {
                reject(err);
            } else {
                resolve(buffer);
            }
        });
    });
}

export function getFileBuffer(file) {
    return new Promise((resolve, reject) => {
        file.getBuffer((err, buffer) => {
            if (err) {
                reject(err);
            } else {
                resolve(buffer);
            }
        });
    });
}

export function isTextFile(filename) {
    const textExtensions = ['.html', '.css', '.js', '.json', '.txt', '.md', '.xml', '.svg'];
    return textExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
}