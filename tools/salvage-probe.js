/*
 * salvage-probe.js — do salvaged letters actually come from letters?
 *
 * salvage has a fallback, and the fallback is the whole problem with testing
 * it. When no source for a character can be found on screen, the copy flies in
 * from a random point in the window instead — and that looks EXACTLY like the
 * real thing. Letters still converge, the line still assembles, a screenshot is
 * still beautiful. An implementation whose source lookup returned nothing at
 * all would photograph identically to one that works.
 *
 * This repo has shipped that exact bug with a picture attached before:
 * apophenia's shot was of its own fallback path (see apophenia-probe.js), and
 * fx-shots exits 0 no matter what is in the PNG. So a picture is not the
 * evidence here. The evidence is a count.
 *
 * The check deliberately does not ask salvage anything. For every flier it asks
 * the DOM, via caretRangeFromPoint, what character is really sitting at that
 * coordinate — an independent oracle that a broken _source() cannot fool,
 * because it never consults _source():
 *
 *   at launch: is there really an `e` where this `e` claims to have come from?
 *   at landing: is there really an `e` where this `e` came to rest?
 *
 * The second one is not a bonus. Both endpoints are viewport coordinates of
 * text that is still scrolling — the typewriter appends below while the scroll
 * spring chases it — so a flier that ignored drift would land on whatever line
 * had slid into its target's old position. That reads as sloppy rendering, not
 * as a bug, which is exactly why it needs a number.
 *
 *   xvfb-run -a ./node_modules/.bin/electron tools/salvage-probe.js --no-sandbox
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

// Long enough to scroll and to give the letters plenty to steal from, with the
// span at the end where the model would really put it. The span's own text uses
// nothing exotic on purpose: every letter in it should be findable above, so a
// fallback in the results means a real miss rather than a rare character.
const REPLY =
  'The runbook is nine pages long and about a third of it is true. Another '
  + 'third was true once, and the last third describes a subsystem that has '
  + 'never existed in any environment anyone can find.\n\n'
  + 'It is written in exactly the same tone throughout, which is the whole '
  + 'problem with tone. The parts that work and the parts that are fiction read '
  + 'identically, and the reader has no way to tell them apart.\n\n'
  + 'Nobody can prove what depends on the machine, so every quarter the ticket '
  + 'to decommission it dies the same quiet death, and the fear stays exactly '
  + 'where it was.\n\n'
  + '{{fx:salvage}}not one letter of this sentence is new{{/fx:salvage}}';

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

  await win.webContents.executeJavaScript(`
    window.__fliers = [];
    window.__fellBack = 0;
    window.__sourced = 0;

    // What character is REALLY at this point? The independent oracle. Walks up
    // from the caret position and reads the actual text node, so it is blind to
    // everything salvage believes about itself.
    window.__charAt = function (x, y) {
      const r = document.caretRangeFromPoint(x, y);
      if (!r || !r.startContainer || r.startContainer.nodeType !== 3) return null;
      const t = r.startContainer.nodeValue;
      // caretRangeFromPoint lands BETWEEN characters, so the glyph under the
      // point is on one side or the other depending on which half was hit.
      // Accept either — this is asking "is there an e here", not "which e".
      return [t[r.startOffset], t[r.startOffset - 1]].filter(Boolean);
    };

    // Count the fallback at its source rather than inferring it.
    const tfx = window.FlourishTextFX.prototype;
    const origElsewhere = tfx._elsewhere;
    tfx._elsewhere = function (to) { window.__fellBack++; return origElsewhere.call(this, to); };
    const origSource = tfx._source;
    tfx._source = function (idx, ch) {
      const r = origSource.call(this, idx, ch);
      if (r) window.__sourced++;
      return r;
    };

    // Intercept every flier: check its origin the instant it launches (the
    // coordinate is only meaningful before the page scrolls again), and its
    // landing point the instant it arrives.
    const eng = window.FlourishEffects.prototype;
    const origFly = eng.glyphFly;
    eng.glyphFly = function (x0, y0, x1, y1, ch, o) {
      window.__engine = this;
      const rec = {
        ch,
        from: { x: Math.round(x0), y: Math.round(y0) },
        fromChars: window.__charAt(x0, y0),
        landChars: null,
        landedAt: null,
      };
      window.__fliers.push(rec);
      const inner = o && o.onLand;
      const opts = Object.assign({}, o, {
        onLand: () => {
          // The particle is the last one pushed; read where it actually ended
          // up rather than where it was aimed.
          const ps = window.__engine.particles;
          const p = rec.__p;
          if (p) {
            rec.landedAt = { x: Math.round(p.x), y: Math.round(p.y) };
            rec.landChars = window.__charAt(p.x, p.y);
          }
          if (inner) inner();
        },
      });
      const out = origFly.call(this, x0, y0, x1, y1, ch, opts);
      rec.__p = this.particles[this.particles.length - 1];
      return out;
    };
    true;
  `);

  const requestId = 'probe-1';
  win.webContents.send('session:auto', { requestId, userText: 'show me salvage' });
  for (const c of REPLY.match(/.{1,6}/gs) || []) {
    win.webContents.send('chat:delta', { requestId, text: c });
    await wait(4);
  }
  win.webContents.send('chat:done', { requestId });

  // Wait for fliers to actually launch rather than guessing at a delay.
  for (let i = 0; i < 400; i++) {
    const n = await win.webContents.executeJavaScript('window.__fliers.length');
    if (n > 0) break;
    await wait(25);
  }

  // Frames while it assembles, so there is something to look at as well as
  // something to count.
  for (const at of [0, 200, 500, 900, 1400, 2200]) {
    await wait(at === 0 ? 0 : 300);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(OUT, `salvage-t${String(at).padStart(4, '0')}.png`), img.toPNG());
  }
  await wait(1200);   // let every flier land

  const r = await win.webContents.executeJavaScript(`({
    fliers: window.__fliers.map(f => ({
      ch: f.ch, from: f.from, fromChars: f.fromChars,
      landedAt: f.landedAt, landChars: f.landChars,
    })),
    fellBack: window.__fellBack,
    sourced: window.__sourced,
    visible: document.querySelectorAll('#transcript .fx-salvage > i').length,
    revealed: [...document.querySelectorAll('#transcript .fx-salvage > i')]
      .filter(i => getComputedStyle(i).opacity === '1').length,
  })`);

  if (!r.fliers.length) { console.error('salvage never flew — nothing to probe'); app.quit(); return; }

  const hit = (rec, which) => rec[which] && rec[which].includes(rec.ch);
  const fromHits = r.fliers.filter((f) => hit(f, 'fromChars')).length;
  const landHits = r.fliers.filter((f) => hit(f, 'landChars')).length;
  const landed = r.fliers.filter((f) => f.landedAt).length;

  console.log('\n=== where each letter came from ===');
  console.log('  ch   from(x,y)      really there?   landed on?');
  for (const f of r.fliers.slice(0, 22)) {
    const fc = (f.fromChars || []).join('');
    const lc = (f.landChars || []).join('');
    console.log(
      `  ${JSON.stringify(f.ch).padEnd(4)} ${String(f.from.x + ',' + f.from.y).padEnd(14)}`
      + ` ${(hit(f, 'fromChars') ? 'yes' : 'no ')} [${fc}]`.padEnd(16)
      + ` ${(hit(f, 'landChars') ? 'yes' : 'no ')} [${lc}]`,
    );
  }
  if (r.fliers.length > 22) console.log(`  … ${r.fliers.length - 22} more`);

  console.log('\n=== counts ===');
  console.log('fliers:                    ', r.fliers.length);
  console.log('found a real source:       ', r.sourced);
  console.log('fell back to a random point:', r.fellBack);
  console.log('origin really had that char:', `${fromHits}/${r.fliers.length}`);
  console.log('landed on that char:        ', `${landHits}/${landed} that landed`);
  console.log('characters revealed:        ', `${r.revealed}/${r.visible}`);

  console.log('\n=== verdict ===');
  const salvaging = r.sourced > 0 && fromHits >= Math.floor(r.fliers.length * 0.6);
  console.log('actually salvaging, not just flying:',
    salvaging ? 'yes' : 'NO — this is the fallback path wearing the effect');
  console.log('landing on target (drift corrected):',
    landHits >= Math.floor(landed * 0.9) ? 'yes' : 'NO — letters are landing off their characters');
  console.log('every character revealed:',
    r.revealed === r.visible ? 'yes' : `NO — ${r.visible - r.revealed} left invisible forever`);
  console.log(`\nwrote frames to assets/fx/probe/`);

  app.quit();
});
