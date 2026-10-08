/**
 * Node `ws`-based TransportSocket adapter.
 *
 * The extension uses the browser's global WebSocket (see src/transport/socket.ts);
 * this adapter exists so tests and CLI tooling can drive the very same
 * TransportClient against a real relay.
 */

import { WebSocket } from "ws";
import type { SocketFactory, TransportSocket } from "./src/transport/types.ts";

export function nodeWsSocketFactory(): SocketFactory {
  return (url: string): TransportSocket => {
    const ws = new WebSocket(url);
    return {
      send(data: string) {
        ws.send(data);
      },
      close(code?: number, reason?: string) {
        try {
          ws.close(code, reason);
        } catch {
          /* ignore */
        }
      },
      onOpen(cb) {
        ws.on("open", () => cb());
      },
      onMessage(cb) {
        ws.on("message", (data) => cb(String(data)));
      },
      onClose(cb) {
        ws.on("close", (code, reason) => cb(code, reason.toString()));
      },
      onError(cb) {
        ws.on("error", (err) => cb(err as Error));
      },
    };
  };
}
