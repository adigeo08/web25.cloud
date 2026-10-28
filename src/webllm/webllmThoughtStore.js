// @ts-check
/**
 * The sequence thinker's memory: thoughts, in this browser's IndexedDB.
 *
 * Modelled on durable-thinking's ThoughtStore (github.com/linxule/durable-thinking,
 * src/thought-store.ts), which keeps sequential-thinking sessions in a Durable
 * Object's SQLite. The same records and rules, on IndexedDB, in the page:
 *
 *   sequences  { sequenceId, conversationId, messageId, title, createdAt, updatedAt,
 *                completed, thoughtCount, lastThoughtNumber, totalThoughts,
 *                lastThoughtPreview, branches: [{ branchId, parentBranchId,
 *                branchFromThought, createdAt }] }
 *   thoughts   { id, ordinal, sequenceId, conversationId, thought, thoughtNumber,
 *                totalThoughts, nextThoughtNeeded, isRevision, revisesThought,
 *                branchFromThought, branchId, needsMoreThoughts, clientRequestId,
 *                fingerprint, vectorKey, createdAt }
 *
 * and the same rules: thought numbers are scoped to a branch; a revision names
 * a thought that exists on its branch or the branches it forked from; a branch
 * starts from a thought that exists; a `clientRequestId` makes an append
 * idempotent (the same payload returns the stored thought, a different one is
 * a conflict); a sequence is completed when a thought says no next thought is
 * needed, and reopened by the next one. Every call returns
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`.
 *
 * Unlike the original, each sequence belongs to a chat conversation (one per
 * Thinking reply) and goes when the conversation is deleted or expires.
 *
 * Recall: every thought is also embedded on the CPU (thoughtEmbedding.js) and
 * put in an idb-vector store, so a step can be shown the earlier thoughts most
 * like it rather than just the latest. Without idb-vector (offline, or a
 * failed hash check) recall falls back to recency. Nothing here uses the GPU.
 *
 * One database per wallet, named after a hash of the address, like the chat
 * history.
 */

import { embedText, similarity } from './thoughtEmbedding.js';

export const WEBLLM_THOUGHTS_DB_PREFIX = 'web25-webllm-thoughts-';
export const WEBLLM_THOUGHT_VECTORS_DB_PREFIX = 'web25-webllm-thought-vectors-';
const DB_VERSION = 1;

export const MAIN_BRANCH_ID = 'main';
export const MAX_THOUGHT_TEXT_LENGTH = 20000;
export const MAX_SEQUENCE_TITLE_LENGTH = 160;
export const MAX_BRANCH_ID_LENGTH = 128;
export const MAX_CLIENT_REQUEST_ID_LENGTH = 128;
export const MAX_THOUGHT_NUMBER = 1000000;
export const MAX_HISTORY_PAGE_SIZE = 100;

/**
 * @typedef {'sequence_not_found'|'thought_not_found'|'branch_not_found'|'branch_point_not_found'|
 *           'branch_conflict'|'branch_id_required'|'revision_target_required'|
 *           'revision_target_not_found'|'idempotency_conflict'|'invalid_input'|'storage_error'} StoreErrorCode
 */
/**
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: { code: StoreErrorCode, message: string } }} StoreResult
 */
