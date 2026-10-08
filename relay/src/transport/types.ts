/**
 * Shared protocol + dependency types for the Hermes browser-extension transport.
 *
 * Nothing in this file touches I/O: it is the contract surface used by both the
 * extension side (src/transport) and the relay side (relay/).
 */

export type ConnMode = "local" | "cloud" | "remote";

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
/** Agent lane: like /browser/echo but always 200 and with a caller-set timeout. */
export const AGENT_ENDPOINT_PATH = "/agent";

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

export interface CommandEnvelope {
  type: "command";
  id: string;
  method: string;
  params?: unknown;
}
export interface ResultEnvelope {
  type: "result";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
}
export interface EventEnvelope {
  type: "event";
  name: string;
  data?: unknown;
}
export interface HelloEnvelope {
  type: "hello";
  ticket: string;
  clientId: string;
  mode: ConnMode;
  version: number;
}
export interface WelcomeEnvelope {
  type: "welcome";
  sessionId: string;
  serverTime: number;
  heartbeatMs: number;
}
export interface AuthErrorEnvelope {
  type: "auth-error";
  reason: string;
}
export interface PingEnvelope {
  type: "ping";
  t: number;
}
export interface PongEnvelope {
  type: "pong";
  t: number;
}

export type InboundEnvelope =
  | CommandEnvelope
  | ResultEnvelope
  | WelcomeEnvelope
  | AuthErrorEnvelope
  | PingEnvelope
  | EventEnvelope;
export type OutboundEnvelope =
  | HelloEnvelope
  | ResultEnvelope
  | PongEnvelope
  | EventEnvelope;

/** Minimal socket surface: satisfied by the browser `WebSocket` and by the `ws` client. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export interface SocketEvents {
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
  onError(cb: (err: Error) => void): void;
}
export type TransportSocket = SocketLike & SocketEvents;
export type SocketFactory = (url: string) => TransportSocket;

export interface StorageAdapter {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PairingResult {
  ticket: string;
  relayUrl: string;
  expiresAt: number;
}
export interface PairingProvider {
  /** One-shot pairing. Must resolve with a ticket that is never persisted. */
  request(): Promise<PairingResult>;
}
