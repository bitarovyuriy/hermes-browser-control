/**
 * Connection-mode rules for the three Hermes deployment shapes.
 *
 *   local  -> loopback relay, ws://127.0.0.1:<port> (never a public host)
 *   cloud  -> Hermes Cloud, wss:// (https:// is normalised to wss://)
 *   remote -> self-hosted, MUST be wss:// (no path-prefix rewriting)
 *
 * buildEndpoint() is pure and returns a discriminated result so the side panel
 * can show the exact reason a configuration is rejected.
 */
import { DEFAULT_RELAY_PORT, EXTENSION_ENDPOINT_PATH, RUNTIME_ENDPOINT_PATH } from "./types.js";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export function isLoopbackHost(host) {
    return LOOPBACK_HOSTS.has(host.toLowerCase());
}
/** Concatenate, preserving any base path the operator configured. */
export function joinPath(base, suffix) {
    const b = base.replace(/\/+$/, "");
    const s = suffix.startsWith("/") ? suffix : "/" + suffix;
    return b + s;
}
function hasEndpointPath(base, endpoint) {
    return base.replace(/\/+$/, "").endsWith(endpoint);
}
function secureOf(protocol) {
    return protocol === "wss:" || protocol === "https:";
}
/**
 * Validate + normalise a relay base URL against its mode.
 * `subPath` is the WS endpoint to append (extension or runtime).
 */
export function validateRelayUrl(rawUrl, mode, subPath = EXTENSION_ENDPOINT_PATH) {
    const trimmed = (rawUrl ?? "").trim();
    if (!trimmed) {
        return { ok: false, mode, error: "empty relay url" };
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return { ok: false, mode, error: `not a valid url: ${trimmed}` };
    }
    const protocol = parsed.protocol.toLowerCase();
    const secure = secureOf(protocol);
    if (mode === "local") {
        if (!isLoopbackHost(parsed.hostname)) {
            return { ok: false, mode, error: `local mode must target loopback, got host "${parsed.hostname}"` };
        }
        if (protocol !== "ws:" && protocol !== "wss:") {
            return { ok: false, mode, error: `local mode needs ws:// or wss://, got ${protocol}` };
        }
    }
    else if (mode === "cloud") {
        if (!secure) {
            return { ok: false, mode, error: `cloud mode requires wss:// or https://, got ${protocol}` };
        }
        if (protocol === "https:")
            parsed.protocol = "wss:";
    }
    else {
        // remote (self-hosted)
        if (protocol !== "wss:") {
            return { ok: false, mode, error: `remote mode requires wss:// (got ${protocol})` };
        }
    }
    const base = parsed.toString();
    const url = hasEndpointPath(base, subPath) ? base.replace(/\/+$/, "") : joinPath(base, subPath);
    return { ok: true, mode, url, secure, host: parsed.hostname };
}
export function buildEndpoint(cfg, subPath = EXTENSION_ENDPOINT_PATH) {
    if (cfg.mode === "local") {
        const port = cfg.port ?? DEFAULT_RELAY_PORT;
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
            return { ok: false, mode: cfg.mode, error: `invalid local port: ${String(cfg.port)}` };
        }
        const base = cfg.baseUrl?.trim() ? cfg.baseUrl : `ws://127.0.0.1:${port}`;
        return validateRelayUrl(base, "local", subPath);
    }
    if (!cfg.baseUrl?.trim()) {
        return { ok: false, mode: cfg.mode, error: `${cfg.mode} mode requires a base url` };
    }
    return validateRelayUrl(cfg.baseUrl, cfg.mode, subPath);
}
export function buildRuntimeEndpoint(cfg) {
    return buildEndpoint(cfg, RUNTIME_ENDPOINT_PATH);
}
