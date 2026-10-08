/**
 * Chrome native-messaging framing: every message is a 4-byte little-endian
 * length prefix followed by UTF-8 JSON.
 */

export function encodeNativeMessage(value: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

export class NativeMessageDecoder {
  #buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer | Uint8Array): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const out: unknown[] = [];
    for (;;) {
      if (this.#buffer.length < 4) break;
      const length = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length).toString("utf8");
      this.#buffer = this.#buffer.subarray(4 + length);
      try {
        out.push(JSON.parse(body));
      } catch {
        out.push({ type: "decode.error", raw: body.slice(0, 200) });
      }
    }
    return out;
  }
}
