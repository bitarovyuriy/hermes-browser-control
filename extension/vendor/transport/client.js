/**
 * TransportClient — the piece the extension actually runs.
 *
 * Wires the pure connection-state machine to real I/O: pairing, WebSocket,
 * heartbeat, exponential-backoff reconnect, and the outbound command queue.
 * The ticket is held in a private field and is never written to storage or logs.
 */
import { PROTOCOL_VERSION, } from "./types.js";
import { buildEndpoint } from "./config.js";
import { CommandQueue } from "./command-queue.js";
import { initialState, isConnected, makeContext, reduce, } from "./connection-state.js";
import { registerSecret, silentLogger } from "./logger.js";
import { browserSocketFactory } from "./socket.js";
export const realTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
};
function newId() {
    const c = globalThis.crypto;
    if (c?.randomUUID)
        return c.randomUUID();
    return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
export class TransportClient {
    #opts;
    #log;
    #timers;
    #ctx;
    #state;
    #clientId;
    #queue;
    #ticket = null; // memory only — never persisted, never logged
    #socket = null;
    #retryTimer = undefined;
    #heartbeatTimer = undefined;
    #heartbeatMs;
    #heartbeatTimeoutMs;
    #lastInboundAt = 0;
    #pending = new Map();
    #statusListeners = new Set();
    #eventListeners = new Set();
    #queueSize = 0;
    #disposed = false;
    constructor(opts) {
        this.#opts = opts;
        this.#log = opts.logger ?? silentLogger;
        this.#timers = opts.timers ?? realTimers;
        this.#ctx = makeContext({
            backoff: opts.backoff,
            maxAttempts: opts.maxAttempts ?? Number.POSITIVE_INFINITY,
            rand: opts.rand ?? Math.random,
        });
        this.#heartbeatMs = opts.heartbeatMs ?? 20_000;
        this.#heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 45_000;
        this.#clientId = opts.clientId ?? newId();
        const endpoint = buildEndpoint(opts.config);
        const state = initialState(opts.config.mode);
        state.url = opts.url ?? (endpoint.ok ? endpoint.url : null);
        state.mode = opts.config.mode;
        this.#state = state;
        this.#queue = new CommandQueue(opts.storage, { max: opts.queueMax ?? 200 });
    }
    get clientId() {
        return this.#clientId;
    }
    get phase() {
        return this.#state.phase;
    }
    get connected() {
        return isConnected(this.#state);
    }
    get status() {
        return {
            phase: this.#state.phase,
            mode: this.#state.mode,
            attempt: this.#state.attempt,
            sessionId: this.#state.sessionId,
            queueSize: this.#queueSize,
            droppedFromQueue: this.#queue.dropped,
            lastError: this.#state.lastError,
            hasTicket: this.#state.hasTicket,
            url: this.#state.url,
            everConnected: this.#state.everConnected,
            clientId: this.#clientId,
        };
    }
    onStatus(cb) {
        this.#statusListeners.add(cb);
        cb(this.status);
        return () => this.#statusListeners.delete(cb);
    }
    onEvent(cb) {
        this.#eventListeners.add(cb);
        return () => this.#eventListeners.delete(cb);
    }
    // --- lifecycle ------------------------------------------------------------
    async start() {
        if (this.#disposed)
            return;
        await this.#queue.load();
        this.#queueSize = await this.#queue.size();
        this.#dispatch({ type: "start" });
    }
    /** Called from a `chrome.alarms` wakeup: restart the machine if it stalled. */
    ensureAlive() {
        if (this.#disposed)
            return;
        if (this.#state.phase === "reconnecting" || this.#state.phase === "idle" || this.#state.phase === "stopped") {
            this.#dispatch({ type: "connect-now" });
        }
    }
    pause() {
        this.#dispatch({ type: "pause" });
    }
    resume() {
        this.#dispatch({ type: "resume" });
    }
    stop() {
        this.#dispatch({ type: "stop" });
    }
    kill() {
        this.#dispatch({ type: "kill" });
    }
    dispose() {
        this.#disposed = true;
        this.#cancelRetry();
        this.#stopHeartbeat();
        this.#teardownSocket();
        this.#ticket = null;
        this.#failPending(new Error("transport disposed"));
    }
    // --- sending -------------------------------------------------------------
    /** Send now when connected, otherwise buffer in the durable queue. */
    async send(envelope) {
        if (this.connected && this.#socket) {
            this.#socket.send(JSON.stringify(envelope));
            return "sent";
        }
        await this.#queue.enqueue(envelope);
        this.#queueSize = await this.#queue.size();
        this.#emitStatus();
        return "queued";
    }
    /** Round-trip request; requires an authenticated session. */
    async request(envelope, timeoutMs = 15_000) {
        if (!this.connected || !this.#socket)
            throw new Error(`cannot request while ${this.#state.phase}`);
        const id = envelope.id ?? newId();
        const payload = { ...envelope, id };
        return new Promise((resolve, reject) => {
            const timer = this.#timers.setTimeout(() => {
                this.#pending.delete(id);
                reject(new Error(`request ${id} timed out`));
            }, timeoutMs);
            this.#pending.set(id, { resolve, reject, timer });
            this.#socket.send(JSON.stringify(payload));
        });
    }
    // --- machine -------------------------------------------------------------
    #dispatch(event) {
        if (this.#disposed)
            return;
        const { state, effects } = reduce(this.#state, event, this.#ctx);
        this.#state = state;
        for (const effect of effects)
            this.#apply(effect);
        this.#emitStatus();
    }
    #apply(effect) {
        switch (effect.type) {
            case "pair":
                void this.#doPair();
                break;
            case "open-socket":
                this.#openSocket(effect.url);
                break;
            case "close-socket":
                this.#teardownSocket();
                break;
            case "send-hello":
                this.#sendHello();
                break;
            case "flush-queue":
                void this.#flushQueue();
                break;
            case "clear-ticket":
                this.#ticket = null;
                break;
            case "schedule-retry":
                this.#cancelRetry();
                this.#retryTimer = this.#timers.setTimeout(() => this.#dispatch({ type: "retry-tick" }), effect.delayMs);
                break;
            case "cancel-retry":
                this.#cancelRetry();
                break;
            case "state-changed":
                this.#log.debug("connection state", { phase: effect.phase });
                break;
            default:
                break;
        }
    }
    async #doPair() {
        const provider = this.#opts.pairing;
        if (!provider) {
            this.#dispatch({ type: "pair-fail", error: "no pairing provider configured" });
            return;
        }
        try {
            const result = await provider.request();
            this.#ticket = result.ticket;
            registerSecret(this.#log, result.ticket);
            this.#dispatch({ type: "pair-ok", url: result.relayUrl });
        }
        catch (err) {
            this.#dispatch({ type: "pair-fail", error: err.message });
        }
    }
    #openSocket(url) {
        this.#teardownSocket();
        let sock;
        try {
            const factory = this.#opts.socketFactory ?? browserSocketFactory();
            sock = factory(url);
        }
        catch (err) {
            this.#dispatch({ type: "socket-error", error: err.message });
            return;
        }
        this.#socket = sock;
        sock.onOpen(() => this.#dispatch({ type: "socket-open" }));
        sock.onMessage((data) => this.#onMessage(data));
        sock.onError((err) => this.#dispatch({ type: "socket-error", error: err.message }));
        sock.onClose((code, reason) => {
            this.#socket = null;
            this.#stopHeartbeat();
            this.#failPending(new Error(`socket closed (${code})`));
            this.#dispatch({ type: "socket-close", code, reason });
        });
    }
    #sendHello() {
        if (!this.#socket)
            return;
        if (!this.#ticket) {
            this.#dispatch({ type: "auth-fail", reason: "no ticket in memory" });
            return;
        }
        const hello = {
            type: "hello",
            ticket: this.#ticket,
            clientId: this.#clientId,
            mode: this.#state.mode,
            version: PROTOCOL_VERSION,
        };
        this.#socket.send(JSON.stringify(hello));
        this.#lastInboundAt = this.#now();
    }
    #onMessage(data) {
        this.#lastInboundAt = this.#now();
        let envelope;
        try {
            envelope = JSON.parse(data);
        }
        catch {
            this.#log.warn("dropping unparseable relay frame");
            return;
        }
        switch (envelope.type) {
            case "welcome": {
                if (typeof envelope.heartbeatMs === "number" && envelope.heartbeatMs > 0) {
                    this.#heartbeatMs = envelope.heartbeatMs;
                }
                this.#dispatch({ type: "welcome", sessionId: String(envelope.sessionId) });
                this.#startHeartbeat();
                break;
            }
            case "auth-error":
                this.#stopHeartbeat();
                this.#dispatch({ type: "auth-fail", reason: envelope.reason });
                break;
            case "ping":
                this.#socket?.send(JSON.stringify({ type: "pong", t: envelope.t }));
                break;
            case "command":
                void this.#handleCommand(envelope);
                break;
            case "result": {
                const pending = this.#pending.get(envelope.id);
                if (pending) {
                    this.#pending.delete(envelope.id);
                    this.#timers.clearTimeout(pending.timer);
                    pending.resolve(envelope);
                }
                break;
            }
            case "event":
                for (const cb of this.#eventListeners)
                    cb(envelope.name, envelope.data);
                this.#opts.onEvent?.(envelope.name, envelope.data);
                break;
            default:
                break;
        }
    }
    async #handleCommand(command) {
        let result;
        try {
            result = await this.#opts.onCommand?.(command);
            if (!result)
                result = { type: "result", id: command.id, ok: true, payload: null };
        }
        catch (err) {
            result = { type: "result", id: command.id, ok: false, error: { code: "handler_error", message: err.message } };
        }
        await this.send(result);
    }
    async #flushQueue() {
        const sent = await this.#queue.flush(async (envelope) => {
            if (!this.#socket || !this.connected)
                throw new Error("offline");
            this.#socket.send(JSON.stringify(envelope));
        });
        this.#queueSize = await this.#queue.size();
        if (sent > 0)
            this.#log.info("flushed queued envelopes", { count: sent });
        this.#emitStatus();
    }
    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#heartbeatTimer = this.#timers.setInterval(() => {
            if (!this.connected || !this.#socket)
                return;
            this.#socket.send(JSON.stringify({ type: "ping", t: this.#now() }));
            if (this.#now() - this.#lastInboundAt > this.#heartbeatTimeoutMs) {
                this.#log.warn("heartbeat timeout, forcing reconnect");
                this.#dispatch({ type: "heartbeat-timeout" });
            }
        }, this.#heartbeatMs);
    }
    #stopHeartbeat() {
        if (this.#heartbeatTimer !== undefined) {
            this.#timers.clearInterval(this.#heartbeatTimer);
            this.#heartbeatTimer = undefined;
        }
    }
    #cancelRetry() {
        if (this.#retryTimer !== undefined) {
            this.#timers.clearTimeout(this.#retryTimer);
            this.#retryTimer = undefined;
        }
    }
    #teardownSocket() {
        const sock = this.#socket;
        this.#socket = null;
        if (sock) {
            try {
                sock.close(1000, "teardown");
            }
            catch {
                /* ignore */
            }
        }
    }
    #failPending(err) {
        for (const [id, pending] of this.#pending) {
            this.#timers.clearTimeout(pending.timer);
            pending.reject(err);
            this.#pending.delete(id);
        }
    }
    #emitStatus() {
        const status = this.status;
        for (const cb of this.#statusListeners)
            cb(status);
    }
    #now() {
        return this.#opts.now ? this.#opts.now() : Date.now();
    }
}
