/*
 * apophenia-probe.js — what does apophenia ACTUALLY draw on the real path?
 *
 * fx-shots fires `__fx.fire('apophenia', 560, 330)` with no opts, so o.anchors
 * is undefined and the effect takes its `pts.length < 3` fallback: eight
 * invented points in empty space. That is the committed assets/fx/apophenia.png.
 * The real path — applyEvents() setting o.anchors = wordAnchors(14) — has never
 * been photographed.
 *
 * This drives the REAL renderer with a REAL streamed reply, captures the
 * anchors fire() actually receives, and shoots the frame.
 *
 *   xvfb-run -a electron tools/apophenia-probe.js --no-sandbox
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// Stand in for main.js's IPC surface, demo mode forced on (as smoke.js does).
ipcMain.handle('config:get', () => ({
  host: '', port: 22, username: '', authMethod: 'key',
  privateKeyPath: '', passphrase: '', password: '',
  cwd: '', claudePath: 'claude', model: '', bypass: true, demoMode: true,
}));
ipcMain.handle('config:save', (_e, c) => c);
ipcMain.handle('session:reset', () => true);
ipcMain.handle('ssh:test', () => ({ ok: true, message: 'probe' }));
ipcMain.handle('build:get', () => ({ sha: 'probe', branch: 'probe', dirty: false, live: false }));
ipcMain.on('chat:abort', () => {});
ipcMain.on('chat:send', () => {});
const OUT = path.join(ROOT, 'assets', 'fx', 'probe');

// A reply shaped like the ones Jim actually reads: several lines of prose, and
// the directive at the end of the argument it's illustrating.
const REPLY =
  'The deploy failed on Tuesday. Tuesday is also when the cache was warm. '
  + 'Warm caches correlate with the mint palette, and mint was chosen the same '
  + 'week the renderer died. Therefore the palette killed the deploy.\n\n'
  + 'Latency rose after the schema change. The schema change shipped alongside '
  + 'the new font. Fonts are rendered by the same GPU that runs the particle '
  + 'canvas, and the particle canvas is what we added last month. So the '
  + 'flourishes are slowing down the API, and always have been.\n\n'
  + 'Every sentence above is asserted with exactly the same confidence as the '
  + 'one before it. {{fx:apophenia violet lg}} That is the whole point.';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // show: true is mandatory — a hidden BrowserWindow throttles rAF to a crawl
    // and the typewriter never reaches the directive (see smoke.js's header).
    width: 1120, height: 700, show: true, backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  fs.mkdirSync(OUT, { recursive: true });

  // Capture what the renderer really hands the engine.
  await win.webContents.executeJavaScript(`
    window.__seen = null;
    const proto = window.FlourishEffects.prototype;
    const orig = proto.fire;
    proto.fire = function (name, x, y, opts) {
      if (name === 'apophenia') {
        window.__engine = this;
        window.__seen = {
          x, y,
          anchors: (opts && opts.anchors) ? opts.anchors.map(a => ({x: Math.round(a.x), y: Math.round(a.y)})) : null,
          count: (opts && opts.anchors) ? opts.anchors.length : 0,
        };
      }
      return orig.call(this, name, x, y, opts);
    };
    true;
  `);

  const requestId = 'probe-1';
  win.webContents.send('session:auto', { requestId, userText: 'do it again' });
  for (const c of REPLY.match(/.{1,6}/gs) || []) {
    win.webContents.send('chat:delta', { requestId, text: c });
    await wait(4);
  }
  win.webContents.send('chat:done', { requestId });

  // Let the typewriter reach the directive, then catch the web mid-argument.
  await wait(4200);
  const seen = await win.webContents.executeJavaScript('window.__seen');
  const webs = await win.webContents.executeJavaScript(`
    (function () {
      const w = window.__engine && window.__engine.webs;
      return w ? { pairs: w.pairs.length, pts: w.pts.length, life: Math.round(w.life) } : null;
    })();
  `).catch(() => null);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'apophenia-real-path.png'), img.toPNG());

  console.log('\n=== what fire() received ===');
  console.log(JSON.stringify(seen, null, 2));
  console.log('\n=== engine webs state ===');
  console.log(JSON.stringify(webs));

  if (seen && seen.anchors && seen.anchors.length) {
    const ys = seen.anchors.map((a) => a.y);
    const xs = seen.anchors.map((a) => a.x);
    console.log('\n=== anchor spread ===');
    console.log('anchors:', seen.anchors.length);
    console.log('x range:', Math.min(...xs), '→', Math.max(...xs), '=', Math.max(...xs) - Math.min(...xs), 'px');
    console.log('y range:', Math.min(...ys), '→', Math.max(...ys), '=', Math.max(...ys) - Math.min(...ys), 'px');
    console.log('distinct text lines (distinct y):', new Set(ys).size);
    console.log('anchorsFlat (would fall back):',
      await win.webContents.executeJavaScript(
        `window.Flourish.anchorsFlat(${JSON.stringify(seen.anchors)})`));
  }

  app.quit();
});
