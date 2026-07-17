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
// --web drops the preload entirely, so src/webapi.js has to provide
// window.flourishAPI over HTTP against the real server — i.e. exactly what
// Chrome on Jim's PC does. Without this flag we'd be testing Electron's IPC and
// calling it proof about a browser.
const WEB = process.argv.includes('--web');

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} - ${msg}`); };

// In web mode the reply must come from the server, so put it in demo mode for
// the run (deterministic, free) and hand the config back exactly as found.
async function withDemoMode(base, fn) {
  const cfgUrl = base.replace(/\/$/, '') + '/api/config';
  let saved = null;
  try {
    saved = await (await fetch(cfgUrl)).json();
    await fetch(cfgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ demoMode: true }) });
  } catch (e) { failures.push('could not reach the server to set demo mode: ' + e.message); }
  try { return await fn(); }
  finally {
    if (saved) {
      try {
        await fetch(cfgUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ demoMode: saved.demoMode }) });
      } catch { console.error('WARNING: could not restore demoMode — check /api/config'); }
    }
  }
}

async function main() {
  const win = new BrowserWindow({
    width: 1120, height: 720, show: true, backgroundColor: '#05070a',
    webPreferences: {
      // No preload in web mode: that's the whole point of the test.
      ...(WEB ? {} : { preload: path.join(ROOT, 'preload.js') }),
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

  if (WEB) {
    // Drive it the way a person does: type, press Enter, and let webapi.js ask
    // the real server over the real network. Nothing is faked.
    await win.webContents.executeJavaScript(`
      document.getElementById('input').value = 'show me the effects';
      document.getElementById('input-row').dispatchEvent(
        new Event('submit', { cancelable: true, bubbles: true }));
      true;
    `);
  } else {
    const requestId = 'smoke-1';
    win.webContents.send('session:auto', { requestId, userText: 'show me the effects' });

    // Stream the showcase the way the real server does — ~14ms per 6-char
    // chunk (server.js: 14 + rand(22)). This is NOT cosmetic: at the old 4ms
    // the whole reel arrived in a ~6s firehose, so every scene in it was alive
    // at once — a ~50-deep pile of ASCII scenes that software GL (xvfb) can't
    // draw, stalling the typewriter past the deadline. The real app never does
    // that; it paces the stream so the scenes spread out. Match the app, and
    // the pile never forms.
    const chunks = SHOWCASE.match(/.{1,6}/gs) || [];
    for (const c of chunks) {
      win.webContents.send('chat:delta', { requestId, text: c });
      await new Promise((r) => setTimeout(r, 14));
    }
    win.webContents.send('chat:done', { requestId });
  }

  // The reply is finished when the button stops offering to stop it.
  //
  // This used to poll `!input.disabled`, which was wrong twice over. The input
  // is never disabled now (you must be able to type and interrupt mid-reply),
  // so it reads true instantly and the transcript gets checked mid-stream. And
  // when it DID work, it was asserting the very thing Jim was complaining
  // about — "input re-enabled after the reply" passed green for days while the
  // box was dead for the entire reply, which is what he actually meant.
  // Patience scales with the reply. The showcase is a long reel now (every
  // effect, fired more than once), and at ~14ms/chunk it takes tens of seconds
  // just to stream, before the typewriter drains it. A fixed 25s deadline was
  // calibrated for the old one-pass tour; budget from the actual streamed
  // length instead (~14ms per 6 chars streamed, plus a floor and headroom for
  // the drain) so a longer demo gets proportionally longer to land — without
  // going mute if the reply genuinely hangs.
  const streamMs = SHOWCASE.length / 6 * 14;
  const deadline = Date.now() + Math.max(WEB ? 45000 : 25000, streamMs + 30000);
  let ready = false;
  while (Date.now() < deadline) {
    ready = await win.webContents.executeJavaScript(
      'document.getElementById("send-btn").textContent.trim() === "send"');
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  const text = await win.webContents.executeJavaScript(
    'document.getElementById("transcript").innerText'
  );

  console.log('');
  check(consoleErrors.length === 0, 'renderer logs no errors' +
    (consoleErrors.length ? '\n       ' + consoleErrors.slice(0, 5).join('\n       ') : ''));
  check(ready, 'the reply finishes and the button returns to "send"');
  // Interaction is interactive.test.js's job — it drives the box mid-reply,
  // which is the thing this file was quietly getting wrong.
  check(await win.webContents.executeJavaScript('!document.getElementById("input").disabled'),
    'the input is never left disabled');
  check(!/\{\{fx:|\{\{\/fx:/.test(text), 'no raw {{fx:}} directives leak into the transcript');

  // The showcase's last words. If the stream dies partway, this is what tells
  // us — rather than a screenshot that looks plausible down to "Welcome".
  check(text.includes('watch the prompt box itself'),
    'the whole reply lands, first word to last');

  // Spot-check text from each paragraph, so a stall in the middle can't hide.
  //
  // Every phrase here has to sit OUTSIDE a rot/confabulate span. Those spans
  // rewrite their own characters seconds after landing, so a phrase checked
  // from inside one would pass or fail on timing — and a flaky assertion is
  // worse than no assertion, which is the lesson this whole file exists to
  // remember.
  for (const phrase of ['a terminal that paints as it speaks', 'The quiet ones',
    'The working ones', 'The moods', 'The loud ones', 'a nova',
    'The unreliable ones', 'Then it just stops for a beat']) {
    check(text.includes(phrase), `renders: "${phrase}"`);
  }

  // salvage is the one span in the showcase that every check above is blind to.
  // Its characters start at opacity 0 (styles.css) and are only turned on as
  // their flown-in copies land, so a salvage that never revealed would leave a
  // sentence that is present in the DOM, counted by innerText, and completely
  // invisible on screen — passing every assertion in this file while being the
  // worst failure in it. Ask the computed style instead: opacity is exactly the
  // thing innerText doesn't see.
  const salvage = await win.webContents.executeJavaScript(`
    (function () {
      const cs = [...document.querySelectorAll('#transcript .fx-salvage > i')];
      return { n: cs.length, shown: cs.filter(i => getComputedStyle(i).opacity === '1').length };
    })()
  `);
  check(salvage.n > 0, 'the salvage span rendered its characters at all');
  check(salvage.n > 0 && salvage.shown === salvage.n,
    `salvage revealed every character (${salvage.shown}/${salvage.n} visible)`);

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'PASSED'} — smoke\n`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

const run = () => (WEB && URL_ARG) ? withDemoMode(URL_ARG, main) : main();
app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
