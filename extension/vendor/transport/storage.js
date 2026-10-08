/** Storage adapters. The queue lives in `chrome.storage.session`; never the ticket. */
export class MemoryStorageAdapter {
    map = new Map();
    async get(key) {
        return this.map.has(key) ? structuredClone(this.map.get(key)) : undefined;
    }
    async set(key, value) {
        this.map.set(key, structuredClone(value));
    }
    async remove(key) {
        this.map.delete(key);
    }
}
function chromeArea(name) {
    const g = globalThis;
    return g.chrome?.storage?.[name];
}
/** Session-scoped: survives a service-worker restart, dies with the browser session. */
export function chromeSessionStorage() {
    const area = chromeArea("session");
    if (!area)
        throw new Error("chrome.storage.session is unavailable");
    return {
        async get(key) {
            const got = await area.get([key]);
            return got[key];
        },
        async set(key, value) {
            await area.set({ [key]: value });
        },
        async remove(key) {
            await area.remove([key]);
        },
    };
}
/** Persistent: connection settings only. NEVER the ticket. */
export function chromeLocalStorage() {
    const area = chromeArea("local");
    if (!area)
        throw new Error("chrome.storage.local is unavailable");
    return {
        async get(key) {
            const got = await area.get([key]);
            return got[key];
        },
        async set(key, value) {
            await area.set({ [key]: value });
        },
        async remove(key) {
            await area.remove([key]);
        },
    };
}
