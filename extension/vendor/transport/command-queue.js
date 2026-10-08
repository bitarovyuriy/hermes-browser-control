/**
 * Outbound command queue.
 *
 * Buffers envelopes produced while the socket is down and flushes them in order
 * once the session is authenticated. Backed by an injected StorageAdapter, which
 * in the extension is `chrome.storage.session` — so the queue survives a forced
 * service-worker restart while the ticket (memory only) does not.
 */
import { QUEUE_STORAGE_KEY } from "./types.js";
export class CommandQueue {
    #storage;
    #key;
    #max;
    #now;
    #items = null;
    #dropped = 0;
    constructor(storage, opts = {}) {
        this.#storage = storage;
        this.#key = opts.key ?? QUEUE_STORAGE_KEY;
        this.#max = opts.max ?? 200;
        this.#now = opts.now ?? (() => Date.now());
    }
    get dropped() {
        return this.#dropped;
    }
    async load() {
        if (this.#items)
            return this.#items;
        const raw = await this.#storage.get(this.#key);
        this.#items = Array.isArray(raw) ? raw.filter((i) => i && typeof i.id === "string") : [];
        return this.#items;
    }
    async size() {
        return (await this.load()).length;
    }
    async enqueue(envelope, id) {
        const items = await this.load();
        items.push({
            id: id ?? `${this.#now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
            envelope,
            queuedAt: this.#now(),
        });
        while (items.length > this.#max) {
            items.shift();
            this.#dropped += 1;
        }
        await this.#persist();
        return items;
    }
    /** Send everything in order; stop at the first failure and keep the remainder. */
    async flush(send) {
        const items = await this.load();
        let sent = 0;
        while (items.length > 0) {
            const head = items[0];
            try {
                await send(head.envelope, head);
            }
            catch {
                break;
            }
            items.shift();
            sent += 1;
        }
        await this.#persist();
        return sent;
    }
    async clear() {
        this.#items = [];
        await this.#storage.remove(this.#key);
    }
    async #persist() {
        const items = this.#items ?? [];
        if (items.length === 0) {
            await this.#storage.remove(this.#key);
            return;
        }
        await this.#storage.set(this.#key, items);
    }
}
