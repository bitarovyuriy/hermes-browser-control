/**
 * Browser WebSocket -> TransportSocket adapter.
 *
 * Resolved from globalThis so the same module runs in the MV3 service worker
 * and under Node (which has a global WebSocket), with no DOM lib dependency.
 */
export function resolveWebSocketCtor() {
    const ctor = globalThis.WebSocket;
    if (!ctor)
        throw new Error("global WebSocket is unavailable in this runtime");
    return ctor;
}
export function browserSocketFactory(opts = {}) {
    const openTimeoutMs = opts.openTimeoutMs ?? 10_000;
    return (url) => {
        const Ctor = resolveWebSocketCtor();
        const ws = new Ctor(url);
        let opened = false;
        const openTimer = setTimeout(() => {
            if (!opened) {
                try {
                    ws.close(4000, "handshake timeout");
                }
                catch {
                    /* ignore */
                }
            }
        }, openTimeoutMs);
        return {
            send(data) {
                ws.send(data);
            },
            close(code, reason) {
                try {
                    ws.close(code, reason);
                }
                catch {
                    /* ignore */
                }
            },
            onOpen(cb) {
                ws.addEventListener("open", () => {
                    opened = true;
                    clearTimeout(openTimer);
                    cb();
                });
            },
            onMessage(cb) {
                ws.addEventListener("message", (ev) => {
                    const data = ev.data;
                    cb(typeof data === "string" ? data : String(data ?? ""));
                });
            },
            onClose(cb) {
                ws.addEventListener("close", (ev) => {
                    const e = ev;
                    clearTimeout(openTimer);
                    cb(e.code ?? 0, e.reason ?? "");
                });
            },
            onError(cb) {
                ws.addEventListener("error", () => cb(new Error("websocket error")));
            },
        };
    };
}
