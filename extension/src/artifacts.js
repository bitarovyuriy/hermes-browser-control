/**
 * Artifact store: screenshots, DOM snapshots, console logs, response text.
 *
 * Artifacts are (a) kept in a bounded ring buffer for the panel/diagnostics and
 * (b) pushed to a sink — by default `chrome.runtime.sendMessage` + an optional
 * relay adapter (`globalThis.hermesRelay.send`) so the Hermes runtime receives
 * them even when the side panel is closed.
 *
 * Pure module apart from the injected sink — unit-testable.
 */

export const ARTIFACT_KINDS = Object.freeze(['screenshot', 'dom', 'console', 'response', 'text', 'trace', 'error']);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function decodeBase64(b64) {
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

export function isPng(bytes) {
  if (!bytes || bytes.length < 8) return false;
  return PNG_MAGIC.every((b, i) => bytes[i] === b);
}

/** Real pixel dimensions from the PNG IHDR chunk (offsets 16..24, big-endian). */
export function pngDimensions(bytes) {
  if (!isPng(bytes) || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function truncate(value, max) {
  if (typeof value !== 'string') return value;
  return value.length <= max ? value : `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

export function createArtifactStore({ sink = null, limit = 200, clock = () => Date.now(), maxTextChars = 20000 } = {}) {
  const items = [];
  let dropped = 0;
  let seq = 0;

  async function digest(record) {
    try {
      if (globalThis.crypto && globalThis.crypto.subtle) {
        const bytes = new TextEncoder().encode(JSON.stringify(record, (k, v) => (k === 'data' ? undefined : v)));
        const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch {
      /* digest is a nice-to-have */
    }
    return null;
  }

  /**
   * @param {object} artifact {kind, tabId, ...}
   * @returns {Promise<object>} the normalized record
   */
  async function add(artifact) {
    const kind = artifact.kind;
    if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`unknown artifact kind: ${kind}`);
    const record = {
      ...artifact,
      id: ++seq,
      kind,
      tabId: artifact.tabId ?? null,
      at: clock(),
      source: artifact.source || 'unknown',
    };

    if (kind === 'screenshot' && typeof record.data === 'string') {
      const bytes = decodeBase64(record.data);
      const dims = pngDimensions(bytes);
      record.bytes = bytes.length;
      record.width = dims ? dims.width : null;
      record.height = dims ? dims.height : null;
      record.png = isPng(bytes);
      delete record.data; // never keep the raw base64 in the ring buffer
    }
    if (typeof record.text === 'string') record.text = truncate(record.text, maxTextChars);
    if (typeof record.html === 'string') record.html = truncate(record.html, maxTextChars);

    record.digest = await digest(record);

    items.push(record);
    while (items.length > limit) {
      items.shift();
      dropped += 1;
    }

    if (typeof sink === 'function') {
      try {
        await sink(record);
      } catch (err) {
        record.sinkError = String(err && err.message ? err.message : err);
      }
    }
    return record;
  }

  const store = {
    add,
    ofKind: (kind) => items.filter((i) => i.kind === kind),
    latest: (kind) => [...items].reverse().find((i) => i.kind === kind) || null,
    list: () => [...items],
    size: () => items.length,
    dropped: () => dropped,
    clear: () => {
      items.length = 0;
      return store;
    },
  };
  return store;
}
