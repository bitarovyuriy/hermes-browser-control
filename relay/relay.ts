/**
 * Loopback relay.
 *
 * Binds 127.0.0.1 ONLY and offers:
 *   POST /browser/pair            -> mint a one-time ticket (called by the native host)
 *   GET  /browser/status          -> health + session snapshot (side-panel "test connection")
 *   POST /browser/echo            -> relay injects a command into the extension and
 *                                    returns its result (proves the pipe end to end)
 *   WS   /browser/extension       -> the extension dials this
 *   WS   /browser/runtime         -> the Hermes runtime dials this; envelopes are bridged
 *
 * Every minted ticket is registered with the redacting logger, so ticket values
 * cannot appear in the log sink even if something else tries to print them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

import {
  DEFAULT_RELAY_PORT,
  ECHO_ENDPOINT_PATH,
  AGENT_ENDPOINT_PATH,
  EXTENSION_ENDPOINT_PATH,
  PAIR_ENDPOINT_PATH,
  PROTOCOL_VERSION,
  RUNTIME_ENDPOINT_PATH,
  STATUS_ENDPOINT_PATH,
  type CommandEnvelope,
  type HelloEnvelope,
  type ResultEnvelope,
} from "./src/transport/types.ts";
import { RedactingLogger, silentLogger, type Logger } from "./src/transport/logger.ts";
import { TicketStore } from "./tickets.ts";

export interface RelayOptions {
  port?: number;
  host?: string;
  logger?: Logger;
  /** Tee logs to a file so leaks are greppable by inspection. */
  logFile?: string;
  ticketTtlMs?: number;
  heartbeatMs?: number;
  /** Rule the relay rejects a non-loopback request (defence in depth). */
  enforceLoopback?: boolean;
}

export interface ExtensionSessionInfo {
  clientId: string;
  mode: string;
  sessionId: string;
  connectedAt: number;
  remoteAddress: string;
  protocolVersion: number;
}

