/*
 * ascii-probe.js — do the ten ASCII scenes actually paint what they planned?
 *
 * test/ascii.test.js is thorough and proves nothing about the screen. Every
 * assertion in it calls a planner: a pure function that returns an array of
 * strings. `_drawAscii` could throw on its first frame, or draw a hexdump at
 * x = -4000, or draw nothing at all, and all 206 tests would stay green —
 * which is exactly the shape of the failure this repo keeps shipping. `npm
 * test` has passed 88/88 on a fatally broken app; `npm run screenshot` exits 0
 * no matter what is in the PNG.
 *
 * So this probe never asks a scene about itself. It wraps the real 2D context's
 * fillText/strokeRect BEFORE any effect fires, and counts what actually lands
 * on the canvas. That's an independent oracle: a `_drawAscii` that silently
 * returns early cannot fool it, because the count comes from the context, not
 * from the effect.
 *
 * What it establishes per scene, none of which a screenshot could:
 *
 *   planned     the planner produced content at all
 *   painted     fillText/strokeRect really got called, on the real canvas
 *   on-screen   the draws landed inside the viewport rather than off the edge
 *   faithful    the strings that hit the canvas are the planner's OWN strings,
 *               not placeholder glyphs that happen to look busy
 *   reaped      the scene removed itself from fx.ascii at the end of its life
 *               (a leak here doesn't misdraw — it silently pins the RAF loop
 *               on forever and stacks onto every later scene)
 *
 * `faithful` is the one that matters. A pane that paints 200 glyphs of the
 * wrong thing photographs beautifully.
 *
 *   xvfb-run -a ./node_modules/.bin/electron tools/ascii-probe.js --no-sandbox
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const win = new BrowserWindow({
    // show + no throttling, for the reason fx-shots documents: a hidden window
    // throttles rAF, so life never advances and nothing ever draws.
    width: 1120, height: 720, show: true,
    backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await wait(600);

  const js = (s) => win.webContents.executeJavaScript(s);

  const names = await js(`Array.from(window.Flourish.ASCII_EFFECTS);`);

  const results = [];
  for (const name of names) {
    // Fresh engine per scene so nothing bleeds across, and the tap installed
    // before the effect exists — instrumenting after the fact would miss the
    // first frames, which for a scene is most of the evidence.
    const r = await js(`(function () {
      const canvas = document.getElementById('fx-canvas');
      const fx = new window.FlourishEffects(canvas, document.getElementById('fx-canvas-under'));
      window.__probe = fx;
      const ctx = fx.ctx;
      const tap = { texts: [], rects: 0, off: 0, err: null, lastFrame: [], frames: 0 };
      const realFill = ctx.fillText.bind(ctx);
      const realRect = ctx.strokeRect.bind(ctx);
      ctx.fillText = function (s, x, y) {
        // Only count what OUR engine draws. getContext('2d') hands back the
        // same context object every call, so a fresh FlourishEffects per scene
        // shares one context with the renderer's own engine and with every tap
        // installed before it - the isolation is an illusion. The app's ambient
        // effects were counted as the scene's, which showed up as gibson making
        // a few hundred "off-screen" draws that gibson never made, and varying
        // run to run because ambient noise does. inDraw is set only inside our
        // _draw, below.
        //
        // (No backticks in this comment: it lives inside a template literal, and
        // one backtick here ends the string and turns the whole probe into a
        // syntax error.)
        if (!tap.inDraw) return realFill(s, x, y);
        tap.texts.push(String(s));
        // Landing off-canvas is the failure mode a count alone would miss: the
        // effect "painted" and the viewer saw nothing.
        //
        // Measured against the GLYPH's own size, not a constant. A flat +-50px
        // is a proxy for "invisible" that only holds while glyphs are small: a
        // 100px-wide gibson window at x = -80 is half on screen and perfectly
        // intentional, and a fixed threshold calls it a miss. Read the size off
        // the context at call time — the tap sees exactly what the engine set.
        // \\\\d, not \\d. This regex lives inside a template literal on its way
        // through executeJavaScript, and \\d is not a valid escape there — it
        // degrades silently to a bare 'd', so the pattern became (d+(?:.d+)?)px,
        // matched nothing, and fell back to 13 on EVERY call. The real font was
        // 126px. That made the off-screen threshold ~10x too tight and reported
        // ~400 phantom misses on a gibson that was drawing correctly, which I
        // then nearly "fixed" in the engine. The harness was the broken thing.
        const m = /([0-9]+(?:\\.[0-9]+)?)px/.exec(ctx.font);
        const sz = m ? parseFloat(m[1]) : 13;
        if (!m) tap.fontUnparsed = ctx.font;   // never silently fall back again
        if (x < -sz * 2 || y < -sz * 2 || x > fx.w + sz || y > fx.h + sz) tap.off++;
        return realFill(s, x, y);
      };
      ctx.strokeRect = function (x, y, w, h) { if (tap.inDraw) tap.rects++; return realRect(x, y, w, h); };
      // Frame boundaries. Without these there is no such thing as "one frame"
      // here: sleeping 120ms and reading the tap gathers however many frames
      // happened to fit, which reported banner at exactly 7x its ink and looked
      // like a broken banner rather than a probe counting seven of them.
      const realDraw = fx._draw.bind(fx);
      fx._draw = function () {
        const start = tap.texts.length;
        tap.inDraw = true;
        try { var r = realDraw(); } finally { tap.inDraw = false; }
        tap.lastFrame = tap.texts.slice(start);
        tap.frames++;
        return r;
      };
      window.__tap = tap;
      try {
        fx.fire('${name}', fx.w / 2, fx.h / 2, {});
      } catch (e) { tap.err = String(e && e.stack || e); }
      const S = fx.ascii[0];
      return {
        created: fx.ascii.length,
        kind: S ? S.kind : null,
        max: S ? S.max : 0,
        planned: S ? (S.lines ? S.lines.length
                    : S.rows ? S.rows.length
                    : S.cells ? S.cells.length
                    : S.towers ? S.towers.length
                    : S.ports ? S.ports.length
                    : S.plan ? (S.plan.rows ? S.plan.rows.length : S.plan.cells.length) : 0) : 0,
        err: tap.err,
      };
    })();`);

    if (!r.created) {
      results.push(Object.assign({ name }, r, { painted: 0, off: 0, faithful: null, reaped: null }));
      continue;
    }

    // Sample once the scene is FULLY revealed but before it fades. Sampling
    // early is its own lie: every line pane reveals on a timer, so a probe that
    // looks at 1.4s reports "16 of 17" on a scene that is working perfectly and
    // simply hasn't finished talking. Wait for the reveal to end.
    const revealMs = await js(`(function () {
      const S = window.__probe.ascii[0];
      if (!S) return 0;
      if (S.lines) return S.lines.length * S.per;
      if (S.ports) return S.ports.length * S.per;
      if (S.plan && S.plan.doneAt) return S.plan.doneAt;
      if (S.plan && S.plan.rows) return S.plan.rows.length * S.per;
      if (S.rows) return S.rows[0].length * S.per;
      return 1200;
    })();`);
    await wait(Math.min(Math.max(revealMs + 250, 900), r.max * 0.75));

    const mid = await js(`(function () {
      const t = window.__tap, fx = window.__probe, S = fx.ascii[0];
      // Ask the planner, independently, what this scene's OWN strings are, and
      // check the canvas really received them. A scene painting 200 glyphs of
      // something else passes every count and is still wrong.
      //
      // Two shapes of scene, two oracles. Line panes draw a whole string per
      // fillText, so a substring search over everything drawn is exact. The
      // per-character scenes (crack, banner, skull, gibson) draw ONE glyph per
      // call, so that same search can never match and reports 0/1 on a scene
      // that is working — which it did, on the first run of this probe. For
      // those, clear the tap and read a single fresh frame: the glyphs drawn in
      // one pass, in order, are the scene's content.
      let want = [], hit = 0, perChar = null;
      if (S) {
        if (S.lines) want = S.lines.map((l) => l.text);
        else if (S.plan && S.plan.rows) want = S.plan.rows.map((r) => r.val);
        else if (S.ports) want = S.ports.map((p) => p.port + '/tcp');
      }
      if (want.length) {
        const hay = t.texts.join('\\u0000');
        hit = want.filter((w) => w && hay.indexOf(String(w).trim().slice(0, 12)) !== -1).length;
      }
      perChar = S && (S.kind === 'crack' || S.kind === 'skull' || S.kind === 'banner' || S.kind === 'gibson');
      return {
        painted: t.texts.length, rects: t.rects, off: t.off, err: t.err,
        frames: t.frames, fontUnparsed: t.fontUnparsed || null,
        distinct: new Set(t.texts).size,
        want: want.length, hit,
        kind: S ? S.kind : null,
        perChar: !!perChar,
        alive: fx.ascii.length,
      };
    })();`);

    // The per-character scenes, checked against exactly one frame.
    let charOracle = null;
    if (mid.perChar) {
      charOracle = await js(`(function () {
        const t = window.__tap, fx = window.__probe, S = fx.ascii[0];
        if (!S) return { ok: false, want: 'a live scene', got: 'it was already reaped' };
        const glyphs = t.lastFrame.filter((s) => s.length === 1);
        const got = glyphs.join('');
        if (S.kind === 'crack') {
          // Every cell is locked by now and the draw walks them in order, so
          // the single glyphs of one frame ARE the password.
          return { ok: got.indexOf(S.plan.target) !== -1, got: got.slice(0, 44), want: S.plan.target };
        }
        if (S.kind === 'skull') {
          const art = window.Flourish.SKULL.join('').replace(/ /g, '');
          const ok = got.length === art.length
            && art.split('').every((c) => got.indexOf(c) !== -1);
          return { ok, got: got.length + ' glyphs', want: art.length + ' cells' };
        }
        if (S.kind === 'gibson') {
          // The city only ever draws these two, and it must draw some.
          const ok = glyphs.length > 0 && glyphs.every((c) => c === '#' || c === '=');
          return { ok, got: glyphs.length + ' glyphs in ' + new Set(glyphs).size + ' shapes',
                   want: "'#' and '=' only" };
        }
        // banner: every lit cell is a '#', and one frame must draw exactly the
        // phrase's ink once the reveal has finished.
        const ink = S.rows.join('').split('#').length - 1;
        const drawn = glyphs.filter((c) => c === '\u2588').length;
        return { ok: drawn === ink, got: drawn + " '#' drawn", want: ink + ' lit cells in ' + JSON.stringify(S.text) };
      })();`);
    }

    // Past the end of its life: it must reap itself.
    const S_max = r.max;
    await wait(Math.max(400, S_max - 1400 + 700));
    const end = await js(`(function () {
      return { alive: window.__probe.ascii.length, err: window.__tap.err };
    })();`);

    // Faithful = the canvas received this scene's own content, by whichever
    // oracle fits its shape.
    const faithful = charOracle ? charOracle.ok
      : mid.want ? mid.hit === mid.want
        : null;

    results.push({
      name, kind: r.kind, planned: r.planned,
      painted: mid.painted, rects: mid.rects, off: mid.off,
      distinct: mid.distinct, want: mid.want, hit: mid.hit,
      faithful, charOracle, fontUnparsed: mid.fontUnparsed,
      reaped: end.alive === 0,
      err: r.err || mid.err || end.err,
    });
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log('\n=== counts ===');
  console.log(pad('scene', 11), pad('planned', 8), pad('painted', 8), pad('boxes', 6),
    pad('off-screen', 11), pad('own content', 13), pad('reaped', 7));
  let bad = 0;
  for (const r of results) {
    const own = r.charOracle ? (r.charOracle.ok ? 'yes (glyphs)' : 'NO')
      : r.want ? `${r.hit}/${r.want}` : '(none)';
    console.log(pad(r.name, 11), pad(r.planned, 8), pad(r.painted, 8), pad(r.rects, 6),
      pad(r.off, 11), pad(own, 13), pad(r.reaped ? 'yes' : 'NO', 7), r.err ? 'THREW' : '');
    if (r.charOracle && !r.charOracle.ok) {
      console.log('      wanted', JSON.stringify(r.charOracle.want), 'got', JSON.stringify(r.charOracle.got));
    }
    const painted = r.painted > 0 || r.rects > 0;
    if (!r.planned || !painted || r.off > 0 || r.faithful === false || !r.reaped || r.err) bad++;
    if (r.err) console.log('    ', r.err.split('\n')[0]);
    // The off-screen check is only as good as the glyph size it measures
    // against. If the font ever fails to parse the threshold is a guess, and a
    // guessing oracle is worse than none — so say so instead of scoring it.
    if (r.fontUnparsed) {
      console.log('      !! font unparsed, off-screen threshold is a guess:', JSON.stringify(r.fontUnparsed));
      bad++;
    }
  }

  const pct = (f) => results.filter(f).length + '/' + results.length;
  console.log('\n=== verdict ===');
  console.log('scenes probed:                  ', results.length);
  console.log('planned content:                ', pct((r) => r.planned > 0));
  console.log('actually painted to the canvas: ', pct((r) => r.painted > 0 || r.rects > 0));
  console.log('every draw inside the viewport: ', pct((r) => r.off === 0));
  console.log('painted their OWN content:      ', pct((r) => r.faithful !== false));
  console.log('reaped themselves:              ', pct((r) => r.reaped));
  console.log('threw:                          ', results.filter((r) => r.err).length);
  console.log(bad === 0 ? '\nALL TEN SCENES PAINT WHAT THEY PLAN: yes' : `\nBROKEN SCENES: ${bad}`);

  win.destroy();
  app.exit(bad === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
