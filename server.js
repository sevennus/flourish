/*
 * server.js — Flourish as a web app, served from the box Claude Code lives on.
 *
 * WHY THIS EXISTS
 * The Electron build is an SSH client: it logs into this VM from Windows and
 * runs `claude` here. That means an unsigned 142MB binary that reads a private
 * key and executes remote commands with permissions bypassed — which is, to a
 * heuristic scanner, indistinguishable from a RAT, because behaviourally it
 * isn't different. Defender was right to shout.
 *
 * But the app already can't do anything without this VM. So run it HERE and
 * skip the tunnel: no SSH, no key, no exe, no download, no AV. Jim opens a URL.
 *
 * This costs nothing visually. Chrome and Electron are the same Chromium — same
 * Skia, same GPU compositor, same anti-aliasing. The renderer still executes on
 * his Windows PC, on his GPU, at his refresh rate. This box only ships ~200KB of
 * text. (X-forwarding/VNC would render HERE and look awful; this is the opposite
 * of that.)
 *
 * Nothing about the UI changes: src/ is shared with the Electron build byte for
 * byte, and src/webapi.js re-implements the same window.flourishAPI surface that
 * preload.js exposes, over HTTP instead of IPC.
 *
 * Bound to 127.0.0.1 — nginx fronts it and enforces tailnet-only. See README.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { pickDemoResponse } = require('./src/demo');
const { translate, LineBuffer } = require('./src/ccstream');
const { buildArgs } = require('./src/bridge');

const PORT = Number(process.env.FLOURISH_PORT) || 8787;
const HOST = process.env.FLOURISH_HOST || '127.0.0.1';
const SRC = path.join(__dirname, 'src');

// --- config -----------------------------------------------------------------
// No host/username/key/passphrase: there is no SSH. What's left is what Claude
// Code itself needs. Auth is whatever `claude` already has on this box — this
// server never sees a credential, which is the entire point.
const DEFAULT_CONFIG = {
  cwd: '/var/www/simjim',
  claudePath: process.env.FLOURISH_CLAUDE || 'claude',
  model: '',
  bypass: true,
  demoMode: false,
};
const CONFIG_PATH = process.env.FLOURISH_CONFIG || path.join(__dirname, '.flourish-config.json');

function loadConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_CONFIG); }
}
function saveConfig(patch) {
  // Only ever persist known keys, so a stray field from the browser can't wander
  // into the object we later spread into spawn().
  const merged = loadConfig();
  for (const k of Object.keys(DEFAULT_CONFIG)) if (k in (patch || {})) merged[k] = patch[k];
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8'); }
  catch (e) { console.error('config save failed:', e.message); }
  return merged;
}

// --- static -----------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' || urlPath === '' ? 'index.html' : urlPath.replace(/^\/+/, '');
  // Resolve, then prove the result is still inside src/. Belt and braces against
  // ../ traversal — this process can read the whole tree, including the key it
  // no longer needs.
  const full = path.resolve(SRC, rel);
  if (full !== SRC && !full.startsWith(SRC + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream',
      // The whole point is that a reload shows the edit.
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

// --- chat streaming ---------------------------------------------------------
// One NDJSON line per event, streamed on the POST response itself. Not
// EventSource: that's GET-only, and a prompt doesn't belong in a URL.
let lastSessionId = null;
const active = new Map();

function send(res, obj) {
  if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n');
}

function streamDemo(res, requestId, text) {
  const chunks = (pickDemoResponse(text).match(/.{1,6}/gs)) || [];
  let i = 0;
  const h = { aborted: false, timer: null };
  const tick = () => {
    if (h.aborted || res.writableEnded) return;
    if (i >= chunks.length) { send(res, { t: 'done' }); active.delete(requestId); res.end(); return; }
    send(res, { t: 'delta', text: chunks[i++] });
    h.timer = setTimeout(tick, 14 + Math.floor(Math.random() * 22));
  };
  active.set(requestId, { abort: () => { h.aborted = true; clearTimeout(h.timer); } });
  tick();
}

function runClaude(res, requestId, userText, cfg) {
  const args = buildArgs(userText, cfg, lastSessionId);
  let child;
  try {
    child = spawn(cfg.claudePath || 'claude', args, {
      cwd: cfg.cwd && cfg.cwd.trim() ? cfg.cwd.trim() : process.cwd(),
      // stdin closed, or Claude Code waits 3s for input that never comes —
      // the same reason the SSH path appends `< /dev/null`.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    send(res, { t: 'error', message: 'could not start claude: ' + e.message });
    res.end(); return;
  }

  const lb = new LineBuffer();
  const toolByIndex = new Map();
  let stderr = '';
  let gotDone = false;

  active.set(requestId, { abort: () => { try { child.kill('SIGTERM'); } catch {} } });

  const handle = (obj) => {
    for (const ev of translate(obj)) {
      if (ev.t === 'text') send(res, { t: 'delta', text: ev.value });
      else if (ev.t === 'tool-start') { toolByIndex.set(ev.index, ev.name); send(res, { t: 'tool', phase: 'start', name: ev.name }); }
      else if (ev.t === 'block-stop') {
        const n = toolByIndex.get(ev.index);
        if (n) { toolByIndex.delete(ev.index); send(res, { t: 'tool', phase: 'end', name: n }); }
      } else if (ev.t === 'session') { if (ev.id) lastSessionId = ev.id; }
      else if (ev.t === 'done') {
        gotDone = true;
        if (ev.sessionId) lastSessionId = ev.sessionId;
        send(res, { t: 'done', cost: ev.cost, isError: ev.isError });
        if (ev.isError && ev.result) send(res, { t: 'error', message: String(ev.result).slice(0, 400) });
      }
    }
  };

  child.stdout.on('data', (d) => { for (const o of lb.push(d.toString('utf8'))) handle(o); });
  child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
  child.on('error', (e) => { send(res, { t: 'error', message: 'claude failed to start: ' + e.message }); });
  child.on('close', (code) => {
    for (const o of lb.flush()) handle(o);
    active.delete(requestId);
    if (!gotDone) {
      const msg = (stderr.trim() || `claude exited with code ${code}`)
        .split('\n').filter((l) => !/no stdin data received/i.test(l)).join('\n').slice(0, 500);
      if (code) send(res, { t: 'error', message: msg || `exit ${code}` });
      else send(res, { t: 'done' });
    }
    res.end();
  });
}

// --- routing ----------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (d) => {
      b += d;
      if (b.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  // nginx strips the /flourish/ prefix, but tolerate it so the server is also
  // usable directly on :8787 without a proxy in front.
  //
  // The lookahead is load-bearing. /^\/flourish/ also matches the START of
  // "/flourish.js" — this app's own core module — rewriting it to ".js" and
  // 404ing the one file the renderer cannot start without. Only strip the
  // prefix when it is a whole path segment.
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/^\/flourish(?=\/|$)/, '') || '/';

  try {
    if (req.method === 'GET' && p === '/api/config') return json(res, 200, loadConfig());
    if (req.method === 'POST' && p === '/api/config') return json(res, 200, saveConfig(await readBody(req)));
    if (req.method === 'POST' && p === '/api/session/reset') { lastSessionId = null; return json(res, 200, { ok: true }); }

    if (req.method === 'GET' && p === '/api/build') {
      let info = { sha: 'unstamped', branch: '?', dirty: true };
      try { info = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); } catch {}
      // Served live off the working tree: the UI and the shell are the same
      // commit, always. The drift the Electron build has is structural there and
      // absent here — nothing is packaged, so nothing can lag.
      return json(res, 200, Object.assign(info, { live: true, web: true }));
    }

    if (req.method === 'POST' && p === '/api/chat') {
      const { requestId, text } = await readBody(req);
      const cfg = loadConfig();
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',   // or nginx buffers the stream and the typewriter arrives all at once
      });
      req.on('close', () => { const a = active.get(requestId); if (a) { a.abort(); active.delete(requestId); } });
      if (cfg.demoMode) streamDemo(res, requestId, text);
      else runClaude(res, requestId, text, cfg);
      return;
    }

    if (req.method === 'POST' && p === '/api/abort') {
      const { requestId } = await readBody(req);
      const a = active.get(requestId);
      if (a) { a.abort(); active.delete(requestId); }
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') return serveStatic(req, res, p);
    res.writeHead(405).end('method not allowed');
  } catch (e) {
    json(res, 400, { error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = loadConfig();
  console.log(`Flourish web on http://${HOST}:${PORT}  (cwd ${cfg.cwd}, ${cfg.demoMode ? 'demo' : 'live'})`);
});
