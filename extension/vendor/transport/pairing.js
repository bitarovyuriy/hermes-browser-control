/**
 * Pairing.
 *
 * Two paths, one contract:
 *   local  -> one-shot `chrome.runtime.connectNative()` bootstrap. A single
 *             connect, validate the response, THEN disconnect. Used once per
 *             session; the live socket is the relay WebSocket, never the native port.
 *   cloud/
 *   remote -> a manual pairing string the operator pastes into the options page.
 *
 * In both paths the ticket is a short-lived single-use value and lives only in
 * memory: it is never written to storage, never logged.
 */
import { TICKET_PREFIX } from "./types.js";
import { validateRelayUrl } from "./config.js";
export const PAIRING_STRING_PREFIX = "hbr1:";
// --- base64url (browser + node, no Buffer dependency) -----------------------
function btoaImpl(input) {
    const fn = globalThis.btoa;
    if (!fn)
        throw new Error("btoa unavailable in this runtime");
    return fn(input);
}
function atobImpl(input) {
    const fn = globalThis.atob;
    if (!fn)
        throw new Error("atob unavailable in this runtime");
    return fn(input);
}
export function bytesToB64Url(bytes) {
    let bin = "";
    for (const b of bytes)
        bin += String.fromCharCode(b);
    return btoaImpl(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64UrlToBytes(text) {
    const normalised = text.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (normalised.length % 4)) % 4;
    const bin = atobImpl(normalised + "=".repeat(pad));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1)
        out[i] = bin.charCodeAt(i);
    return out;
}
export function encodeJsonToB64Url(value) {
    return bytesToB64Url(new TextEncoder().encode(JSON.stringify(value)));
}
export function decodeJsonFromB64Url(text) {
    return JSON.parse(new TextDecoder().decode(b64UrlToBytes(text)));
}
export function formatManualPairingString(payload) {
    const body = { v: 1, url: payload.url, ticket: payload.ticket, exp: payload.expiresAt };
    return PAIRING_STRING_PREFIX + encodeJsonToB64Url(body);
}
export function parseManualPairingString(raw, mode, now = () => Date.now()) {
    const text = (raw ?? "").trim();
    if (!text.startsWith(PAIRING_STRING_PREFIX)) {
        return { ok: false, error: `pairing string must start with "${PAIRING_STRING_PREFIX}"` };
    }
    let payload;
    try {
        payload = decodeJsonFromB64Url(text.slice(PAIRING_STRING_PREFIX.length));
    }
    catch {
        return { ok: false, error: "pairing string is not valid base64url json" };
    }
    if (!payload || typeof payload !== "object")
        return { ok: false, error: "pairing payload is not an object" };
    if (payload.v !== 1)
        return { ok: false, error: `unsupported pairing version: ${String(payload.v)}` };
    if (typeof payload.ticket !== "string" || !payload.ticket.startsWith(TICKET_PREFIX)) {
        return { ok: false, error: `ticket must start with "${TICKET_PREFIX}"` };
    }
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
        return { ok: false, error: "missing ticket expiry" };
    }
    if (payload.exp <= now()) {
        return { ok: false, error: "pairing ticket has expired" };
    }
    const url = validateRelayUrl(payload.url, mode);
    if (!url.ok)
        return { ok: false, error: url.error };
    return { ok: true, value: { ticket: payload.ticket, relayUrl: url.url, expiresAt: payload.exp } };
}
/** Pairing provider backed by an operator-supplied pairing string (cloud/remote). */
export function createStaticPairingProvider(pairingString, mode, now = () => Date.now()) {
    return {
        async request() {
            const parsed = parseManualPairingString(pairingString, mode, now);
            if (!parsed.ok)
                throw new Error(parsed.error);
            return parsed.value;
        },
    };
}
/**
 * Single `connectNative` -> validate response -> disconnect. The port is closed
 * unconditionally so no long-lived native channel survives pairing.
 */
export function createNativePairingProvider(opts) {
    const now = opts.now ?? (() => Date.now());
    const timeoutMs = opts.timeoutMs ?? 5_000;
    return {
        request() {
            return new Promise((resolve, reject) => {
                let port;
                let settled = false;
                let timer;
                const finish = (fn) => {
                    if (settled)
                        return;
                    settled = true;
                    if (timer !== undefined)
                        clearTimeout(timer);
                    try {
                        port.disconnect();
                    }
                    catch {
                        /* already gone */
                    }
                    fn();
                };
                try {
                    port = opts.connectNative(opts.hostName);
                }
                catch (err) {
                    reject(new Error(`connectNative failed: ${err.message}`));
                    return;
                }
                timer = setTimeout(() => finish(() => reject(new Error("native pairing timed out"))), timeoutMs);
                port.onMessage.addListener((message) => {
                    const res = (message ?? {});
                    if (res.type === "pair.error") {
                        finish(() => reject(new Error(res.error ?? "native host rejected pairing")));
                        return;
                    }
                    if (res.type !== "pair.response")
                        return;
                    if (typeof res.ticket !== "string" || !res.ticket.startsWith(TICKET_PREFIX)) {
                        finish(() => reject(new Error("native host returned a malformed ticket")));
                        return;
                    }
                    if (typeof res.relayUrl !== "string") {
                        finish(() => reject(new Error("native host omitted relayUrl")));
                        return;
                    }
                    const validated = validateRelayUrl(res.relayUrl, opts.mode);
                    if (!validated.ok) {
                        finish(() => reject(new Error(validated.error)));
                        return;
                    }
                    const ttl = typeof res.expiresIn === "number" && Number.isFinite(res.expiresIn) ? res.expiresIn : 120_000;
                    const expiresAt = typeof res.expiresAt === "number" ? res.expiresAt : now() + ttl;
                    finish(() => resolve({ ticket: res.ticket, relayUrl: validated.url, expiresAt }));
                });
                port.onDisconnect.addListener(() => {
                    finish(() => reject(new Error("native host disconnected before responding")));
                });
                try {
                    port.postMessage({ type: "pair.request", clientId: opts.clientId, mode: opts.mode, v: 1 });
                }
                catch (err) {
                    finish(() => reject(new Error(`native postMessage failed: ${err.message}`)));
                }
            });
        },
    };
}
