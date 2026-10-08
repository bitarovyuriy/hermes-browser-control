import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtifactStore, isPng, pngDimensions, decodeBase64, ARTIFACT_KINDS } from '../../extension/src/artifacts.js';

/** Smallest valid 1x1 PNG. */
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

test('the 1x1 fixture really is a PNG and its size is read from IHDR', () => {
  const bytes = decodeBase64(PNG_1x1);
  assert.ok(isPng(bytes));
  assert.deepEqual(pngDimensions(bytes), { width: 1, height: 1 });
});

test('screenshots are normalized to metadata, never raw base64', async () => {
  const store = createArtifactStore({ sink: async () => {} });
  const record = await store.add({ kind: 'screenshot', tabId: 4, source: 'cdp', data: PNG_1x1 });
  assert.equal(record.kind, 'screenshot');
  assert.equal(record.png, true);
  assert.deepEqual({ w: record.width, h: record.height }, { w: 1, h: 1 });
  assert.ok(record.bytes > 0);
  assert.equal(record.data, undefined, 'raw base64 must not be retained');
  assert.ok(record.digest);
  assert.equal(store.ofKind('screenshot').length, 1);
  assert.equal(store.latest('screenshot').id, record.id);
});

test('the sink receives every artifact, and a broken sink never loses the record', async () => {
  const seen = [];
  const store = createArtifactStore({
    sink: async (record) => {
      seen.push(record.kind);
      if (record.kind === 'console') throw new Error('relay down');
    },
  });
  await store.add({ kind: 'dom', tabId: 1, source: 'cdp', html: '<html/>' });
  const consoleRecord = await store.add({ kind: 'console', tabId: 1, source: 'cdp', text: 'hello' });
  assert.deepEqual(seen, ['dom', 'console']);
  assert.equal(consoleRecord.sinkError, 'relay down');
  assert.equal(store.size(), 2);
});

test('the ring buffer is bounded and counts drops', async () => {
  const store = createArtifactStore({ limit: 3, sink: async () => {} });
  for (let i = 0; i < 5; i += 1) await store.add({ kind: 'text', tabId: 1, source: 'test', text: `t${i}` });
  assert.equal(store.size(), 3);
  assert.equal(store.dropped(), 2);
  assert.deepEqual(store.list().map((r) => r.text), ['t2', 't3', 't4']);
});

test('long text is truncated instead of blowing up the buffer', async () => {
  const store = createArtifactStore({ sink: async () => {}, maxTextChars: 10 });
  const record = await store.add({ kind: 'text', tabId: 1, source: 'test', text: 'x'.repeat(50) });
  assert.ok(record.text.length < 50);
  assert.match(record.text, /truncated 40 chars/);
});

test('unknown artifact kinds are rejected', async () => {
  const store = createArtifactStore({ sink: async () => {} });
  await assert.rejects(() => store.add({ kind: 'secrets', tabId: 1 }), /unknown artifact kind/);
  assert.ok(ARTIFACT_KINDS.includes('screenshot'));
});
