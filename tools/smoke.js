/*
 * smoke.js — does the app actually run?
 *
 * The unit tests check the pure parts (parser, bridge, scroller) and they were
 * all green while the renderer was dead on the first directive: a duplicate
 * appendText() declaration threw on every reply, so the typewriter's rAF loop
 * died mid-stream and the input stayed disabled forever. Nothing in `npm test`
 * loads the renderer, and `npm run screenshot` happily wrote a PNG of the
 * wreckage and exited 0.
 *
 * So this drives the real renderer, over the real preload bridge, with the real
 * demo stream, and fails loudly if the reply doesn't land whole.
 *
 * Run: npm run smoke                              (the files in this checkout)
 *      npm run smoke -- --url=http://vm/flourish/ (what the live UI actually serves)
 *
 * The --url form matters: once the app loads its renderer off the VM, "works in
 * the checkout" and "works in Jim's window" are different claims, and only the
 * second one is the one he'll experience.
 *
 * Must run with a VISIBLE window under xvfb — a hidden BrowserWindow throttles
 * requestAnimationFrame to a crawl and the typewriter never finishes.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { SHOWCASE } = require(path.join(ROOT, 'src', 'demo'));

app.disableHardwareAcceleration();

// Stand in for main.js's IPC surface, demo mode forced on.
ipcMain.handle('config:get', () => ({
  host: '', port: 22, username: '', authMethod: 'key',
  privateKeyPath: '', passphrase: '', password: '',
  cwd: '', claudePath: 'claude', model: '', bypass: true, demoMode: true,
}));
ipcMain.handle('config:save', (_e, c) => c);
ipcMain.handle('session:reset', () => true);
ipcMain.handle('ssh:test', () => ({ ok: true, message: 'smoke' }));
ipcMain.handle('build:get', () => ({ sha: 'smoke', branch: 'smoke', dirty: false, live: !!URL_ARG }));
ipcMain.on('chat:abort', () => {});
ipcMain.on('chat:send', () => {});

const urlArg = process.argv.find((a) => a.startsWith('--url='));
const URL_ARG = urlArg ? urlArg.slice('--url='.length) : '';

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} - ${msg}`); };

async function main() {
  const win = new BrowserWindow({
    width: 1120, height: 720, show: true, backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  // Catches renderer exceptions from the very first script, before any
  // listener we could inject would exist.
  //
  // Electron's own "Insecure Resources" warning is filtered — and ONLY that
  // one, by exact text, never a blanket level filter, because muting the
  // channel that said "str.indexOf is not a function" would undo this file.
  // It fires because --url= serves over http. That's a considered choice, not
  // an oversight: the dev loop rides Tailscale, which is WireGuard-encrypted
  // end to end, and nginx refuses /flourish/ to anything off the tailnet. It
  // also never fires for a real user — Electron only warns in unpackaged dev.
  const IGNORE = /Electron Security Warning/;
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 && !IGNORE.test(message)) consoleErrors.push(`${message} (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    failures.push('renderer process gone: ' + JSON.stringify(d));
  });

  console.log(`# target: ${URL_ARG || path.join(ROOT, 'src', 'index.html')}\n`);
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code !== -3) failures.push(`did-fail-load ${code} ${desc} — ${url}`);
  });
  if (URL_ARG) win.loadURL(URL_ARG);
  else win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => win.webContents.once('did-finish-load', r));

  const requestId = 'smoke-1';
  win.webContents.send('session:auto', { requestId, userText: 'show me the effects' });

  // Stream the showcase the way main.js's streamDemo does.
  const chunks = SHOWCASE.match(/.{1,6}/gs) || [];
  for (const c of chunks) {
    win.webContents.send('chat:delta', { requestId, text: c });
    await new Promise((r) => setTimeout(r, 4));
  }
  win.webContents.send('chat:done', { requestId });

  // The reply is finished when the renderer hands the prompt back.
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await win.webContents.executeJavaScript('!document.getElementById("input").disabled');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const text = await win.webContents.executeJavaScript(
    'document.getElementById("transcript").innerText'
  );

  console.log('');
  check(consoleErrors.length === 0, 'renderer logs no errors' +
    (consoleErrors.length ? '\n       ' + consoleErrors.slice(0, 5).join('\n       ') : ''));
  check(ready, 'input is re-enabled after the reply (you can type the next prompt)');
  check(!/\{\{fx:|\{\{\/fx:/.test(text), 'no raw {{fx:}} directives leak into the transcript');

  // The showcase's last words. If the stream dies partway, this is what tells
  // us — rather than a screenshot that looks plausible down to "Welcome".
  check(text.includes('watch the prompt box itself'),
    'the whole reply lands, first word to last');

  // Spot-check text from each paragraph, so a stall in the middle can't hide.
  for (const phrase of ['a terminal that paints as it speaks', 'The quiet ones',
    'The working ones', 'The moods', 'The loud ones', 'a nova']) {
    check(text.includes(phrase), `renders: "${phrase}"`);
  }

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'PASSED'} — smoke\n`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
