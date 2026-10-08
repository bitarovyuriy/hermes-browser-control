/**
 * One-time pairing tickets.
 *
 * Minted by the relay on behalf of the native-messaging host, consumed by the
 * relay on the `hello` frame. Single use, short TTL, memory only — nothing here
 * ever touches disk, and the relay registers each value with its redacting
 * logger so a ticket cannot reach a log line.
 */

import { randomBytes } from "node:crypto";
import { TICKET_PREFIX, TICKET_TTL_MS } from "./src/transport/types.ts";

export interface Ticket {
  value: string;
  createdAt: number;
  expiresAt: number;
  meta: Record<string, string>;
}

export type ConsumeResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: "unknown" | "expired" };

export interface TicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
  /** Called with every fresh ticket value so the logger can scrub it. */
  onMint?: (value: string) => void;
}

export class TicketStore {
  #ttlMs: number;
  #now: () => number;
  #onMint?: (value: string) => void;
  #tickets = new Map<string, Ticket>();

  constructor(opts: TicketStoreOptions = {}) {
    this.#ttlMs = opts.ttlMs ?? TICKET_TTL_MS;
    this.#now = opts.now ?? (() => Date.now());
    this.#onMint = opts.onMint;
  }

  mint(meta: Record<string, string> = {}, ttlMs?: number): Ticket {
    this.sweep();
    const value = TICKET_PREFIX + randomBytes(24).toString("base64url");
    const createdAt = this.#now();
    const ticket: Ticket = {
      value,
      createdAt,
      expiresAt: createdAt + (ttlMs ?? this.#ttlMs),
      meta,
    };
    this.#tickets.set(value, ticket);
    this.#onMint?.(value);
    return ticket;
  }

  /** Single use: a successful consume removes the ticket immediately. */
  consume(value: string): ConsumeResult {
    const ticket = this.#tickets.get(value);
    if (!ticket) return { ok: false, reason: "unknown" };
    this.#tickets.delete(value);
    if (ticket.expiresAt <= this.#now()) return { ok: false, reason: "expired" };
    return { ok: true, ticket };
  }

  sweep(): number {
    const now = this.#now();
    let removed = 0;
    for (const [key, ticket] of this.#tickets) {
      if (ticket.expiresAt <= now) {
        this.#tickets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.#tickets.size;
  }
}
