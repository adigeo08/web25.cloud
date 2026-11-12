// @ts-check
import { sha256 } from '@noble/hashes/sha256';
import { verifyNostrEvent } from '../nostr/nostr.js';
export const PROJECT_KIND = 24136;
export const projectHash = (value) =>
    Array.from(sha256(new TextEncoder().encode(value)), (b) => b.toString(16).padStart(2, '0')).join('');
export function projectRoomId(id, owner) {
    if (!/^[0-9a-f]{64}$/.test(id) || !/^[0-9a-f]{64}$/.test(owner)) throw new Error('Invalid project identity');
    return `prj-${projectHash(`web25-project-room:v1:${id}:${owner}`).slice(0, 32)}`;
}
export function newProjectId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
}
function proofContent(project, publisher) {
    return JSON.stringify({
        domain: 'web25-project-ownership:v1',
        projectId: project.id,
        roomId: project.roomId,
        publisher: publisher.toLowerCase(),
        ownerNostrPubkey: project.ownerNostrPubkey,
        version: project.version,
        previousManifestHash: project.previousManifestHash
    });
}
export function validateProject(project) {
    if (
        !project ||
        Object.keys(project).some(
            (key) =>
                !['id', 'roomId', 'ownerNostrPubkey', 'version', 'previousManifestHash', 'ownershipProof'].includes(key)
        ) ||
        project.roomId !== projectRoomId(project.id, project.ownerNostrPubkey) ||
        !Number.isSafeInteger(project.version) ||
        project.version < 1 ||
        !(project.previousManifestHash === null || /^[0-9a-f]{64}$/.test(project.previousManifestHash)) ||
        (project.version === 1) !== (project.previousManifestHash === null)
    ) {
        throw new Error('Invalid project metadata');
    }
}
export async function signProject(project, publisher, signer) {
    validateProject(project);
    const identity = await signer.getNostrIdentity();
    if (identity.nostrPublicKey !== project.ownerNostrPubkey) throw new Error('Project Nostr owner changed');
    const ownershipProof = await signer.nostrSignEvent({
        kind: PROJECT_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: proofContent(project, publisher)
    });
    const result = { ...project, ownershipProof };
    if (!verifyProject(result, publisher)) throw new Error('Invalid Nostr ownership proof');
    return result;
}
export function verifyProject(project, publisher) {
    try {
        validateProject(project);
        const proof = project.ownershipProof;
        return (
            proof.kind === PROJECT_KIND &&
            proof.pubkey === project.ownerNostrPubkey &&
            proof.tags.length === 0 &&
            proof.content === proofContent(project, publisher) &&
            verifyNostrEvent(proof)
        );
    } catch (_) {
        return false;
    }
}
