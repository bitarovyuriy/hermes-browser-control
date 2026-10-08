// capture-screenshots.cjs — render the packaged extension's own pages to store-sized PNGs.
//
// Loads the extension through CDP (Extensions.loadUnpacked), opens each page listed on the
// command line at an exact viewport size and writes a PNG. Because the page is rendered
// inside the extension origin, a broken manifest, a missing file or a CSP violation shows up
// as a blank/failed capture instead of a nice picture.
//
// Usage: node capture-screenshots.cjs <ws-url> <ext-path> <out-dir> <page=WxH> [<page=WxH> ...]
//   e.g. node capture-screenshots.cjs ws://... <ext> release/assets control/control.html=1280x800
//
// Prints one JSON line with the written files and their real pixel sizes.
const fs = require('fs');
const path = require('path');

const WS_MODULE = process.env.WS_MODULE || 'ws';
let WebSocket;
try {
  WebSocket = require(WS_MODULE);
} catch (error) {
  if (typeof globalThis.WebSocket === 'function') {
    WebSocket = globalThis.WebSocket;
  } else {
    console.log(JSON.stringify({ ok: false, error: `cannot load ${WS_MODULE}: ${error.message}` }));
    process.exit(2);
  }
}
const NATIVE_WS = WebSocket === globalThis.WebSocket;
const openSocket = (url, opts) => (NATIVE_WS ? new WebSocket(url) : new WebSocket(url, opts));
const onSocket = (socket, event, handler) => {
  if (NATIVE_WS) socket.addEventListener(event, (e) => handler(event === 'message' ? e.data : e));
  else socket.on(event, handler);
};

const [wsUrl, extPath, outDir, ...specs] = process.argv.slice(2);
if (!wsUrl || !extPath || !outDir || !specs.length) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node capture-screenshots.cjs <ws> <ext> <outDir> <page=WxH>...' }));
  process.exit(2);
}

const PNG_SIZE = (buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

let nextId = 1;
const pending = new Map();
const ws = openSocket(wsUrl, { perMessageDeflate: false, maxPayload: 128 * 1024 * 1024 });
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const done = (payload, code) => {
  console.log(JSON.stringify(payload));
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
};

onSocket(ws, 'error', (error) => done({ ok: false, error: error.message || String(error) }, 2));
onSocket(ws, 'message', (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (!msg.id || !pending.has(msg.id)) return;
  const { resolve, reject } = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) reject(new Error(`${msg.error.code ?? ''} ${msg.error.message}`.trim()));
  else resolve(msg.result);
});

onSocket(ws, 'open', async () => {
  const out = { ok: false, extensionId: null, files: [] };
  try {
    const loaded = await send('Extensions.loadUnpacked', { path: extPath });
    out.extensionId = loaded && loaded.id;
    fs.mkdirSync(outDir, { recursive: true });

    for (const spec of specs) {
      const [page, size] = spec.split('=');
      const [width, height] = String(size || '1280x800').split('x').map(Number);
      const url = `chrome-extension://${out.extensionId}/${page}`;
      const created = await send('Target.createTarget', { url });
      const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
      const sessionId = attached.sessionId;
      await send('Page.enable', {}, sessionId);
      await send('Emulation.setDeviceMetricsOverride',
        { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);

      let ready = '';
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const evaluated = await send('Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true }, sessionId);
        ready = (evaluated.result && evaluated.result.value) || '';
        if (ready === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      // readyState=complete fires before the first paint of an async-hydrated panel; without
      // this settle the capture can come back as a flat frame (a few KB instead of tens).
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // overflow matters for the popup: Chrome sizes it to the content, so a page that
      // scrolls at the pinned size means the real popup would clip or scroll too
      const probe = await send('Runtime.evaluate', {
        expression: '({title: document.title, text: (document.body && document.body.innerText || "").slice(0, 240), ' +
          'scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, ' +
          'clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight})',
        returnByValue: true,
      }, sessionId);

      const shot = await send('Page.captureScreenshot',
        { format: 'png', captureBeyondViewport: false, fromSurface: true }, sessionId);
      const buffer = Buffer.from(shot.data, 'base64');
      const file = path.join(outDir, `screenshot-${path.basename(page, '.html')}-${width}x${height}.png`);
      fs.writeFileSync(file, buffer);
      const actual = PNG_SIZE(buffer);
      out.files.push({
        page, url, requested: { width, height }, actual,
        exact: actual.width === width && actual.height === height,
        readyState: ready, bytes: buffer.length, file: file.replace(/\\/g, '/'),
        title: probe && probe.result && probe.result.value ? probe.result.value.title : null,
        textHead: probe && probe.result && probe.result.value ? probe.result.value.text : null,
        fits: (() => {
          const v = probe && probe.result && probe.result.value;
          if (!v) return null;
          return v.scrollWidth <= v.clientWidth && v.scrollHeight <= v.clientHeight;
        })(),
        content: (() => {
          const v = probe && probe.result && probe.result.value;
          return v ? { width: v.scrollWidth, height: v.scrollHeight } : null;
        })(),
      });
      await send('Target.closeTarget', { targetId: created.targetId });
    }
    out.ok = out.files.length > 0 && out.files.every((entry) => entry.exact);
    done(out, out.ok ? 0 : 2);
  } catch (error) {
    out.error = error.message || String(error);
    done(out, 2);
  }
});
