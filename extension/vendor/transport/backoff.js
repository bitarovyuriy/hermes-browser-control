/**
 * Exponential backoff with jitter. Pure: the random source is injected so tests
 * get deterministic delays.
 */
export const DEFAULT_BACKOFF = {
    baseMs: 500,
    factor: 2,
    maxMs: 30_000,
    jitter: "full",
};
/** Raw (unjittered) delay for a 1-based attempt number. */
export function rawDelay(attempt, opts = DEFAULT_BACKOFF) {
    const n = Math.max(1, Math.floor(attempt));
    const raw = opts.baseMs * Math.pow(opts.factor, n - 1);
    return Math.min(raw, opts.maxMs);
}
/** Delay actually slept before attempt `attempt` (1-based). */
export function nextDelay(attempt, opts = DEFAULT_BACKOFF, rand = Math.random) {
    const raw = rawDelay(attempt, opts);
    if (opts.jitter === "none")
        return raw;
    // Full jitter, floored at baseMs so we never hot-loop on a 0ms draw.
    const jittered = Math.floor(rand() * raw);
    return Math.max(Math.min(opts.baseMs, raw), jittered);
}
