/**
 * Standalone relay entry point.
 *
 *   node relay/relay-cli.ts --port 47317 --log logs/relay.log
 *
 * The Hermes runtime starts this (or imports LoopbackRelay directly) and writes
 * the rendezvous file the native host reads.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_RELAY_PORT } from "./src/transport/types.ts";
import { LoopbackRelay } from "./relay.ts";

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function writeRendezvous(port: number): void {
  const base = process.env.LOCALAPPDATA;
  if (!base) return;
  const path = join(base, "hermes", "browser-relay.json");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid }), "utf8");
  } catch {
    /* rendezvous is a convenience; HERMES_RELAY_URL always works */
  }
}

async function main(): Promise<void> {
  const port = Number(arg("port", String(DEFAULT_RELAY_PORT)));
  const logFile = arg("log");
  const relay = new LoopbackRelay({ port, logFile });
  const info = await relay.start();
  writeRendezvous(info.port);
  process.stdout.write(`relay on 127.0.0.1:${info.port}\n  extension: ${info.extensionUrl}\n  runtime:   ${info.runtimeUrl}\n`);
  const shutdown = async (): Promise<void> => {
    await relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
