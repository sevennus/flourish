/*
 * main.js — Electron main process for Flourish.
 *
 * Flourish is an SSH client: it logs into your VM and runs Claude Code
 * (`claude`) headless there, parsing its stream-json output and relaying text
 * deltas + tool activity to the renderer, which paints the flourishes. Nothing
 * is installed or run on the VM beyond the `claude` you already have. Your
 * Anthropic auth stays on the VM; only SSH credentials live in this app.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');

const { pickDemoResponse, SHOWCASE } = require('./src/demo');
const { translate, LineBuffer } = require('./src/ccstream');
const { shq, normalizeTarget, connectConfig, connSignature, buildCommand } = require('./src/bridge');

// Turn raw socket/auth errors into something a person can act on.
function friendlyError(err) {
  const m = (err && err.message) || String(err);
  if (/EAI_FAIL|ENOTFOUND|EAI_AGAIN/.test(m)) return "Can't resolve that host. Put only the IP or hostname in the Host field (not user@host), and the user in Username.";
  if (/ECONNREFUSED/.test(m)) return 'Connection refused — is SSH running on the VM at that host and port?';
  if (/ETIMEDOUT|timed?\s?out/i.test(m)) return 'Timed out reaching the VM — is it on and reachable from this machine (same network, or Tailscale up)?';
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return 'Network unreachable — is this machine on the same network as the VM (or Tailscale connected)?';
  if (/authentication methods failed|authentication/i.test(m)) return 'Authentication failed — check the username and your key or password.';
  if (/parse privateKey|key format|Unsupported key|no matching/i.test(m)) return 'SSH key problem: ' + m;
  return m;
}

// --- headless screenshot mode (used to verify the GUI from Linux) -----------
const SCREENSHOT = process.argv.includes('--screenshot') || process.env.FLOURISH_SCREENSHOT === '1';
const outArg = process.argv.find((a) => a.startsWith('--out='));
const SHOT_PATH = outArg ? outArg.slice('--out='.length)
  : path.join(process.cwd(), 'flourish-screenshot.png');
if (SCREENSHOT) app.disableHardwareAcceleration();

// --- config on disk ---------------------------------------------------------
const DEFAULT_CONFIG = {
  host: '',
  port: 22,
  username: '',
  authMethod: 'key',        // 'key' | 'password' | 'agent'
  privateKeyPath: '',
  passphrase: '',
  password: '',
  cwd: '',                  // remote working dir for claude (project root)
  claudePath: 'claude',     // override if not on PATH
  model: '',                // blank = Claude Code's default
  bypass: true,             // run claude with --permission-mode bypassPermissions
  demoMode: false,
};

function configPath() { return path.join(app.getPath('userData'), 'config.json'); }
function loadConfig() {
  try { return Object.assign({}, DEFAULT_CONFIG, JSON.parse(fs.readFileSync(configPath(), 'utf8'))); }
  catch { return Object.assign({}, DEFAULT_CONFIG); }
}
function saveConfig(cfg) {
  const merged = Object.assign(loadConfig(), cfg || {});
  try { fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(merged, null, 2), 'utf8'); }
  catch (e) { console.error('config save failed', e); }
  return merged;
}

// --- SSH connection (one reused per config) ---------------------------------
let win = null;
let conn = null;
let connReady = false;
let connSig = '';
let lastSessionId = null;
const activeStreams = new Map();

function status(payload) { if (win && !win.isDestroyed()) win.webContents.send('ssh:status', payload); }

function getConnection(cfg) {
  return new Promise((resolve, reject) => {
    const sig = connSignature(cfg);
    if (conn && connReady && sig === connSig) return resolve(conn);
    if (conn) { try { conn.end(); } catch {} conn = null; connReady = false; }
    connSig = sig;
    const t = normalizeTarget(cfg);
    const target = `${t.username}@${t.host}`;
    status({ state: 'connecting', target });
    const c = new Client();
    let settled = false;
    c.on('ready', () => { conn = c; connReady = true; settled = true;
      status({ state: 'connected', target }); resolve(c); });
    c.on('error', (err) => { connReady = false;
      status({ state: 'error', message: err.message });
      if (!settled) { settled = true; reject(err); } });
    c.on('close', () => { if (conn === c) { conn = null; connReady = false; }
      status({ state: 'closed' }); });
    try { c.connect(connectConfig(cfg)); }
    catch (err) { settled = true; reject(err); }
  });
}

// --- run claude over SSH ----------------------------------------------------
async function runClaude(sender, requestId, userText, cfg) {
  let ssh;
  try { ssh = await getConnection(cfg); }
  catch (err) { sender.send('chat:error', { requestId, message: 'SSH: ' + friendlyError(err) }); return; }

  const cmd = buildCommand(userText, cfg, lastSessionId);
  ssh.exec(cmd, (err, stream) => {
    if (err) { sender.send('chat:error', { requestId, message: 'exec failed: ' + err.message }); return; }
    const lb = new LineBuffer();
    const toolByIndex = new Map();
    let stderr = '';
    let gotDone = false;

    activeStreams.set(requestId, { abort: () => { try { stream.signal('TERM'); } catch {} try { stream.close(); } catch {} } });

    const handle = (obj) => {
      for (const ev of translate(obj)) {
        if (ev.t === 'text') sender.send('chat:delta', { requestId, text: ev.value });
        else if (ev.t === 'tool-start') { toolByIndex.set(ev.index, ev.name);
          sender.send('chat:tool', { requestId, phase: 'start', name: ev.name }); }
        else if (ev.t === 'block-stop') { const n = toolByIndex.get(ev.index);
          if (n) { toolByIndex.delete(ev.index); sender.send('chat:tool', { requestId, phase: 'end', name: n }); } }
        else if (ev.t === 'session') { if (ev.id) lastSessionId = ev.id; }
        else if (ev.t === 'done') { gotDone = true; if (ev.sessionId) lastSessionId = ev.sessionId;
          sender.send('chat:done', { requestId, cost: ev.cost, isError: ev.isError });
          if (ev.isError && ev.result) sender.send('chat:error', { requestId, message: String(ev.result).slice(0, 400) }); }
      }
    };

    stream.on('data', (d) => { for (const o of lb.push(d.toString('utf8'))) handle(o); });
    stream.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    stream.on('close', (code) => {
      for (const o of lb.flush()) handle(o);
      activeStreams.delete(requestId);
      if (!gotDone) {
        const msg = (stderr.trim() || `claude exited with code ${code}`)
          .split('\n').filter((l) => !/no stdin data received/i.test(l)).join('\n').slice(0, 500);
        if (code && code !== 0) sender.send('chat:error', { requestId, message: msg || `exit ${code}` });
        else sender.send('chat:done', { requestId });
      }
    });
  });
}

// --- demo streaming (no VM needed) ------------------------------------------
function streamDemo(sender, requestId, responseText) {
  const chunks = responseText.match(/.{1,6}/gs) || [];
  let i = 0;
  const h = { aborted: false, timer: null };
  const tick = () => {
    if (h.aborted) return;
    if (i >= chunks.length) { sender.send('chat:done', { requestId }); activeStreams.delete(requestId); return; }
    sender.send('chat:delta', { requestId, text: chunks[i++] });
    h.timer = setTimeout(tick, 14 + Math.floor(Math.random() * 22));
  };
  activeStreams.set(requestId, { abort: () => { h.aborted = true; if (h.timer) clearTimeout(h.timer); } });
  tick();
}

// --- IPC --------------------------------------------------------------------
ipcMain.handle('config:get', () => loadConfig());
ipcMain.handle('config:save', (_e, cfg) => saveConfig(cfg));
ipcMain.handle('session:reset', () => { lastSessionId = null; return true; });

ipcMain.handle('ssh:test', async (_e, cfg) => {
  try {
    const c = new Client();
    const ready = new Promise((res, rej) => {
      c.on('ready', res); c.on('error', rej);
      c.connect(connectConfig(Object.assign({}, DEFAULT_CONFIG, cfg)));
    });
    await ready;
    const out = await new Promise((res, rej) => {
      c.exec('bash -lc ' + shq((cfg.claudePath || 'claude') + ' --version'), (err, stream) => {
        if (err) return rej(err);
        let s = ''; stream.on('data', (d) => (s += d)); stream.stderr.on('data', () => {});
        stream.on('close', () => res(s.trim()));
      });
    });
    c.end();
    return { ok: true, message: out || 'connected; claude found' };
  } catch (err) { return { ok: false, message: friendlyError(err) }; }
});

ipcMain.on('chat:send', (event, payload) => {
  const { requestId, text } = payload || {};
  const cfg = loadConfig();
  if (cfg.demoMode) streamDemo(event.sender, requestId, pickDemoResponse(text));
  else runClaude(event.sender, requestId, text, cfg);
});

ipcMain.on('chat:abort', (_e, { requestId } = {}) => {
  const s = activeStreams.get(requestId);
  if (s) { s.abort(); activeStreams.delete(requestId); }
});

// --- window + screenshot ----------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1120, height: 720, minWidth: 640, minHeight: 420,
    backgroundColor: '#05070a', title: 'Flourish',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  if (SCREENSHOT) win.webContents.once('did-finish-load', () => runScreenshot());
}

async function runScreenshot() {
  const requestId = 'shot-1';
  win.webContents.send('session:auto', { requestId, userText: 'show me the effects' });
  setTimeout(() => streamDemo(win.webContents, requestId, SHOWCASE), 250);
  await new Promise((r) => setTimeout(r, 7600)); // the showcase runs ~8s end to end
  try { fs.writeFileSync(SHOT_PATH, (await win.webContents.capturePage()).toPNG());
    console.log('screenshot written:', SHOT_PATH); }
  catch (e) { console.error('capture failed', e); }
  app.quit();
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (conn) { try { conn.end(); } catch {} } if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
