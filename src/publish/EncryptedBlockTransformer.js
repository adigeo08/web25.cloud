// @ts-check

import { createBlockKey, encryptHtmlBlock } from '../crypto/BlockEncryptionService.js';

/**
 * @param {File[]} files
 */
export async function transformFilesWithEncryptedBlocks(files) {
    const transformedFiles = [];
    const blockKeyRegistry = new Map();

    for (const file of files) {
        const path = file.webkitRelativePath || file.name;
        if (!path.toLowerCase().endsWith('.html')) {
            transformedFiles.push(file);
            continue;
        }

        const html = await file.text();
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const privateBlocks = doc.querySelectorAll('[data-web25-encrypt]');

        for (const block of privateBlocks) {
            const blockId = block.getAttribute('data-web25-encrypt')?.trim();
            if (!blockId) continue;

            const keyId = `${blockId}:1`;
            let blockKey = blockKeyRegistry.get(keyId);
            if (!blockKey) {
                blockKey = await createBlockKey();
                blockKeyRegistry.set(keyId, blockKey);
            }

            const plaintextHtml = block.innerHTML;
            const encrypted = await encryptHtmlBlock(plaintextHtml, blockKey);
            const replacement = doc.createElement('div');
            replacement.className = 'web25-encrypted-block';
            replacement.setAttribute('data-block-id', blockId);
            replacement.setAttribute('data-epoch', '1');
            replacement.setAttribute('data-alg', encrypted.alg);
            replacement.setAttribute('data-iv', encrypted.iv);
            replacement.setAttribute('data-ciphertext', encrypted.ciphertext);
            block.replaceWith(replacement);
        }

        const transformedHtml = doc.documentElement.outerHTML;
        const transformedFile = new File([transformedHtml], file.name, {
            type: file.type || 'text/html',
            lastModified: file.lastModified
        });
        if (path && path !== file.name) {
            Object.defineProperty(transformedFile, 'webkitRelativePath', { value: path });
        }
        transformedFiles.push(transformedFile);
    }

    return {
        files: transformedFiles,
        blockKeys: blockKeyRegistry
    };
}