/**
 * @typedef {{ id: string, ordinal: number, sequenceId: string, conversationId: string, thought: string,
 *             thoughtNumber: number, totalThoughts: number, nextThoughtNeeded: boolean, isRevision: boolean,
 *             revisesThought: number|null, branchFromThought: number|null, branchId: string,
 *             needsMoreThoughts: boolean, clientRequestId: string|null, fingerprint: string,
 *             vectorKey: any, createdAt: number }} ThoughtRecord
 * @typedef {{ branchId: string, parentBranchId: string, branchFromThought: number, createdAt: number }} BranchRecord
 * @typedef {{ sequenceId: string, conversationId: string, messageId: string|null, title: string,
 *             createdAt: number, updatedAt: number, completed: boolean, thoughtCount: number,
 *             lastThoughtNumber: number, totalThoughts: number, lastThoughtPreview: string,
 *             branches: BranchRecord[] }} SequenceRecord
 * @typedef {{ sequenceId?: string|null, conversationId?: string|null, messageId?: string|null,
 *             sequenceTitle?: string|null, thought: string, nextThoughtNeeded: boolean,
 *             thoughtNumber: number, totalThoughts: number, isRevision?: boolean,
 *             revisesThought?: number|null, branchFromThought?: number|null,
 *             branchFromBranchId?: string|null, branchId?: string, needsMoreThoughts?: boolean,
 *             clientRequestId?: string|null }} AppendThoughtCommand
 * @typedef {{ insert: (object: any) => Promise<any>, delete: (key: any) => Promise<any>,
 *             query: (vector: number[], options: { limit: number }) => Promise<{ object: any, key: any, similarity: number }[]> }} VectorIndex
 */

/** @template T @param {T} value @returns {StoreResult<T>} */
const ok = (value) => ({ ok: true, value });
/** @param {StoreErrorCode} code @param {string} message @returns {{ ok: false, error: { code: StoreErrorCode, message: string } }} */
const failure = (code, message) => ({ ok: false, error: { code, message } });

/** @param {any} value @param {number} [max] */
const positiveInteger = (value, max = MAX_THOUGHT_NUMBER) => Number.isSafeInteger(value) && value >= 1 && value <= max;

/** One line, at most `limit` characters. @param {string} value */
export function thoughtPreview(value, limit = 240) {
    const line = `${value || ''}`.split(/\s+/u).filter(Boolean).join(' ');
    return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`;
}

function randomId(prefix) {
    const id =
        typeof crypto?.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${id}`;
}

