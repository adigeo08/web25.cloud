// @ts-check
/**
 * Hand files to the Deploy tab from anywhere in the app.
 *
 * The Deploy tab listens for this event and stages what it carries exactly as
 * if a folder had been dropped on it: same checks, same bundle, same
 * `.torrentchain`, same signature. Whoever sends it — the Llama chat's Deploy
 * project — needs to know nothing about deploying, only how to make files.
 *
 * Each file carries its folder-relative path (`project/index.html`) in `path`
 * and `webkitRelativePath`, the shape `<input webkitdirectory>` produces.
 */

export const STAGE_DEPLOY_EVENT = 'web25:stage-deploy';

/**
 * @param {File[]} files
 * @param {{ source?: string, target?: EventTarget }} [options]
 */
export function stageDeployFiles(files, { source = '', target = globalThis } = {}) {
    if (!Array.isArray(files) || files.length === 0) return false;
    target.dispatchEvent(new CustomEvent(STAGE_DEPLOY_EVENT, { detail: { files, source } }));
    return true;
}

/**
 * A File that reads as part of a picked folder.
 * @param {string} path folder-relative, root folder included
 * @param {BlobPart} content
 * @param {string} [type]
 */
export function folderFile(path, content, type = '') {
    const file = new File([content], path.split('/').pop() || path, { type, lastModified: Date.now() });
    for (const key of ['path', 'webkitRelativePath']) {
        try {
            Object.defineProperty(file, key, { value: path });
        } catch (_) {}
    }
    return file;
}
