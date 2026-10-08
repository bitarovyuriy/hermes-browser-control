/**
 * Content script: the banner-free half of the agent.
 *
 * Runs in the isolated world of every allowlisted origin. Implements the verbs
 * that a page can do for itself (navigate, click, type, hover, scroll, read DOM,
 * in-page fetch) plus the on-page indicators: HUD ("agent controls this tab"),
 * element badges and the agent pointer.
 *
 * Injected by manifest declaration only — this slice never requests the
 * `scripting` permission, so nothing is injected behind the user's back.
 */

(() => {
  if (globalThis.__hermesContentScriptLoaded) return;
  globalThis.__hermesContentScriptLoaded = true;

  const LAYER_ID = '__hermes_agent_layer';
  let layer = null;
  let pointerTimer = null;

  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    const host = document.createElement('div');
    host.id = LAYER_ID;
    host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .hud {
          position: fixed; top: 8px; right: 8px; max-width: 320px;
          font: 12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif;
          background: #111c; color: #eaf2ff; border: 1px solid #4f8cff;
          border-radius: 8px; padding: 6px 10px; pointer-events: none;
          box-shadow: 0 4px 16px #0006; white-space: pre-wrap;
        }
        .hud[hidden] { display: none; }
        .hud b { color: #8ab4ff; }
        .pointer {
          position: fixed; width: 18px; height: 18px; margin: -9px 0 0 -9px;
          border-radius: 50%; border: 2px solid #ff4d6d; background: #ff4d6d33;
          transition: transform 120ms ease-out; pointer-events: none;
        }
        .pointer[hidden] { display: none; }
        .badge {
          position: fixed; font: 11px/1 monospace; background: #4f8cff; color: #fff;
          border-radius: 4px 4px 4px 0; padding: 2px 5px; pointer-events: none;
        }
        .outline { position: fixed; border: 2px solid #4f8cff; border-radius: 3px; pointer-events: none; }
      </style>
      <div class="hud" hidden></div>
      <div class="pointer" hidden></div>
      <div class="marks"></div>
    `;
    (document.body || document.documentElement).appendChild(host);
    layer = { host, shadow, hud: shadow.querySelector('.hud'), pointer: shadow.querySelector('.pointer'), marks: shadow.querySelector('.marks') };
    return layer;
  }

  function hud(args) {
    const l = ensureLayer();
    if (args.action === 'hide') {
      l.hud.hidden = true;
      l.marks.textContent = '';
      l.pointer.hidden = true;
      return { ok: true, action: 'hide' };
    }
    l.hud.hidden = false;
    const bits = ['agent controls this tab'];
    if (args.mode) bits.push(`mode: ${args.mode}`);
    if (typeof args.revision === 'number') bits.push(`rev ${args.revision}`);
    if (args.via) bits.push(`via ${args.via}`);
    if (args.text) bits.push(String(args.text));
    l.hud.textContent = bits.join(' · ');
    return { ok: true, action: 'show', text: l.hud.textContent };
  }

  function pointer(args) {
    const l = ensureLayer();
    const x = Number(args.x ?? 0);
    const y = Number(args.y ?? 0);
    l.pointer.hidden = false;
    l.pointer.style.left = `${x}px`;
    l.pointer.style.top = `${y}px`;
    clearTimeout(pointerTimer);
    pointerTimer = setTimeout(() => {
      if (l && l.pointer) l.pointer.hidden = true;
    }, Number(args.ttlMs ?? 1500));
    return { ok: true, x, y, label: args.label || null };
  }

  function badge(args) {
    const l = ensureLayer();
    l.marks.textContent = '';
    const selector = args.selector || 'a, button, input, textarea, select';
    const nodes = [...document.querySelectorAll(selector)].slice(0, Number(args.limit ?? 40));
    nodes.forEach((el, index) => {
      const r = el.getBoundingClientRect();
      const outline = document.createElement('div');
      outline.className = 'outline';
      outline.style.cssText += `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px;`;
      const label = document.createElement('div');
      label.className = 'badge';
      label.style.cssText += `left:${r.left}px; top:${Math.max(0, r.top - 16)}px;`;
      label.textContent = String(index + 1);
      l.marks.append(outline, label);
    });
    return { ok: true, count: nodes.length, selector };
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function find(selector) {
    const el = document.querySelector(selector);
    if (!el) throw Object.assign(new Error(`selector not found: ${selector}`), { code: 'selector-not-found' });
    return el;
  }

  const ops = {
    ping: () => ({ ok: true, url: location.href, title: document.title, readyState: document.readyState }),

    navigate: (args) => {
      const url = String(args.url);
      location.href = url;
      return { ok: true, url, state: 'navigating' };
    },

    click: (args) => {
      const el = find(args.selector);
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      pointer({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: `click ${args.selector}` });
      el.click();
      return { ok: true, selector: args.selector, tag: el.tagName.toLowerCase(), text: (el.textContent || '').trim().slice(0, 200) };
    },

    type: (args) => {
      const el = find(args.selector);
      el.scrollIntoView({ block: 'center' });
      if (typeof el.focus === 'function') el.focus();
      setNativeValue(el, String(args.text ?? ''));
      if (args.submit) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        if (typeof el.form !== 'undefined' && el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit();
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
      return { ok: true, selector: args.selector, value: el.value };
    },

    hover: (args) => {
      const el = find(args.selector);
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      pointer({ x: r.left + r.width / 2, y: r.top + r.height / 2, label: `hover ${args.selector}` });
      for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
      }
      return { ok: true, selector: args.selector };
    },

    scroll: (args) => {
      if (args.selector) find(args.selector).scrollIntoView({ block: args.block || 'center' });
      else window.scrollBy(Number(args.x ?? 0), Number(args.y ?? 400));
      return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX };
    },

    readDom: () => ({
      ok: true,
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      html: document.documentElement.outerHTML,
      text: document.body ? document.body.innerText : '',
    }),

    getText: (args) => ({ ok: true, selector: args.selector, text: find(args.selector).textContent }),

    waitFor: async (args) => {
      const deadline = Date.now() + Number(args.timeoutMs ?? 5000);
      while (Date.now() < deadline) {
        if (document.querySelector(args.selector)) return { ok: true, selector: args.selector, found: true };
        await new Promise((r) => setTimeout(r, 100));
      }
      return { ok: true, selector: args.selector, found: false };
    },

    responseText: async (args) => {
      const url = String(args.url || location.href);
      const response = await fetch(url, { credentials: 'include' });
      const text = await response.text();
      return { ok: true, url, status: response.status, text };
    },

    badge,
    pointer,
    hud,
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== 'hermes/content') return false;
    const op = ops[message.op];
    if (!op) {
      sendResponse({ ok: false, error: `unknown content op: ${message.op}`, code: 'unknown-op' });
      return false;
    }
    Promise.resolve()
      .then(() => op(message.args || {}))
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err), code: (err && err.code) || 'content-failed' }));
    return true; // async response
  });

  // Announce ourselves once so the controller's first ping is fast.
  try {
    chrome.runtime.sendMessage({ type: 'hermes/content-ready', url: location.href });
  } catch {
    /* no receiver is fine */
  }
})();