/** @param {IDBRequest} request */
function promisify(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function sha256Hex(text) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A wallet's database name: a hash, so the address is never written into it.
 * @param {string} walletAddress
 * @param {string} prefix
 */
export async function thoughtsDatabaseName(walletAddress, prefix = WEBLLM_THOUGHTS_DB_PREFIX) {
    const normalized = `${walletAddress || ''}`.trim().toLowerCase();
    if (!normalized) throw new Error('A wallet address is required to open the thought store.');
    return prefix + (await sha256Hex(`web25-webllm-thoughts:${normalized}`)).slice(0, 32);
}

/**
 * The command with every optional field filled in.
 * @param {AppendThoughtCommand} command
 */
function normalizeCommand(command) {
    return {
        sequenceId: command.sequenceId ?? null,
        conversationId: command.conversationId ?? null,
        messageId: command.messageId ?? null,
        sequenceTitle: command.sequenceTitle ?? null,
        thought: `${command.thought ?? ''}`,
        nextThoughtNeeded: Boolean(command.nextThoughtNeeded),
        thoughtNumber: command.thoughtNumber,
        totalThoughts: command.totalThoughts,
        isRevision: Boolean(command.isRevision),
        revisesThought: command.revisesThought ?? null,
        branchFromThought: command.branchFromThought ?? null,
        branchFromBranchId: command.branchFromBranchId ?? null,
        branchId: command.branchId || MAIN_BRANCH_ID,
        needsMoreThoughts: Boolean(command.needsMoreThoughts),
        clientRequestId: command.clientRequestId ?? null
    };
}

/** What makes two appends the same append. @param {ReturnType<typeof normalizeCommand>} command */
function fingerprintOf(command) {
    return sha256Hex(
        JSON.stringify([
            command.sequenceTitle === null ? null : thoughtPreview(command.sequenceTitle, MAX_SEQUENCE_TITLE_LENGTH),
            command.thought,
            command.nextThoughtNeeded,
            command.thoughtNumber,
            Math.max(command.totalThoughts, command.thoughtNumber),
            command.isRevision,
            command.revisesThought,
            command.branchFromThought,
            command.branchFromBranchId,
            command.branchId,
            command.needsMoreThoughts
        ])
    );
}

/**
 * Which branch holds thought `number`, looking from `branchId` up through the
 * branches it forked from — each only up to its fork point. The nearest wins.
 *
 * @param {SequenceRecord} sequence
 * @param {ThoughtRecord[]} thoughts
 * @param {string} branchId
 * @param {number} number
 * @param {number|null} [cutoff]
 * @returns {string|null}
 */
export function resolveThoughtInChain(sequence, thoughts, branchId, number, cutoff = null) {
    let current = branchId;
    let limit = cutoff ?? Number.MAX_SAFE_INTEGER;
    for (let depth = 0; depth < 64; depth += 1) {
        const owner = current;
        if (number <= limit && thoughts.some((t) => t.branchId === owner && t.thoughtNumber === number)) return owner;
        if (owner === MAIN_BRANCH_ID) return null;
        const branch = sequence.branches.find((entry) => entry.branchId === owner);
        if (!branch) return null;
        limit = Math.min(limit, branch.branchFromThought);
        current = branch.parentBranchId || MAIN_BRANCH_ID;
    }
    return null;
}

/**
 * The checks durable-thinking makes before an append, against one sequence.
 * @param {ReturnType<typeof normalizeCommand>} command
 * @param {SequenceRecord|null} sequence
 * @param {ThoughtRecord[]} thoughts the sequence's thoughts
 * @returns {StoreResult<{ forkParentBranchId: string|null }>}
 */
function validateAppend(command, sequence, thoughts) {
    if (!command.thought.trim() || command.thought.length > MAX_THOUGHT_TEXT_LENGTH) {
        return failure('invalid_input', `A thought must be 1 to ${MAX_THOUGHT_TEXT_LENGTH} characters.`);
    }
    if (!positiveInteger(command.thoughtNumber) || !positiveInteger(command.totalThoughts)) {
        return failure('invalid_input', 'thoughtNumber and totalThoughts must be positive integers.');
    }
    if (!command.branchId || command.branchId.length > MAX_BRANCH_ID_LENGTH) {
        return failure('invalid_input', 'branchId is not valid.');
    }
    if (command.clientRequestId !== null && command.clientRequestId.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
        return failure('invalid_input', 'clientRequestId is too long.');
    }
    if (command.isRevision && command.revisesThought === null) {
        return failure('revision_target_required', 'A revision must name the thought it revises.');
    }
    if (!command.isRevision && command.revisesThought !== null) {
        return failure('invalid_input', 'revisesThought may only be supplied when isRevision is true.');
    }
    if (command.revisesThought !== null && !positiveInteger(command.revisesThought)) {
        return failure('invalid_input', 'revisesThought must be a positive integer.');
    }
    if (command.branchFromThought !== null && command.branchId === MAIN_BRANCH_ID) {
        return failure('branch_id_required', `A non-${MAIN_BRANCH_ID} branchId is required to branch.`);
    }

    if (!sequence) {
        if (command.sequenceId !== null) {
            return failure('sequence_not_found', `No thought sequence exists with ID ${command.sequenceId}.`);
        }
        if (!command.conversationId) return failure('invalid_input', 'A new sequence needs a conversationId.');
        if (command.branchId !== MAIN_BRANCH_ID || command.branchFromThought !== null) {
            return failure('branch_point_not_found', 'A new sequence cannot begin on a branch.');
        }
        if (command.isRevision) {
            return failure('revision_target_not_found', 'A new sequence cannot begin with a revision.');
        }
        return ok({ forkParentBranchId: null });
    }

    let forkParentBranchId = null;
    let scope = command.branchId;
    let scopeCutoff = null;
    if (command.branchId !== MAIN_BRANCH_ID) {
        const existing = sequence.branches.find((entry) => entry.branchId === command.branchId);
        if (!existing) {
            if (command.branchFromThought === null) {
                return failure(
                    'branch_not_found',
                    `Branch ${command.branchId} does not exist. Supply branchFromThought to create it.`
                );
            }
            const source = command.branchFromBranchId ?? MAIN_BRANCH_ID;
            if (source === command.branchId) {
                return failure('invalid_input', 'branchFromBranchId cannot equal the branch being created.');
            }
            if (source !== MAIN_BRANCH_ID && !sequence.branches.some((entry) => entry.branchId === source)) {
                return failure('branch_not_found', `branchFromBranchId ${source} does not exist.`);
            }
            const owner = resolveThoughtInChain(sequence, thoughts, source, command.branchFromThought);
            if (owner === null) {
                return failure(
                    'branch_point_not_found',
                    `Thought ${command.branchFromThought} does not exist on ${source} or its ancestors.`
                );
            }
            forkParentBranchId = owner;
            scope = owner;
            scopeCutoff = command.branchFromThought;
        } else if (command.branchFromThought !== null && command.branchFromThought !== existing.branchFromThought) {
            return failure(
                'branch_conflict',
                `Branch ${command.branchId} already starts from thought ${existing.branchFromThought}.`
            );
        }
    } else if (command.branchFromBranchId !== null) {
        return failure('invalid_input', 'branchFromBranchId may only be supplied when writing to a branch.');
    }

    if (
        command.revisesThought !== null &&
        resolveThoughtInChain(sequence, thoughts, scope, command.revisesThought, scopeCutoff) === null
    ) {
        return failure(
            'revision_target_not_found',
            `Thought ${command.revisesThought} does not exist on ${command.branchId} or its ancestors.`
        );
    }
    return ok({ forkParentBranchId });
}

export class WebLLMThoughtStore {
    /**
     * @param {IDBDatabase} db
     * @param {{ now?: () => number, vectors?: Promise<VectorIndex|null> | null, embed?: (text: string) => number[] }} [options]
     */
    constructor(db, { now = () => Date.now(), vectors = null, embed = embedText } = {}) {
        this.db = db;
        this.now = now;
        /** idb-vector, once (and if) it loads. */
        this.vectors = Promise.resolve(vectors).catch(() => null);
        this.embed = embed;
        /** Ordinals keep the order thoughts were written in, across sequences and sessions. */
        this.ordinal = 0;
    }

    /**
     * One transaction, to completion.
     * @template T
     * @param {string[]} stores
     * @param {'readonly'|'readwrite'} mode
     * @param {(tx: IDBTransaction) => Promise<T>} work
     * @returns {Promise<T>}
     */
    async run(stores, mode, work) {
        const tx = this.db.transaction(stores, mode);
        const done = new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve(undefined);
            tx.onabort = () => reject(tx.error || new Error('The thought store could not be written.'));
            tx.onerror = () => reject(tx.error || new Error('The thought store could not be written.'));
        });
        const result = await work(tx);
        await done;
        return result;
    }

    /** @param {string} sequenceId @returns {Promise<SequenceRecord|null>} */
    async sequence(sequenceId) {
        return (
            (await this.run(['sequences'], 'readonly', (tx) =>
                promisify(tx.objectStore('sequences').get(sequenceId))
            )) || null
        );
    }

    /** A sequence's thoughts, in the order written. @param {string} sequenceId @returns {Promise<ThoughtRecord[]>} */
    async thoughtsOf(sequenceId) {
        const rows = await this.run(['thoughts'], 'readonly', (tx) =>
            promisify(tx.objectStore('thoughts').index('bySequence').getAll(sequenceId))
        );
        return /** @type {ThoughtRecord[]} */ (rows).sort((a, b) => a.ordinal - b.ordinal);
    }

    /**
     * Add a thought, creating its sequence (and branch) as needed.
     * @param {AppendThoughtCommand} input
     * @returns {Promise<StoreResult<{ sequenceId: string, thought: ThoughtRecord, sequence: SequenceRecord,
     *           deduplicated: boolean, reopened: boolean, numberReused: boolean }>>}
     */
    async appendThought(input) {
        const command = normalizeCommand(input);
        try {
            const fingerprint = await fingerprintOf(command);
            const existingSequence = command.sequenceId ? await this.sequence(command.sequenceId) : null;
            const thoughts = existingSequence ? await this.thoughtsOf(existingSequence.sequenceId) : [];
            const validation = validateAppend(command, existingSequence, thoughts);
            if (!validation.ok) return validation;

            if (command.clientRequestId !== null) {
                const duplicates = await this.run(['thoughts'], 'readonly', (tx) =>
                    promisify(tx.objectStore('thoughts').index('byClientRequest').getAll(command.clientRequestId))
                );
                const duplicate = /** @type {ThoughtRecord|undefined} */ (duplicates[0]);
                if (duplicate) {
                    const sameSequence = command.sequenceId === null || command.sequenceId === duplicate.sequenceId;
                    if (!sameSequence || duplicate.fingerprint !== fingerprint) {
                        return failure(
                            'idempotency_conflict',
                            `clientRequestId ${command.clientRequestId} was already used for a different thought.`
                        );
                    }
                    const sequence = await this.sequence(duplicate.sequenceId);
                    return ok({
                        sequenceId: duplicate.sequenceId,
                        thought: duplicate,
                        sequence: /** @type {SequenceRecord} */ (sequence),
                        deduplicated: true,
                        reopened: false,
                        numberReused: false
                    });
                }
            }

            const now = this.now();
            const sequenceId = existingSequence?.sequenceId ?? randomId('seq');
            const totalThoughts = Math.max(command.totalThoughts, command.thoughtNumber);
            const reopened = Boolean(existingSequence?.completed);
            const numberReused =
                existingSequence !== null &&
                !command.isRevision &&
                thoughts.some((t) => t.branchId === command.branchId && t.thoughtNumber === command.thoughtNumber);

            /** @type {SequenceRecord} */
            const sequence = existingSequence
                ? {
                      ...existingSequence,
                      title:
                          command.sequenceTitle === null
                              ? existingSequence.title
                              : thoughtPreview(command.sequenceTitle, MAX_SEQUENCE_TITLE_LENGTH),
                      branches: [...existingSequence.branches]
                  }
                : {
                      sequenceId,
                      conversationId: /** @type {string} */ (command.conversationId),
                      messageId: command.messageId,
                      title: thoughtPreview(command.sequenceTitle ?? command.thought, MAX_SEQUENCE_TITLE_LENGTH),
                      createdAt: now,
                      updatedAt: now,
                      completed: false,
                      thoughtCount: 0,
                      lastThoughtNumber: 0,
                      totalThoughts: 0,
                      lastThoughtPreview: '',
                      branches: []
                  };
            if (
                command.branchId !== MAIN_BRANCH_ID &&
                command.branchFromThought !== null &&
                !sequence.branches.some((entry) => entry.branchId === command.branchId)
            ) {
                sequence.branches.push({
                    branchId: command.branchId,
                    parentBranchId: validation.value.forkParentBranchId || MAIN_BRANCH_ID,
                    branchFromThought: command.branchFromThought,
                    createdAt: now
                });
            }
            Object.assign(sequence, {
                updatedAt: now,
                completed: !command.nextThoughtNeeded,
                thoughtCount: sequence.thoughtCount + 1,
                lastThoughtNumber: command.thoughtNumber,
                totalThoughts,
                lastThoughtPreview: thoughtPreview(command.thought)
            });

            // Increasing across sequences and sessions: the clock, kept strictly ahead.
            this.ordinal = Math.max(this.ordinal + 1, now * 1000, ...thoughts.map((t) => t.ordinal + 1));
            /** @type {ThoughtRecord} */
            const thought = {
                id: randomId('thought'),
                ordinal: this.ordinal,
                sequenceId,
                conversationId: sequence.conversationId,
                thought: command.thought,
                thoughtNumber: command.thoughtNumber,
                totalThoughts,
                nextThoughtNeeded: command.nextThoughtNeeded,
                isRevision: command.isRevision,
                revisesThought: command.revisesThought,
                branchFromThought: command.branchFromThought,
                branchId: command.branchId,
                needsMoreThoughts: command.needsMoreThoughts,
                clientRequestId: command.clientRequestId,
                fingerprint,
                vectorKey: null,
                createdAt: now
            };
            await this.run(['sequences', 'thoughts'], 'readwrite', async (tx) => {
                await promisify(tx.objectStore('sequences').put(sequence));
                await promisify(tx.objectStore('thoughts').put(thought));
            });

            // The thought is stored; its vector is an index, kept best-effort.
            thought.vectorKey = await this.index(thought);
            if (thought.vectorKey !== null) {
                await this.run(['thoughts'], 'readwrite', (tx) => promisify(tx.objectStore('thoughts').put(thought)));
            }
            return ok({ sequenceId, thought, sequence, deduplicated: false, reopened, numberReused });
        } catch (error) {
            return failure('storage_error', `The thought could not be stored: ${error?.message || error}`);
        }
    }

    /** Put a thought's vector in idb-vector. @param {ThoughtRecord} thought */
    async index(thought) {
        const vectors = await this.vectors;
        if (!vectors) return null;
        try {
            return await vectors.insert({
                embedding: this.embed(thought.thought),
                thoughtId: thought.id,
                sequenceId: thought.sequenceId,
                conversationId: thought.conversationId
            });
        } catch (_) {
            return null;
        }
    }

    /** @param {string} sequenceId */
    async getSequenceState(sequenceId) {
        try {
            const sequence = await this.sequence(sequenceId);
            if (!sequence) return failure('sequence_not_found', `No thought sequence exists with ID ${sequenceId}.`);
            return ok({
                sequenceId,
                completed: sequence.completed,
                thoughtHistoryLength: sequence.thoughtCount,
                lastThoughtNumber: sequence.lastThoughtNumber,
                totalThoughts: sequence.totalThoughts
            });
        } catch (error) {
            return failure('storage_error', `The sequence could not be read: ${error?.message || error}`);
        }
    }

    /**
     * A page of a sequence's thoughts, oldest or newest first, optionally one branch.
     * @param {{ sequenceId: string, limit?: number, cursor?: number|null, order?: 'asc'|'desc', branchId?: string|null }} command
     */
    async getHistory({ sequenceId, limit = 25, cursor = null, order = 'asc', branchId = null }) {
        if (!positiveInteger(limit, MAX_HISTORY_PAGE_SIZE)) {
            return failure('invalid_input', `limit must be 1 to ${MAX_HISTORY_PAGE_SIZE}.`);
        }
        try {
            const sequence = await this.sequence(sequenceId);
            if (!sequence) return failure('sequence_not_found', `No thought sequence exists with ID ${sequenceId}.`);
            let thoughts = await this.thoughtsOf(sequenceId);
            if (branchId !== null) thoughts = thoughts.filter((t) => t.branchId === branchId);
            if (order === 'desc') thoughts.reverse();
            const after =
                cursor === null
                    ? thoughts
                    : thoughts.filter((t) => (order === 'asc' ? t.ordinal > cursor : t.ordinal < cursor));
            const page = after.slice(0, limit);
            const hasMore = after.length > page.length;
            return ok({
                sequence,
                thoughts: page,
                matchingThoughtCount: thoughts.length,
                hasMore,
                nextCursor: hasMore ? page[page.length - 1].ordinal : null,
                order,
                branchId
            });
        } catch (error) {
            return failure('storage_error', `The history could not be read: ${error?.message || error}`);
        }
    }

    /**
     * One thought by id, or every thought with a number (on a branch, or all branches).
     * @param {{ sequenceId: string, thoughtId?: string|null, thoughtNumber?: number|null, branchId?: string|null }} command
     */
    async getThought({ sequenceId, thoughtId = null, thoughtNumber = null, branchId = null }) {
        if ((thoughtId === null) === (thoughtNumber === null)) {
            return failure('invalid_input', 'Name a thought by thoughtId or by thoughtNumber.');
        }
        try {
            const sequence = await this.sequence(sequenceId);
            if (!sequence) return failure('sequence_not_found', `No thought sequence exists with ID ${sequenceId}.`);
            const thoughts = (await this.thoughtsOf(sequenceId)).filter((t) =>
                thoughtId !== null
                    ? t.id === thoughtId
                    : t.thoughtNumber === thoughtNumber && (branchId === null || t.branchId === branchId)
            );
            if (thoughts.length === 0) return failure('thought_not_found', 'No such thought in this sequence.');
            return ok({ sequence, thoughts });
        } catch (error) {
            return failure('storage_error', `The thought could not be read: ${error?.message || error}`);
        }
    }

    /**
     * Sequences, most recently updated first.
     * @param {{ conversationId?: string|null, limit?: number, offset?: number, status?: 'all'|'active'|'completed' }} [command]
     */
    async listSequences({ conversationId = null, limit = 25, offset = 0, status = 'all' } = {}) {
        try {
            /** @type {SequenceRecord[]} */
            const all = await this.run(['sequences'], 'readonly', (tx) =>
                promisify(
                    conversationId === null
                        ? tx.objectStore('sequences').getAll()
                        : tx.objectStore('sequences').index('byConversation').getAll(conversationId)
                )
            );
            const matching = all
                .filter((s) => status === 'all' || (status === 'completed') === s.completed)
                .sort((a, b) => b.updatedAt - a.updatedAt);
            const sequences = matching.slice(offset, offset + limit);
            return ok({
                sequences,
                total: matching.length,
                limit,
                offset,
                hasMore: offset + sequences.length < matching.length
            });
        } catch (error) {
            return failure('storage_error', `The sequences could not be listed: ${error?.message || error}`);
        }
    }

    /** @param {string} sequenceId */
    async deleteSequence(sequenceId) {
        try {
            const thoughts = await this.thoughtsOf(sequenceId);
            const existed = Boolean(await this.sequence(sequenceId));
            await this.run(['sequences', 'thoughts'], 'readwrite', async (tx) => {
                for (const thought of thoughts) tx.objectStore('thoughts').delete(thought.id);
                await promisify(tx.objectStore('sequences').delete(sequenceId));
            });
            await this.unindex(thoughts);
            return ok({ sequenceId, deleted: existed, deletedThoughts: thoughts.length });
        } catch (error) {
            return failure('storage_error', `The sequence could not be deleted: ${error?.message || error}`);
        }
    }

    /** Every sequence of a conversation. @param {string} conversationId */
    async deleteConversation(conversationId) {
        const listed = await this.listSequences({ conversationId, limit: Number.MAX_SAFE_INTEGER });
        if (!listed.ok) return listed;
        let deletedThoughts = 0;
        for (const sequence of listed.value.sequences) {
            const result = await this.deleteSequence(sequence.sequenceId);
            if (result.ok) deletedThoughts += result.value.deletedThoughts;
        }
        return ok({ conversationId, deletedSequences: listed.value.sequences.length, deletedThoughts });
    }

    /**
     * Delete the sequences whose conversation is gone, or that are older than retention.
     * @param {{ keepConversationIds?: Set<string>|null, retentionMs?: number|null }} options
     */
    async purge({ keepConversationIds = null, retentionMs = null }) {
        const listed = await this.listSequences({ limit: Number.MAX_SAFE_INTEGER });
        if (!listed.ok) return 0;
        const cutoff = retentionMs === null ? null : this.now() - retentionMs;
        let purged = 0;
        for (const sequence of listed.value.sequences) {
            const orphan = keepConversationIds !== null && !keepConversationIds.has(sequence.conversationId);
            const expired = cutoff !== null && sequence.updatedAt < cutoff;
            if ((orphan || expired) && (await this.deleteSequence(sequence.sequenceId)).ok) purged += 1;
        }
        return purged;
    }

    /** @param {ThoughtRecord[]} thoughts */
    async unindex(thoughts) {
        const vectors = await this.vectors;
        if (!vectors) return;
        for (const thought of thoughts) {
            if (thought.vectorKey === null || thought.vectorKey === undefined) continue;
            await vectors.delete(thought.vectorKey).catch(() => {});
        }
    }

    /**
     * The earlier thoughts most like `query`, from one conversation, the given
     * sequence's first. Similarity comes from idb-vector's index; a thought it
     * does not have (or every thought, without it) is compared here, on the
     * CPU, with the same embedding. Returned oldest first, as they were thought.
     *
     * @param {{ query: string, conversationId: string, sequenceId?: string|null, limit?: number,
     *           exclude?: Set<string> }} options
     * @returns {Promise<ThoughtRecord[]>}
     */
    async recall({ query, conversationId, sequenceId = null, limit = 4, exclude = new Set() }) {
        const candidates = await this.run(['thoughts'], 'readonly', (tx) =>
            promisify(tx.objectStore('thoughts').getAll())
        );
        /** @type {ThoughtRecord[]} */
        const pool = candidates.filter((t) => t.conversationId === conversationId && !exclude.has(t.id));
        if (pool.length === 0) return [];

        const vectors = await this.vectors;
        /** @type {Map<string, number>} */
        const scores = new Map();
        if (vectors) {
            try {
                const hits = await vectors.query(this.embed(query), { limit: Math.max(limit * 8, 32) });
                for (const hit of hits) scores.set(hit.object?.thoughtId, hit.similarity);
            } catch (_) {
                scores.clear();
            }
        }
        const vector = this.embed(query);
        const scored = pool.map((t) => ({
            thought: t,
            score:
                (scores.get(t.id) ?? similarity(vector, this.embed(t.thought))) +
                // The current sequence's thoughts come before older sequences'.
                (t.sequenceId === sequenceId ? 1 : 0)
        }));
        scored.sort((a, b) => b.score - a.score);
        return scored
            .slice(0, limit)
            .map((entry) => entry.thought)
            .sort((a, b) => a.ordinal - b.ordinal);
    }

    close() {
        this.db.close();
    }
}

