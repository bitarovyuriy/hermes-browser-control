// load-extension.cjs — load the packaged extension into a running Chrome and probe it.
//
// Chrome >= 137 removed the --load-extension command-line flag from branded builds, so the
// supported automation path is the CDP `Extensions.loadUnpacked` command, which needs the
// browser to be launched with --enable-unsafe-extension-debugging.
//
// Usage: node load-extension.cjs <browser-ws-url> <abs-extension-path> [page-name]
// Prints one JSON line: {"ok":true,"id":"...","pageUrl":"...","pageTitle":"..."}
// Exit 0 = loaded and probed, 2 = not loaded.
const path = require('path');

const WS_MODULE = process.env.WS_MODULE || 'ws';
let WebSocket;
try {
  WebSocket = require(WS_MODULE);
} catch (error) {
  // No `ws` installed: fall back to Node's built-in global WebSocket (Node >= 22). The
  // MVP toolkit is dependency-free, so this is the normal path on this machine.
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

const [wsUrl, extPath, pageList = 'control/control.html,control/popup.html'] = process.argv.slice(2);
if (!wsUrl || !extPath) {
  console.log(JSON.stringify({ ok: false, error: 'usage: node load-extension.cjs <ws-url> <ext-path> [page[,page...]]' }));
  process.exit(2);
}
const pages = pageList.split(',').map((p) => p.trim()).filter(Boolean);

const result = { ok: false };
let nextId = 1;
const pending = new Map();
const ws = openSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const finish = (payload, code) => {
  console.log(JSON.stringify(payload));
  try { ws.close(); } catch { /* ignore */ }
  process.exit(code);
};

const timer = setTimeout(() => finish({ ...result, error: 'timeout' }, 2), 45000);

onSocket(ws, 'error', (error) => finish({ ...result, error: error.message || String(error) }, 2));

onSocket(ws, 'message', async (raw) => {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(`${msg.error.code ?? ''} ${msg.error.message}`.trim()));
    else resolve(msg.result);
  }
});

onSocket(ws, 'open', async () => {
  try {
    const loaded = await send('Extensions.loadUnpacked', { path: extPath });
    result.ok = true;
    result.id = loaded && loaded.id;
    result.manifestName = loaded && loaded.name;
    result.manifestVersion = loaded && loaded.version;

    // Probe real extension pages: creating the target proves the packaged HTML/CSS/JS
    // resolve inside the extension origin (a broken manifest or missing file fails here).
    // Both entry points are checked — the options page and the toolbar popup.
    result.files = [];
    for (const pageName of pages) {
      const pageUrl = `chrome-extension://${result.id}/${pageName}`;
      const created = await send('Target.createTarget', { url: pageUrl });
      const entry = { page: pageName, url: pageUrl, targetId: created && created.targetId };

      const attached = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
      const sessionId = attached && attached.sessionId;
      if (sessionId) {
        await send('Runtime.enable', {}, sessionId);
        const expression =
          '({title: document.title, ready: document.readyState, scripts: document.scripts.length, ' +
          'css: document.styleSheets.length, bodyLength: (document.body&&document.body.innerHTML.length)||0})';
        // Poll until the page has finished loading; a fresh target reports readyState=loading.
        for (let attempt = 0; attempt < 40; attempt += 1) {
          const evaluated = await send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
          const value = evaluated && evaluated.result && evaluated.result.value;
          if (value) {
            entry.body = value;
            if (value.ready === 'complete') break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      await send('Target.closeTarget', { targetId: created.targetId });
      if (!entry.body || entry.body.ready !== 'complete') {
        throw new Error(`page did not render: ${pageName}`);
      }
      result.files.push(entry);
    }

    // Back-compat: the first probed page also lands in the flat fields.
    const first = result.files[0];
    result.pageUrl = first.url;
    result.pageTargetId = first.targetId;
    result.page = first.body;
    clearTimeout(timer);
    finish(result, 0);
  } catch (error) {
    clearTimeout(timer);
    result.error = error.message || String(error);
    finish(result, 2);
  }
});