interface PendingRequest {
  resolve: (result: ResultEnvelope) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export class LoopbackRelay {
  readonly #tickets: TicketStore;
  readonly #log: RedactingLogger;
  readonly #logLines: string[] = [];
  readonly #logStream: WriteStream | null;
  readonly #ownLogger: boolean;

  #http: Server | null = null;
  #wss: WebSocketServer | null = null;
  #port: number;
  #host: string;
  #enforceLoopback: boolean;

  #extension: WebSocket | null = null;
  #session: ExtensionSessionInfo | null = null;
  readonly #runtimes = new Set<WebSocket>();
  readonly #pendingEcho = new Map<string, PendingRequest>();
  readonly #alive = new Map<WebSocket, boolean>();
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #heartbeatMs: number;

  constructor(opts: RelayOptions = {}) {
    this.#port = opts.port ?? DEFAULT_RELAY_PORT;
    this.#host = opts.host ?? "127.0.0.1";
    this.#enforceLoopback = opts.enforceLoopback ?? true;
    this.#heartbeatMs = opts.heartbeatMs ?? 20_000;

    this.#ownLogger = !opts.logger && !opts.logFile;
    this.#logStream = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : null;
    const sink = (line: string): void => {
      this.#logLines.push(line);
      if (this.#logLines.length > 5_000) this.#logLines.shift();
      const stream = this.#logStream;
      if (stream) stream.write(line + "\n");
      else if (!this.#ownLogger) opts.logger?.info(line);
    };
    this.#log = new RedactingLogger(sink);

    this.#tickets = new TicketStore({
      ttlMs: opts.ticketTtlMs,
      onMint: (value) => this.#log.addSecret(value),
    });
  }

  get log(): RedactingLogger {
    return this.#log;
  }
  get tickets(): TicketStore {
    return this.#tickets;
  }
  get port(): number {
    return this.#port;
  }
  get extensionSession(): ExtensionSessionInfo | null {
    return this.#session;
  }
  get logLines(): readonly string[] {
    return this.#logLines;
  }
  get extensionUrl(): string {
    return `ws://127.0.0.1:${this.#port}${EXTENSION_ENDPOINT_PATH}`;
  }
  get runtimeUrl(): string {
    return `ws://127.0.0.1:${this.#port}${RUNTIME_ENDPOINT_PATH}`;
  }
  get httpBase(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<{ port: number; extensionUrl: string; runtimeUrl: string }> {
    const http = createServer((req, res) => this.#handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });

    http.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (!this.#loopbackOk(req)) {
        socket.destroy();
        return;
      }
      if (path === EXTENSION_ENDPOINT_PATH || path === RUNTIME_ENDPOINT_PATH) {
        wss.handleUpgrade(req, socket, head, (ws) => this.#handleSocket(ws, path));
      } else {
        socket.destroy();
      }
    });

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.#port, this.#host, () => resolve());
    });

    const address = http.address();
    if (address && typeof address === "object") this.#port = address.port;

    this.#http = http;
    this.#wss = wss;
    this.#heartbeatTimer = setInterval(() => this.#heartbeatTick(), this.#heartbeatMs);
    this.#log.info("relay listening", { host: this.#host, port: this.#port });
    return { port: this.#port, extensionUrl: this.extensionUrl, runtimeUrl: this.runtimeUrl };
  }

  async stop(): Promise<void> {
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    for (const [, pending] of this.#pendingEcho) {
      clearTimeout(pending.timer);
      pending.reject(new Error("relay stopped"));
    }
    this.#pendingEcho.clear();
    for (const ws of this.#runtimes) ws.terminate();
    this.#runtimes.clear();
    this.#extension?.terminate();
    this.#extension = null;
    this.#session = null;
    await new Promise<void>((resolve) => {
      if (!this.#http) return resolve();
      this.#http.close(() => resolve());
    });
    this.#wss?.close();
    this.#http = null;
    this.#wss = null;
    if (this.#logStream) {
      await new Promise<void>((resolve) => this.#logStream!.end(() => resolve()));
    }
  }

  /** Mint a ticket directly (used by the runtime and by tests). */
  mintTicket(meta: Record<string, string> = {}): { ticket: string; expiresAt: number } {
    const t = this.#tickets.mint(meta);
    return { ticket: t.value, expiresAt: t.expiresAt };
  }

  /** Inject a command into the connected extension and await its result. */
  async echo(payload: unknown, timeoutMs = 10_000): Promise<unknown> {
    const result = await this.sendCommand("test.echo", { payload }, timeoutMs);
    if (!result.ok) throw new Error(result.error?.message ?? "echo failed");
    return result.payload;
  }

  async sendCommand(method: string, params: unknown, timeoutMs = 15_000): Promise<ResultEnvelope> {
    const ws = this.#extension;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return { type: "result", id: "-", ok: false, error: { code: "no_extension", message: "no extension connected" } };
    }
    const id = randomUUID();
    const command: CommandEnvelope = { type: "command", id, method, params };
    return new Promise<ResultEnvelope>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingEcho.delete(id);
        resolve({ type: "result", id, ok: false, error: { code: "timeout", message: `command ${method} timed out` } });
      }, timeoutMs);
      this.#pendingEcho.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: () => {
          clearTimeout(timer);
          resolve({ type: "result", id, ok: false, error: { code: "relay_stopped", message: "relay stopped" } });
        },
        timer,
      });
      ws.send(JSON.stringify(command));
    });
  }

  // --- internals -----------------------------------------------------------

  #loopbackOk(req: IncomingMessage): boolean {
    if (!this.#enforceLoopback) return true;
    const addr = req.socket.remoteAddress ?? "";
    return LOOPBACK.has(addr) || addr.startsWith("127.");
  }

  #handleSocket(ws: WebSocket, path: string): void {
    this.#alive.set(ws, true);
    ws.on("pong", () => this.#alive.set(ws, true));

    if (path === RUNTIME_ENDPOINT_PATH) {
      this.#runtimes.add(ws);
      this.#log.info("runtime bridge connected", { count: this.#runtimes.size });
      ws.on("message", (data) => this.#fromRuntime(ws, String(data)));
      ws.on("close", () => {
        this.#runtimes.delete(ws);
        this.#alive.delete(ws);
        this.#log.info("runtime bridge disconnected", { count: this.#runtimes.size });
      });
      ws.on("error", () => ws.terminate());
      return;
    }

    // extension endpoint: expect hello first
    let authenticated = false;
    const helloTimer = setTimeout(() => {
      if (!authenticated) ws.close(4408, "hello timeout");
    }, 5_000);

    ws.on("message", (data) => {
      const text = String(data);
      if (!authenticated) {
        let envelope: Partial<HelloEnvelope>;
        try {
          envelope = JSON.parse(text) as Partial<HelloEnvelope>;
        } catch {
          ws.close(4400, "bad framing");
          return;
        }
        if (envelope.type !== "hello" || typeof envelope.ticket !== "string") {
          ws.close(4400, "hello required");
          return;
        }
        if (envelope.version !== PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ type: "auth-error", reason: `protocol mismatch: ${String(envelope.version)}` }));
          ws.close(4402, "protocol mismatch");
          return;
        }
        const consumed = this.#tickets.consume(envelope.ticket);
        if (!consumed.ok) {
          ws.send(JSON.stringify({ type: "auth-error", reason: `ticket ${consumed.reason}` }));
          ws.close(4401, "auth failed");
          return;
        }
        authenticated = true;
        clearTimeout(helloTimer);
        if (this.#extension && this.#extension !== ws) {
          this.#extension.close(4409, "replaced by newer session");
        }
        this.#extension = ws;
        this.#session = {
          clientId: String(envelope.clientId ?? "unknown"),
          mode: String(envelope.mode ?? "unknown"),
          sessionId: randomUUID(),
          connectedAt: Date.now(),
          remoteAddress:
            (ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? "unknown",
          protocolVersion: PROTOCOL_VERSION,
        };
        ws.send(
          JSON.stringify({
            type: "welcome",
            sessionId: this.#session.sessionId,
            serverTime: Date.now(),
            heartbeatMs: this.#heartbeatMs,
          }),
        );
        // ticket value deliberately not logged; the store already dropped it
        this.#log.info("extension authenticated", { clientId: this.#session.clientId, mode: this.#session.mode });
        return;
      }
      this.#fromExtension(ws, text);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      this.#alive.delete(ws);
      if (this.#extension === ws) {
        this.#extension = null;
        this.#session = null;
        this.#log.info("extension disconnected");
      }
    });
    ws.on("error", () => ws.terminate());
  }

  #fromExtension(ws: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const envelope = parsed as { type?: string; id?: string };
    if (envelope.type === "pong") {
      this.#alive.set(ws, true);
      return;
    }
    if (envelope.type === "result" && typeof envelope.id === "string") {
      const pending = this.#pendingEcho.get(envelope.id);
      if (pending) {
        this.#pendingEcho.delete(envelope.id);
        pending.resolve(envelope as ResultEnvelope);
        return;
      }
    }
    for (const runtime of this.#runtimes) {
      if (runtime.readyState === WebSocket.OPEN) runtime.send(text);
    }
  }

  #fromRuntime(ws: WebSocket, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const envelope = parsed as { type?: string };
    if (envelope.type === "pong") {
      this.#alive.set(ws, true);
      return;
    }
    if (this.#extension && this.#extension.readyState === WebSocket.OPEN) {
      this.#extension.send(text);
    } else if (envelope.type === "command") {
      ws.send(
        JSON.stringify({
          type: "result",
          id: (parsed as { id?: string }).id ?? "-",
          ok: false,
          error: { code: "no_extension", message: "no extension connected" },
        }),
      );
    }
  }

  #heartbeatTick(): void {
    const sockets: WebSocket[] = [this.#extension, ...this.#runtimes].filter((s): s is WebSocket => Boolean(s));
    for (const ws of sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (this.#alive.get(ws) === false) {
        this.#log.warn("heartbeat miss, terminating peer");
        ws.terminate();
        continue;
      }
      this.#alive.set(ws, false);
      try {
        ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
      } catch {
        ws.terminate();
      }
    }
  }

  #handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "").split("?")[0] ?? "";
    if (!this.#loopbackOk(req)) {
      this.#json(res, 403, { ok: false, error: "loopback only" });
      return;
    }
    if (path === PAIR_ENDPOINT_PATH && req.method === "POST") {
      void this.#readJson(req).then((body) => {
        const meta: Record<string, string> = {};
        if (typeof body?.clientId === "string") meta.clientId = body.clientId;
        if (typeof body?.mode === "string") meta.mode = body.mode;
        const t = this.#tickets.mint(meta);
        this.#log.info("ticket minted", { clientId: meta.clientId ?? "unknown" });
        this.#json(res, 200, {
          ok: true,
          ticket: t.value,
          expiresAt: t.expiresAt,
          expiresIn: t.expiresAt - Date.now(),
          wsUrl: this.extensionUrl,
        });
      });
      return;
    }
    if (path === STATUS_ENDPOINT_PATH && req.method === "GET") {
      this.#json(res, 200, {
        ok: true,
        listening: Boolean(this.#http),
        port: this.#port,
        extension: this.#session,
        runtimePeers: this.#runtimes.size,
        outstandingTickets: this.#tickets.size,
      });
      return;
    }
    if (path === ECHO_ENDPOINT_PATH && req.method === "POST") {
      void this.#readJson(req).then(async (body) => {
        const method = typeof body?.method === "string" ? body.method : "test.echo";
        try {
          const result = await this.sendCommand(method, body?.params ?? { payload: body?.payload ?? null }, 10_000);
          this.#json(res, result.ok ? 200 : 503, { ok: result.ok, result });
        } catch (err) {
          this.#json(res, 500, { ok: false, error: (err as Error).message });
        }
      });
      return;
    }
    // Agent lane: same pipe as /browser/echo, but always 200 + a caller-set
    // timeout, so the agent client (hb) never has to special-case 503 bodies and
    // long operations (big page fetches, screenshots) are not cut at 10 s.
    if (path === AGENT_ENDPOINT_PATH && req.method === "POST") {
      void this.#readJson(req).then(async (body) => {
        const method = typeof body?.method === "string" ? body.method : "";
        if (!method) {
          this.#json(res, 200, { ok: false, result: { ok: false, error: { code: "no_method", message: "method is required" } } });
          return;
        }
        const requested = Number(body?.timeoutMs);
        const timeoutMs = Number.isFinite(requested) ? Math.min(Math.max(requested, 1_000), 180_000) : 60_000;
        try {
          const result = await this.sendCommand(method, body?.params ?? {}, timeoutMs);
          this.#json(res, 200, { ok: result.ok, result });
        } catch (err) {
          this.#json(res, 200, { ok: false, error: (err as Error).message });
        }
      });
      return;
    }
    this.#json(res, 404, { ok: false, error: "not found" });
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  }

  async #readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

export { silentLogger };