/**
 * Open one wallet's thought store.
 *
 * @param {{ walletAddress: string, indexedDB?: IDBFactory, now?: () => number,
 *           vectors?: ((databaseName: string) => Promise<VectorIndex|null>) | null,
 *           embed?: (text: string) => number[] }} options
 */
export async function openWebLLMThoughts({
    walletAddress,
    indexedDB = globalThis.indexedDB,
    now = () => Date.now(),
    vectors = null,
    embed = embedText
}) {
    if (!indexedDB) throw new Error('IndexedDB is not available in this browser.');
    const name = await thoughtsDatabaseName(walletAddress);
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const database = /** @type {any} */ (event.target).result;
            if (!database.objectStoreNames.contains('sequences')) {
                database
                    .createObjectStore('sequences', { keyPath: 'sequenceId' })
                    .createIndex('byConversation', 'conversationId');
            }
            if (!database.objectStoreNames.contains('thoughts')) {
                const thoughts = database.createObjectStore('thoughts', { keyPath: 'id' });
                thoughts.createIndex('bySequence', 'sequenceId');
                thoughts.createIndex('byClientRequest', 'clientRequestId');
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    // The vector store loads in the background; nothing waits for it but recall.
    const vectorStore = vectors
        ? thoughtsDatabaseName(walletAddress, WEBLLM_THOUGHT_VECTORS_DB_PREFIX).then((vectorName) =>
              vectors(vectorName)
          )
        : null;
    return new WebLLMThoughtStore(db, { now, vectors: vectorStore, embed });
}
