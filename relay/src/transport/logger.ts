/**
 * Redacting logger.
 *
 * Two independent guards, because "we do not log tickets" is a promise that has
 * to be enforced mechanically:
 *   1. any object key matching /ticket|token|secret|password|authorization|cookie/i
 *      is replaced with "[redacted]";
 *   2. any string that contains a known secret value (or the ticket prefix) is
 *      scrubbed, even when it was interpolated into a free-form message.
 *
 * The relay registers every minted ticket with the logger, so a ticket can never
 * reach a log line even by accident.
 */

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type LogSink = (line: string, level: string) => void;

const SECRET_KEY = /(ticket|token|secret|passwd|password|authorization|cookie|credential)/i;
const TICKET_VALUE = /hbrt_[A-Za-z0-9_-]{4,}/g;
const REDACTED = "[redacted]";

export function redactValue(value: unknown, secrets: ReadonlySet<string>): unknown {
  if (typeof value === "string") {
    let out = value.replace(TICKET_VALUE, REDACTED);
    for (const secret of secrets) {
      if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(REDACTED);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(v, secrets);
    }
    return out;
  }
  return value;
}

export class RedactingLogger implements Logger {
  #sink: LogSink;
  readonly secrets = new Set<string>();

  constructor(sink: LogSink) {
    this.#sink = sink;
  }

  /** Register a live secret so it is scrubbed from every future line. */
  addSecret(secret: string): void {
    if (secret) this.secrets.add(secret);
  }

  forgetSecret(secret: string): void {
    this.secrets.delete(secret);
  }

  #line(level: string, msg: string, meta?: Record<string, unknown>): void {
    const safeMsg = redactValue(msg, this.secrets) as string;
    const safeMeta = meta ? (redactValue(meta, this.secrets) as Record<string, unknown>) : undefined;
    const ts = new Date().toISOString();
    const tail = safeMeta && Object.keys(safeMeta).length ? " " + JSON.stringify(safeMeta) : "";
    this.#sink(`${ts} ${level.toUpperCase()} ${safeMsg}${tail}`, level);
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.#line("debug", msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.#line("info", msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.#line("warn", msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.#line("error", msg, meta);
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Best-effort secret registration: works for any logger that supports it. */
export function registerSecret(logger: Logger, secret: string): void {
  const maybe = logger as { addSecret?: (value: string) => void };
  if (secret && typeof maybe.addSecret === "function") maybe.addSecret(secret);
}
