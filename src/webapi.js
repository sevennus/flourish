/*
 * webapi.js — window.flourishAPI for the browser, over HTTP instead of IPC.
 *
 * The renderer talks to exactly one narrow surface (preload.js exposes it in
 * Electron). Re-implementing that surface here means renderer.js, effects.js,
 * textfx.js and the rest run byte-for-byte identically in a browser tab and in
 * the .exe — no forks, no "web version" to drift.
 *
 * Loaded before renderer.js and NO-OPS if preload already provided the API, so
 * the same index.html serves both. Electron wins where both exist.
 */
'use strict';

(function () {
  if (window.flourishAPI) return;   // Electron: preload got here first.

  // nginx serves this under /flourish/; the dev server serves it at /. Deriving
  // the base from where this page actually lives keeps both working with no
  // build step and no configuration.
  const BASE = location.pathname.replace(/\/[^/]*$/, '/');
  const api = (p) => BASE + 'api/' + p;

  const listeners = { delta: [], tool: [], done: [], error: [], status: [], auto: [] };
  const on = (k) => (cb) => {
    listeners[k].push(cb);
    return () => { const i = listeners[k].indexOf(cb); if (i >= 0) listeners[k].splice(i, 1); };
  };
  const emit = (k, d) => { for (const cb of listeners[k].slice()) { try { cb(d); } catch (e) { console.error(e); } } };

  const getJSON = (p) => fetch(api(p), { cache: 'no-store' }).then((r) => r.json());
  const postJSON = (p, body) => fetch(api(p), {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

  const inflight = new Map();

  async function send({ requestId, text }) {
    const ctrl = new AbortController();
    inflight.set(requestId, ctrl);
    let res;
    try {
      res = await fetch(api('chat'), {
        method: 'POST', signal: ctrl.signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, text }),
      });
    } catch (e) {
      inflight.delete(requestId);
      // An aborted request is the user's own doing, not a failure to report.
      if (e.name !== 'AbortError') emit('error', { requestId, message: 'Server unreachable: ' + e.message });
      return;
    }
    if (!res.ok || !res.body) {
      inflight.delete(requestId);
      emit('error', { requestId, message: `Server returned ${res.status}` });
      return;
    }

    // NDJSON: one event per line. A chunk can split a line anywhere, so hold the
    // trailing partial until its newline arrives — otherwise JSON.parse throws
    // on a fragment and the reply dies mid-stream. (Flourish has had exactly one
    // reply-dies-mid-stream bug already; once was enough.)
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.t === 'delta') emit('delta', { requestId, text: ev.text });
          else if (ev.t === 'tool') emit('tool', { requestId, phase: ev.phase, name: ev.name });
          else if (ev.t === 'done') emit('done', { requestId, cost: ev.cost, isError: ev.isError });
          else if (ev.t === 'error') emit('error', { requestId, message: ev.message });
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') emit('error', { requestId, message: 'Stream broke: ' + e.message });
    } finally {
      inflight.delete(requestId);
    }
  }

  window.flourishAPI = {
    getConfig: () => getJSON('config'),
    saveConfig: (cfg) => postJSON('config', cfg),
    resetSession: () => postJSON('session/reset'),
    getBuild: () => getJSON('build'),

    // No SSH to test — the server runs where claude does. Answer honestly rather
    // than pretending to dial something.
    sshTest: async () => {
      try {
        const b = await getJSON('build');
        return { ok: true, message: `web mode — claude runs locally on the VM (build ${b.sha})` };
      } catch (e) { return { ok: false, message: 'server unreachable: ' + e.message }; }
    },

    send,
    abort: (requestId) => {
      const c = inflight.get(requestId);
      if (c) c.abort();
      inflight.delete(requestId);
      postJSON('abort', { requestId }).catch(() => {});
    },

    onDelta: on('delta'), onTool: on('tool'), onDone: on('done'),
    onError: on('error'), onStatus: on('status'), onAuto: on('auto'),
  };
})();
