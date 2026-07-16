/*
 * lightning-probe.js — does lightning actually grow, strike words, and set
 * them on fire, on the path a reader really takes?
 *
 * fx-shots photographs ONE frame of an effect, which was enough when a bolt was
 * painted whole on frame one and enough for nothing since. This effect is a
 * sequence: a leader jumps down in the dark, the return stroke lights the
 * channel, the word catches, the fire spreads, the channel decays. A single
 * still can show at most one of those and will happily show none of them while
 * looking fine — which is exactly how apophenia shipped drawing a straight rule
 * with a beautiful screenshot attached (see apophenia-probe.js, same trap).
 *
 * So: stream a REAL reply through the REAL renderer, let applyEvents wire up
 * wordAnchors and onStrike the way it does in production, and shoot a time
 * series relative to the moment fire() is actually called. Counts the burning
 * words on each frame, because "the word catches" is a claim about the DOM and
 * can be checked rather than admired.
 *
 *   xvfb-run -a ./node_modules/.bin/electron tools/lightning-probe.js --no-sandbox
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

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

// Several lines, so the anchor stratifier has lines to spread its picks over,
// and the directive at the end where the model would really put it.
const REPLY =
  'The deploy went out at nine and the alert fired six minutes later, which '
  + 'nobody noticed because that alert has cried wolf every morning since April '
  + 'and muting it is the first thing anyone does on arriving.\n\n'
  + 'By eleven the database had been read end to end twice and found blameless '
  + 'both times, and the configuration change nobody wanted to look at was still '
  + 'sitting there, small and reviewed by its own author.\n\n'
  + 'The fix took four seconds once somebody asked the obvious question out '
  + 'loud, which is the part of the timeline that always gets rounded off before '
  + 'the postmortem reaches anyone senior enough to mind.\n\n'
  + 'Every word on this page is a candidate, and the ones it hits are supposed '
  + 'to catch. {{fx:lightning}}';

// Relative to the frame fire() was called on. Dense early — the leader's whole
// life is ~200ms and that is the half of this Jim asked for.
const FRAMES = [0, 60, 120, 200, 300, 450, 650, 900, 1300, 1900, 2800];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    // show: true is mandatory — a hidden window throttles rAF to a crawl and
    // the typewriter never reaches the directive (see smoke.js's header).
    width: 1120, height: 700, show: true, backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  fs.mkdirSync(OUT, { recursive: true });

  // Record what the renderer really hands the engine, and when.
  await win.webContents.executeJavaScript(`
    window.__seen = null; window.__t0 = null; window.__strikes = 0;
    const proto = window.FlourishEffects.prototype;
    const orig = proto.fire;
    proto.fire = function (name, x, y, opts) {
      if (name === 'lightning') {
        window.__engine = this;
        window.__t0 = performance.now();
        window.__seen = {
          anchors: (opts && opts.anchors) ? opts.anchors.map(a => ({
            x: Math.round(a.x), y: Math.round(a.y),
            word: a.el ? a.el.textContent : null,
            claimed: !!a.el,
          })) : null,
          hasOnStrike: !!(opts && opts.onStrike),
        };
        // Count strikes CUMULATIVELY. Counting live bolts with .struck set
        // undercounts the moment the first bolt expires, and an undercount that
        // drifts downward reads exactly like an effect that isn't firing.
        if (opts && opts.onStrike) {
          const inner = opts.onStrike;
          opts.onStrike = (i) => { window.__strikes++; return inner(i); };
        }
      }
      return orig.call(this, name, x, y, opts);
    };
    true;
  `);

  const requestId = 'probe-1';
  win.webContents.send('session:auto', { requestId, userText: 'show me lightning' });
  for (const c of REPLY.match(/.{1,6}/gs) || []) {
    win.webContents.send('chat:delta', { requestId, text: c });
    await wait(4);
  }
  win.webContents.send('chat:done', { requestId });

  // Wait for the typewriter to actually reach the directive rather than
  // guessing at a delay — guessing is how you photograph the wrong moment.
  for (let i = 0; i < 400 && !(await win.webContents.executeJavaScript('window.__t0')); i++) {
    await wait(25);
  }
  const seen = await win.webContents.executeJavaScript('window.__seen');
  if (!seen) { console.error('lightning never fired — nothing to probe'); app.quit(); return; }

  const state = () => win.webContents.executeJavaScript(`
    (function () {
      const e = window.__engine;
      const bolts = (e && e.bolts) || [];
      return {
        t: Math.round(performance.now() - window.__t0),
        bolts: bolts.length,
        struck: window.__strikes,
        reveal: bolts.map(b => {
          const age = b.life - (b.delay || 0);
          if (age < 0) return 0;
          return +(age >= b.grow ? 1 : window.Flourish.revealAt(b.stair, age / b.grow)).toFixed(2);
        }),
        burning: document.querySelectorAll('#transcript .fx-burn').length,
      };
    })();
  `).catch(() => null);

  console.log('\n=== what fire() received ===');
  console.log('onStrike wired:', seen.hasOnStrike);
  console.log('anchors:', seen.anchors ? seen.anchors.length : 0);
  if (seen.anchors) {
    for (const a of seen.anchors) console.log(`  "${a.word}" at ${a.x},${a.y}`);
    const ys = seen.anchors.map((a) => a.y);
    console.log('y spread:', Math.max(...ys) - Math.min(...ys), 'px across the page');
  }

  console.log('\n=== the strike, frame by frame ===');
  console.log('   t(ms)  bolts  struck  burning  reveal');
  const rows = [];
  let last = 0;
  for (const at of FRAMES) {
    await wait(Math.max(0, at - last)); last = at;
    const s = await state();
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `lightning-t${String(at).padStart(4, '0')}.png`), img.toPNG());
    if (s) {
      rows.push(s);
      console.log(`  ${String(s.t).padStart(5)}  ${String(s.bolts).padStart(5)}  ${String(s.struck).padStart(6)}  ${String(s.burning).padStart(7)}  [${s.reveal.join(' ')}]`);
    }
  }

  // The claims, checked rather than admired.
  const maxBurning = Math.max(...rows.map((r) => r.burning));
  const maxStruck = Math.max(...rows.map((r) => r.struck));
  const grew = rows.some((r) => r.reveal.some((v) => v > 0 && v < 1));
  console.log('\n=== verdict ===');
  console.log('grew rather than appeared whole:', grew ? 'yes' : 'NO — caught no partial channel');
  console.log('words struck:', maxStruck);
  console.log('words set on fire:', maxBurning);
  console.log(`wrote ${FRAMES.length} frames to assets/fx/probe/`);

  app.quit();
});
