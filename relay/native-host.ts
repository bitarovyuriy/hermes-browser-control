/**
 * Native-messaging host: the one-shot bootstrap pairer.
 *
 * Chrome spawns this process on `chrome.runtime.connectNative(HOST)`. It asks the
 * local relay to mint a one-time ticket and writes it back as a single framed
 * response, then exits. The extension disconnects the port immediately; the live
 * session afterwards is the relay WebSocket, never this channel.
 *
 * The relay URL is discovered from HERMES_RELAY_URL or the rendezvous file
 * written by the Hermes runtime ($LOCALAPPDATA/hermes/browser-relay.json).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { DEFAULT_NATIVE_HOST, DEFAULT_RELAY_PORT, type ConnMode } from "./src/transport/types.ts";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.ts";

interface PairRequest {
  type?: string;
  clientId?: string;
  mode?: string;
}

const MODES: ConnMode[] = ["local", "cloud", "remote"];

function rendezvousPaths(): string[] {
  const local = process.env.LOCALAPPDATA;
  const paths = [process.env.HERMES_RELAY_RENDEZVOUS, process.env.HERMES_RELAY_URL_FILE];
  if (local) paths.push(join(local, "hermes", "browser-relay.json"));
  paths.push(join(homedir(), "AppData", "Local", "hermes", "browser-relay.json"));
  return paths.filter((p): p is string => Boolean(p));
}

function resolveRelayBase(): string {
  const explicit = process.env.HERMES_RELAY_URL;
  if (explicit) return explicit.replace(/\/+$/, "");
  for (const path of rendezvousPaths()) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as { url?: string; port?: number };
      if (typeof parsed.url === "string" && parsed.url) return parsed.url.replace(/\/+$/, "");
      if (typeof parsed.port === "number") return `http://127.0.0.1:${parsed.port}`;
    } catch {
      /* try the next candidate */
    }
  }
  return `http://127.0.0.1:${DEFAULT_RELAY_PORT}`;
}

function writeAndExit(message: unknown, code = 0): void {
  process.stdout.write(encodeNativeMessage(message), () => {
    process.exit(code);
  });
}

async function handlePairRequest(request: PairRequest): Promise<void> {
  const mode = (request.mode ?? process.env.HERMES_RELAY_MODE ?? "local") as ConnMode;
  if (!MODES.includes(mode)) {
    writeAndExit({ type: "pair.error", error: `unsupported mode: ${String(request.mode)}` }, 0);
    return;
  }
  const base = resolveRelayBase();
  const timeoutMs = Number(process.env.HERMES_PAIR_TIMEOUT_MS ?? 5_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}/browser/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: request.clientId ?? "unknown", mode }),
      signal: controller.signal,
    });
    const body = (await response.json()) as {
      ok?: boolean;
      ticket?: string;
      expiresAt?: number;
      expiresIn?: number;
      wsUrl?: string;
    };
    if (!response.ok || !body.ok || typeof body.ticket !== "string") {
      writeAndExit({ type: "pair.error", error: `relay refused pairing (${response.status})` }, 0);
      return;
    }
    writeAndExit({
      type: "pair.response",
      ticket: body.ticket,
      relayUrl: body.wsUrl,
      expiresAt: body.expiresAt,
      expiresIn: body.expiresIn,
      mode,
      host: DEFAULT_NATIVE_HOST,
    });
  } catch (err) {
    const reason = (err as Error).name === "AbortError" ? "relay unreachable (timeout)" : `relay unreachable: ${(err as Error).message}`;
    writeAndExit({ type: "pair.error", error: reason }, 0);
  } finally {
    clearTimeout(timer);
  }
}

function main(): void {
  const decoder = new NativeMessageDecoder();
  process.stdin.on("data", (chunk: Buffer) => {
    for (const message of decoder.push(chunk)) {
      const request = (message ?? {}) as PairRequest;
      if (request.type !== "pair.request") {
        writeAndExit({ type: "pair.error", error: `unexpected message: ${String(request.type)}` }, 0);
        continue;
      }
      void handlePairRequest(request);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  // Chrome keeps stdin open until the extension disconnects the port.
  process.stdin.resume();
}

main();
