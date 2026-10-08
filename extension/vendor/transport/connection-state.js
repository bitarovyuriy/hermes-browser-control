/**
 * Connection-state machine.
 *
 * PURE. No sockets, no timers, no storage, no logging, no clock of its own:
 * `reduce(state, event, ctx)` returns the next state plus a list of effects the
 * host must perform. Everything that could leak a ticket lives outside this
 * module (the state only records `hasTicket: boolean`).
 *
 *   idle ─start─▶ pairing ─pair-ok─▶ connecting ─socket-open─▶ authenticating
 *                                              ─welcome─▶ connected
 *   any failure ─▶ reconnecting ─retry-tick─▶ pairing | connecting
 *   connected ─pause─▶ paused ─resume─▶ reconnecting
 *   any ─stop─▶ stopped (resumable)     any ─kill─▶ fatal (kill-switch)
 */
import { DEFAULT_BACKOFF, nextDelay } from "./backoff.js";
export const PHASES = [
    "idle",
    "pairing",
    "connecting",
    "authenticating",
    "connected",
    "reconnecting",
    "paused",
    "stopped",
    "fatal",
];
export function makeContext(over = {}) {
    return {
        backoff: over.backoff ?? DEFAULT_BACKOFF,
        maxAttempts: over.maxAttempts ?? Number.POSITIVE_INFINITY,
        rand: over.rand ?? Math.random,
    };
}
export function initialState(mode) {
    return {
        phase: "idle",
        mode,
        attempt: 0,
        url: null,
        hasTicket: false,
        sessionId: null,
        lastError: null,
        pausedFrom: null,
        everConnected: false,
    };
}
export function isConnected(state) {
    return state.phase === "connected";
}
export function isTerminal(state) {
    return state.phase === "stopped" || state.phase === "fatal";
}
export function isInFlight(state) {
    return (state.phase === "pairing" ||
        state.phase === "connecting" ||
        state.phase === "authenticating" ||
        state.phase === "connected");
}
function change(state, phase, reason, effects) {
    effects.push({ type: "state-changed", phase, reason });
    return { ...state, phase };
}
function scheduleRetry(state, ctx, effects) {
    const attempt = state.attempt + 1;
    if (Number.isFinite(ctx.maxAttempts) && attempt > ctx.maxAttempts) {
        const next = { ...state, attempt };
        return change(next, "fatal", `max attempts (${ctx.maxAttempts}) exhausted`, effects);
    }
    const delayMs = nextDelay(attempt, ctx.backoff, ctx.rand);
    effects.push({ type: "schedule-retry", delayMs, attempt });
    return change({ ...state, attempt }, "reconnecting", `retry in ${delayMs}ms (attempt ${attempt})`, effects);
}
/** Pick the next action after a retry tick, a start, or a resume. */
function armNext(state, ctx, effects) {
    if (!state.hasTicket) {
        effects.push({ type: "pair", mode: state.mode });
        return { state: change(state, "pairing", "requesting pairing ticket", effects), effects };
    }
    if (!state.url) {
        return { state: scheduleRetry(state, ctx, effects), effects };
    }
    effects.push({ type: "open-socket", url: state.url, mode: state.mode });
    return { state: change(state, "connecting", "dialling relay", effects), effects };
}
function teardown(state, ctx, effects, reason) {
    effects.push({ type: "close-socket", code: 1000, reason: reason.slice(0, 120) });
    effects.push({ type: "clear-ticket" });
    const cleared = { ...state, hasTicket: false, sessionId: null, lastError: reason };
    return { state: scheduleRetry(cleared, ctx, effects), effects };
}
export function reduce(state, event, ctx = makeContext()) {
    const effects = [];
    switch (event.type) {
        case "start": {
            if (state.phase !== "idle" && state.phase !== "stopped")
                return { state, effects };
            if (!state.url) {
                return { state: change({ ...state, lastError: "no relay url configured" }, "fatal", "missing url", effects), effects };
            }
            return armNext({ ...state, attempt: 0, lastError: null, phase: "idle" }, ctx, effects);
        }
        case "pair-ok": {
            if (state.phase !== "pairing" && state.phase !== "reconnecting")
                return { state, effects };
            const paired = { ...state, url: event.url, hasTicket: true, lastError: null };
            effects.push({ type: "open-socket", url: event.url, mode: state.mode });
            return { state: change(paired, "connecting", "pairing accepted", effects), effects };
        }
        case "pair-fail": {
            if (state.phase !== "pairing" && state.phase !== "reconnecting")
                return { state, effects };
            return { state: scheduleRetry({ ...state, lastError: event.error }, ctx, effects), effects };
        }
        case "socket-open": {
            if (state.phase !== "connecting")
                return { state, effects };
            effects.push({ type: "send-hello" });
            return { state: change(state, "authenticating", "socket open, authenticating", effects), effects };
        }
        case "welcome": {
            if (state.phase !== "authenticating" && state.phase !== "connected")
                return { state, effects };
            effects.push({ type: "cancel-retry" });
            effects.push({ type: "flush-queue" });
            return {
                state: change({ ...state, attempt: 0, sessionId: event.sessionId, hasTicket: true, everConnected: true, lastError: null }, "connected", "authenticated", effects),
                effects,
            };
        }
        case "auth-fail": {
            if (state.phase !== "authenticating")
                return { state, effects };
            effects.push({ type: "clear-ticket" });
            return {
                state: scheduleRetry({ ...state, hasTicket: false, lastError: event.reason }, ctx, effects),
                effects,
            };
        }
        case "socket-close": {
            if (!isInFlight(state))
                return { state, effects };
            const reason = `socket closed (${event.code ?? 0}${event.reason ? " " + event.reason : ""})`;
            return teardown(state, ctx, effects, reason);
        }
        case "socket-error": {
            if (!isInFlight(state))
                return { state, effects };
            return teardown(state, ctx, effects, `socket error: ${event.error}`);
        }
        case "heartbeat-timeout": {
            if (state.phase !== "connected")
                return { state, effects };
            return teardown(state, ctx, effects, "heartbeat timeout");
        }
        case "retry-tick": {
            if (state.phase !== "reconnecting")
                return { state, effects };
            return armNext(state, ctx, effects);
        }
        case "connect-now": {
            if (state.phase === "paused" || state.phase === "fatal")
                return { state, effects };
            if (isInFlight(state))
                return { state, effects };
            return armNext({ ...state, attempt: 0, lastError: null }, ctx, effects);
        }
        case "pause": {
            if (isTerminal(state) || state.phase === "paused")
                return { state, effects };
            effects.push({ type: "close-socket", code: 1000, reason: "paused" });
            effects.push({ type: "cancel-retry" });
            const paused = { ...state, pausedFrom: state.phase, hasTicket: false, sessionId: null };
            return { state: change(paused, "paused", "paused by operator", effects), effects };
        }
        case "resume": {
            if (state.phase !== "paused")
                return { state, effects };
            const resumed = { ...state, pausedFrom: null, attempt: 0 };
            return armNext(resumed, ctx, effects);
        }
        case "stop": {
            if (isTerminal(state))
                return { state, effects };
            effects.push({ type: "close-socket", code: 1000, reason: "stopped" });
            effects.push({ type: "cancel-retry" });
            effects.push({ type: "clear-ticket" });
            return {
                state: change({ ...state, hasTicket: false, sessionId: null, attempt: 0, pausedFrom: null }, "stopped", "stopped", effects),
                effects,
            };
        }
        case "kill": {
            effects.push({ type: "close-socket", code: 1001, reason: "kill-switch" });
            effects.push({ type: "cancel-retry" });
            effects.push({ type: "clear-ticket" });
            return {
                state: change({ ...state, hasTicket: false, sessionId: null, pausedFrom: null }, "fatal", "kill-switch", effects),
                effects,
            };
        }
        default: {
            const never = event;
            void never;
            return { state, effects };
        }
    }
}
