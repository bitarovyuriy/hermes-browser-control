/**
 * Shared protocol + dependency types for the Hermes browser-extension transport.
 *
 * Nothing in this file touches I/O: it is the contract surface used by both the
 * extension side (src/transport) and the relay side (relay/).
 */
export const PROTOCOL_VERSION = 1;
/** WebSocket endpoint the extension dials. */
export const EXTENSION_ENDPOINT_PATH = "/browser/extension";
/** WebSocket endpoint the Hermes runtime dials (bridge peer). */
export const RUNTIME_ENDPOINT_PATH = "/browser/runtime";
/** HTTP endpoint that mints a one-time pairing ticket. Called by the native host. */
export const PAIR_ENDPOINT_PATH = "/browser/pair";
/** HTTP endpoint used by tests / diagnostics: relay injects a command into the extension. */
export const ECHO_ENDPOINT_PATH = "/browser/echo";
/** HTTP endpoint used by the extension's "test connection" button. */
export const STATUS_ENDPOINT_PATH = "/browser/status";
/** Default loopback relay port. Relay binds 127.0.0.1 only. */
export const DEFAULT_RELAY_PORT = 47317;
/** Chrome native-messaging host name registered by the Hermes installer. */
export const DEFAULT_NATIVE_HOST = "com.hermes.browser_relay";
/** Every minted ticket carries this prefix so leaks are greppable by inspection. */
export const TICKET_PREFIX = "hbrt_";
/** Session-scoped storage key for the outbound command queue. */
export const QUEUE_STORAGE_KEY = "hbx.outbound.queue.v1";
/** Ticket lifetime. Short by design: single use, minutes not days. */
export const TICKET_TTL_MS = 120_000;
