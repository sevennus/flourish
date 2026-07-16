/*
 * fx-shots.js — visual verification harness.
 *
 * Not a unit test: an alternate Electron entry point that loads the real
 * renderer, fires each effect in isolation, and captures a PNG mid-flight. The
 * unit tests prove the parser/engine/prompt agree on the vocabulary; these
 * prove the pixels actually happen.
 *
 *   npm run fx-shots
 *
 * (Lives in tools/, not test/, because `node --test` would otherwise try to run
 * this Electron entry point as a unit test.)
 *
 * Writes assets/fx/<name>.png. Runs under xvfb (software GL), so treat it as
 * "the effect draws and is visible", not as colour-accurate.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '..', 'assets', 'fx');

// Each effect gets the delay that catches it at its most photogenic: bursts
// look best early, confetti/meteor need time to cross the screen.
const POINT = [
  ['spark', 260], ['ripple', 420], ['pulse', 220], ['embers', 700],
  ['meteor', 620], ['confetti', 1200], ['fireworks', 480], ['vortex', 520],
  // The one shot on this list with a real window rather than a floor, because
  // the effect is now a sequence and only a slice of it has everything in it at
  // once. 140ms was fine when the bolt was painted whole on frame one; too
  // early now and it's a half-drawn leader with nothing alight, and past ~700ms
  // every channel has decayed and it's a photograph of three burnt words and no
  // lightning — which is what shipped in this file's first attempt. ~320ms is
  // the overlap: all channels lit, all struck words burning. See
  // tools/lightning-probe.js for the frame-by-frame this was picked from.
  ['lightning', 320], ['nova', 260], ['matrix', 700], ['glitch', 150],
  ['shake', 140],
  // Slower ones need longer to become themselves: frost has to creep, the
  // constellation has to find its links, aurora has to fade up.
  ['aurora', 1500], ['constellation', 900],
  ['shatter', 420], ['swarm', 1100],
  ['sonar', 700], ['warp', 480], ['frost', 1500], ['bloom', 1000],
  ['rain', 900], ['beam', 700], ['implode', 620],
  ['scanlines', 900], ['static', 300], ['vhs', 200], ['grid', 1200],
  ['circuit', 1400], ['tracer', 1400],
];

const SPANS = '{{fx:glow}}glow{{/fx:glow}} {{fx:shimmer}}shimmer{{/fx:shimmer}} '
  + '{{fx:rainbow}}rainbow{{/fx:rainbow}} {{fx:fire}}fire{{/fx:fire}} '
  + '{{fx:neon}}neon{{/fx:neon}} {{fx:wave}}wave{{/fx:wave}} '
  + '{{fx:bounce}}bounce{{/fx:bounce}} {{fx:scramble}}scramble{{/fx:scramble}} '
  + '{{fx:color #ff5cad}}color{{/fx:color}}\n'
  + '{{fx:chrome}}chrome{{/fx:chrome}} {{fx:sparkle}}sparkle{{/fx:sparkle}} '
  + '{{fx:flicker}}flicker{{/fx:flicker}} {{fx:corrupt}}corrupt{{/fx:corrupt}} '
  + '{{fx:ghost}}ghost{{/fx:ghost}} {{fx:stamp}}stamp{{/fx:stamp}} '
  + '{{fx:redact}}redact{{/fx:redact}} {{fx:hologram}}hologram{{/fx:hologram}} '
  + '{{fx:hexdump}}hexdump{{/fx:hexdump}}';

// One frame per palette, so a recolour that silently does nothing is visible.
const PALETTE_SHOTS = ['mint', 'ice', 'gold', 'ember', 'violet', 'rose', 'mono'];

// The text-effects reference sheet: every style span, rendered in its own
// style, with what it means. Must cover STYLE_SPANS exactly — a test enforces
// that, so a new span can't ship without appearing in the reference.
const SHEET = [
  ['glow', 'a key result'],
  ['shimmer', 'polished, elegant'],
  ['chrome', 'hard, engineered, machined'],
  ['rainbow', 'playful, celebratory'],
  ['sparkle', 'delightful, a little magic'],
  ['fire', 'hot, urgent, fast'],
  ['neon', 'a name, a label, a sign'],
  ['flicker', 'unstable, failing'],
  ['corrupt', 'broken data, garbage'],
  ['ghost', 'an aside, a maybe'],
  ['wave', 'lilting, rolling'],
  ['bounce', 'upbeat'],
  ['stamp', 'a verdict, final'],
  ['scramble', 'decodes into place — reveals'],
  ['hexdump', 'raw bytes, low-level'],
  ['hologram', 'projected, virtual, not real'],
  ['redact', 'a bar slides away — a reveal'],
  ['color', 'any specific colour'],
  ['burn', 'CONSUMES — spreads on the wind'],
  ['cascade', 'CONSUMES — falls away as glyphs'],
  ['twin', 'two copies, drifting apart'],
  ['overwrite', 'a buffer with two writers'],
  ['palimpsest', 'what it said before, underneath'],
  ['rot', 'LIES — flickers between lookalikes and back'],
  ['confabulate', 'LIES — words turn over behind you'],
  ['intrusive', 'LIES — a word that was never said'],
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(win, name) {
  fs.writeFileSync(path.join(OUT, name + '.png'), (await win.webContents.capturePage()).toPNG());
  console.log('  ✓', name + '.png');
}

async function run() {
  const win = new BrowserWindow({
    // show:true and no background throttling are both load-bearing: a hidden or
    // occluded window throttles requestAnimationFrame, so particle life stops
    // advancing, effects never die, and every frame is a pile-up of the last
    // few. xvfb gives us a real (virtual) display to show on.
    width: 1120, height: 720, show: true,
    backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await wait(600);

  fs.mkdirSync(OUT, { recursive: true });

  // A dedicated engine instance over the same canvases — the renderer's own is
  // idle unless a reply is streaming, so the two never fight over the frame.
  // The under-canvas has to be passed here too, or apophenia's web is drawn to
  // a context that isn't on screen and the shot comes out empty.
  await win.webContents.executeJavaScript(
    `window.__fx = new window.FlourishEffects(
       document.getElementById('fx-canvas'), document.getElementById('fx-canvas-under'));
     document.getElementById('transcript').innerHTML =
       '<div class="line system"><div class="body">✦ effect under test</div></div>'; true;`);

  // Hard-reset the engine rather than waiting for effects to time out — long
  // ones (confetti falls for ~3s, swarm drifts for ~3.4s) would otherwise bleed
  // into the next frame. Every array the engine animates has to be cleared here;
  // miss one and that effect quietly stacks up across every later shot.
  // Wrapped in an IIFE deliberately: executeJavaScript evaluates in the page's
  // global scope, so a bare `const` here is redeclared on the second call and
  // throws — which reads as "the effect is broken" rather than "the harness is".
  const reset = () => win.webContents.executeJavaScript(`
    (function () {
      const fx = window.__fx;
      fx.particles = []; fx.rings = []; fx.bolts = [];
      fx.sheets = []; fx.sweeps = [];
      fx.links = null; fx.webs = null; fx.frost = null; fx.matrix = null;
      fx.noise = null; fx.grid = null; fx.traces = null; fx.tracers = null;
      // The under-canvas isn't cleared by the loop once it stops running.
      if (fx.under) fx.under.clearRect(0, 0, fx.w, fx.h);
      // The DOM-driven ones latch a class rather than living in an array.
      const app = document.getElementById('app');
      if (app) app.classList.remove('vhs', 'glitch', 'shake');
      const scan = document.getElementById('fx-scanlines');
      if (scan) scan.classList.remove('go');
      return true;
    })();`);

  // apophenia is the only point effect whose input comes from outside itself:
  // the renderer measures the words on screen and hands it anchors. Fired bare
  // like every other effect here, o.anchors is undefined and it quietly takes
  // its no-anchors fallback — so this harness spent a whole release
  // photographing a pretty fallback while the real path drew a rule through the
  // prose and Jim saw nothing. It gets real prose and real anchors, and the
  // shot fails loudly rather than falling back.
  // Long enough to be a real reply. A four-line transcript is not a fair test:
  // the anchor stratifier spreads its picks across LINES, so a short one gives
  // it nothing to spread over and the shot shows a page shape Jim never sees.
  const PROSE =
    'The deploy went out at nine and the alert fired six minutes later, which '
    + 'nobody noticed because that alert has cried wolf every morning since '
    + 'April and muting it is the first thing anyone does on arriving.\n\n'
    + 'By eleven the database had been read end to end twice and found blameless '
    + 'both times, and the configuration change nobody wanted to look at was '
    + 'still sitting there, small and reviewed by its own author.\n\n'
    + 'The fix took four seconds once somebody asked the obvious question out '
    + 'loud, which is the part of the timeline that always gets rounded off '
    + 'before the postmortem reaches anyone senior enough to mind.\n\n'
    + 'Every word on this page is a candidate. The bolt picks a few of them, and '
    + 'the ones it hits are supposed to catch and burn while the rest of the '
    + 'paragraph sits there and watches it happen.';

  const setTranscript = (html) => win.webContents.executeJavaScript(
    `document.getElementById('transcript').innerHTML = ${JSON.stringify(html)}; true;`);
  const PLAIN = '<div class="line system"><div class="body">✦ effect under test</div></div>';

  // Effects whose input comes from OUTSIDE themselves: the renderer measures
  // the words on screen and hands them in. Fired bare, o.anchors is undefined
  // and they quietly take their no-anchors fallback — which is how this harness
  // spent a whole release photographing a pretty fallback while the real
  // apophenia drew a rule through the prose and Jim saw nothing.
  //
  // Lightning joined the list when it started striking words, and it would fail
  // the same way: bare, it throws one bolt at the caret and sets nothing on
  // fire, and the shot would be of a branch no reader ever reaches. Anything
  // added here must fire the way applyEvents fires it, and fail LOUDLY rather
  // than fall back.
  const WORD_ANCHORED = new Set(['lightning']);

  console.log('point effects:');
  for (const [name, delay] of POINT) {
    await reset();
    const anchored = WORD_ANCHORED.has(name);
    if (anchored) { await setTranscript(`<div class="line assistant"><div class="body">${PROSE}</div></div>`); }
    await wait(160);
    // Reset AGAIN, immediately before firing. Several effects spawn part of
    // themselves on a delayed timer, so the first reset empties the arrays and
    // the previous effect's timer quietly refills them during the settle — and
    // the shot ends up with the last effect's debris drifting through this
    // one's frame. It went unnoticed for as long as it did because most delays
    // here are long enough for the stowaway to have died before the shutter;
    // lightning's is not.
    await reset();
    if (anchored) {
      await win.webContents.executeJavaScript(`
        (function () {
          const a = window.Flourish.strikeTargets(4);
          if (a.length < 2) throw new Error('fx-shots: wordAnchors returned ' + a.length
            + ' anchors — this shot would be one bolt at the caret, not a strike on words');
          if (a.filter(t => t.el).length < 2) throw new Error('fx-shots: only '
            + a.filter(t => t.el).length + ' targets got claimed — this shot would show bolts'
            + ' landing on words that never catch');
          window.__fx.fire('lightning', 560, 330, {
            anchors: a,
            onStrike: (i) => window.Flourish.igniteWord(a[i]),
          });
          return true;
        })();`);
    } else {
      await win.webContents.executeJavaScript(`window.__fx.fire('${name}', 560, 330); true;`);
    }
    await wait(delay);
    await shoot(win, name);
    if (anchored) await setTranscript(PLAIN);
    await wait(200);
  }
  await reset();

  console.log('palettes (spark):');
  for (const pal of PALETTE_SHOTS) {
    await reset();
    await wait(160);
    await win.webContents.executeJavaScript(
      `window.__fx.fire('spark', 560, 330, { palette: '${pal}', scale: 1.7 }); true;`);
    await wait(300);
    await shoot(win, 'palette-' + pal);
    await wait(160);
  }
  await reset();

  console.log('text spans:');
  await win.webContents.executeJavaScript(`
    const P = new window.Flourish.FlourishParser();
    const t = document.getElementById('transcript');
    t.innerHTML = '';
    const body = document.createElement('div');
    body.className = 'line assistant'; body.style.fontSize = '30px';
    const inner = document.createElement('div'); inner.className = 'body';
    body.appendChild(inner); t.appendChild(body);
    // Mirror the renderer's span handling closely enough to prove the CSS.
    let stack = [inner], waveN = 0;
    const PC = window.Flourish.PER_CHAR_SPANS;
    const perChar = () => { for (let i = stack.length - 1; i >= 0; i--) {
      const n = stack[i]; if (n.dataset && PC.has(n.dataset.fx)) return n.dataset.fx; } return null; };
    for (const ev of P.feed(${JSON.stringify(SPANS)}).concat(P.flush())) {
      const tgt = stack[stack.length - 1];
      if (ev.t === 'style-start') {
        const s = document.createElement('span'); s.dataset.fx = ev.name;
        if (ev.name === 'color') s.style.color = ev.args; else s.className = 'fx-' + ev.name;
        tgt.appendChild(s); stack.push(s);
      } else if (ev.t === 'style-end') {
        while (stack.length > 1) { const top = stack.pop(); if (top.dataset.fx === ev.name) break; }
      } else if (ev.t === 'text') {
        const fx = perChar();
        if (!fx) { tgt.appendChild(document.createTextNode(ev.value)); continue; }
        for (const ch of ev.value) {
          const i = document.createElement('i'); i.textContent = ch;
          // twin's ghost is content:attr(data-c) — without this it renders the
          // empty string and the span looks like plain text. See renderer.js.
          i.dataset.c = ch;
          if (fx !== 'scramble') i.style.animationDelay = ((waveN++ % 24) * 0.05).toFixed(2) + 's';
          tgt.appendChild(i);
        }
      }
    }
    true;`);
  await wait(700);
  await shoot(win, 'spans');

  // The consuming spans are the only effects that animate real characters AND
  // throw particles off them, so a single frame can't show whether they work.
  // Catch one burn at three points and you can see the flame front travel.
  console.log('burn (a sequence — the front should move left→right):');
  await reset();
  const layout = (fx, text, args) => win.webContents.executeJavaScript(`
    (function () {
      const t = document.getElementById('transcript');
      t.innerHTML = '';
      const line = document.createElement('div');
      line.className = 'line assistant'; line.style.fontSize = '34px'; line.style.marginTop = '40px';
      const body = document.createElement('div'); body.className = 'body';
      const span = document.createElement('span');
      span.dataset.fx = '${fx}'; span.className = 'fx-${fx}';
      for (const ch of ${JSON.stringify(text)}) {
        const i = document.createElement('i'); i.textContent = ch;
        i.dataset.c = ch;   // twin's ghost reads this; see renderer.js
        span.appendChild(i);
      }
      body.appendChild(span); line.appendChild(body); t.appendChild(line);
      window.__tfx = window.__tfx || new window.FlourishTextFX(window.__fx);
      window.__tfx.play('${fx}', span, ${JSON.stringify(args)});
      return span.children.length;
    })();`);

  // The span stamps data-burnt when its last character finishes, so wait for
  // that rather than guessing a total: the ignition seed is random and a gale's
  // upwind crawl swings the length by seconds between runs.
  const waitForBurnt = () => win.webContents.executeJavaScript(`
    new Promise((res) => {
      const t = setInterval(() => {
        const s = document.querySelector('.fx-burn');
        if (s && s.dataset.burnt === '1') { clearInterval(t); res(true); }
      }, 80);
      setTimeout(() => { clearInterval(t); res(false); }, 25000);
    });`);

  await layout('burn', 'this idea is dead and gone', 'right gale');
  // Absolute times from ignition — one character's arc is catch → peak 260ms →
  // charcoal 1240ms → ash 1860ms, and the front is crossing the span meanwhile.
  const burnT0 = Date.now();
  for (const [label, at] of [['burn-1-catch', 300], ['burn-2-spread', 900], ['burn-3-ash', 1800]]) {
    await wait(Math.max(0, at - (Date.now() - burnT0)));
    await shoot(win, label);
  }
  if (!(await waitForBurnt())) console.log('  ! burn never settled — shot may be mid-animation');
  await wait(200);
  await shoot(win, 'burn-4-ashed');

  await reset();
  await layout('cascade', 'scrolling out of existence', 'right');
  await wait(620);
  await shoot(win, 'cascade');

  // ---- the unreliable spans ----
  //
  // A single frame proves even less here than it does for burn: the whole point
  // of rot and confabulate is that nothing appears to happen and then the text
  // is different. So these capture the text ITSELF at intervals, and fail loudly
  // if it didn't change — a broken rot looks exactly like a working rot until
  // you compare two moments.

  const textOf = (sel) => win.webContents.executeJavaScript(
    `(document.querySelector('${sel}') || {}).innerText || ''`);

  // rot needs BOTH halves checked, and the old version of this harness only
  // checked one. It compared the line before and after and called them being
  // equal a dead effect — true when rot was a one-way decay, and exactly
  // backwards now: rot always lands on the truth, so equal-at-the-end is the
  // effect working. Sampling only the ends can no longer tell a working rot from
  // one that never fired, so poll THROUGH the flicker and check the landing.
  console.log('rot (the line should flicker between lookalikes and come back):');
  await reset();
  await layout('rot', 'this line will not sit still while you read it', 'fast');
  const rotTruth = await textOf('.fx-rot');
  await shoot(win, 'rot-1-fresh');

  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    seen.add(await textOf('.fx-rot'));
    if (i === 12) await shoot(win, 'rot-2-flickering');
    await wait(250);
  }
  await wait(4000);                       // let every character spend its twitches
  await shoot(win, 'rot-3-settled');
  const rotSettled = await textOf('.fx-rot');

  const wrongStates = [...seen].filter((s) => s !== rotTruth);
  console.log('    truth   :', JSON.stringify(rotTruth));
  console.log('    settled :', JSON.stringify(rotSettled));
  console.log('    distinct wrong states seen mid-flicker:', wrongStates.length);
  if (wrongStates[0]) console.log('    e.g.    :', JSON.stringify(wrongStates[0]));
  if (!wrongStates.length) console.log('  ! rot never changed ANYTHING — the effect is dead');
  if (rotSettled !== rotTruth) console.log('  ! rot did not come back — settled text is not what was written');
  for (const s of seen) {
    if (s.length !== rotTruth.length) { console.log('  ! rot changed the LENGTH — the line will have reflowed'); break; }
  }

  console.log('confabulate (the words should turn over on their own):');
  await reset();
  await layout('confabulate', 'you will always remember that this is true', '');
  const confabBefore = await textOf('.fx-confabulate');
  await shoot(win, 'confabulate-1-before');
  await wait(12000);
  const confabAfter = await textOf('.fx-confabulate');
  await shoot(win, 'confabulate-2-after');
  console.log('    before:', JSON.stringify(confabBefore));
  console.log('    after :', JSON.stringify(confabAfter));
  if (confabBefore === confabAfter) console.log('  ! confabulate changed NOTHING — the effect is dead');

  // The guard, in the real renderer rather than in a unit test. mutableMask()
  // being right is worth nothing if textfx doesn't consult it, and this is the
  // only check that watches the actual pixels refuse.
  console.log('the guard (a command inside a rot span must not move):');
  await reset();
  const CMD = 'git reset --hard origin/main';
  await layout('rot', CMD, 'fast');
  await wait(9000);
  const guarded = await textOf('.fx-rot');
  await shoot(win, 'rot-guarded-command');
  console.log('    command:', JSON.stringify(guarded));
  if (guarded !== CMD) console.log(`  ! THE GUARD LEAKED — rot rewrote a command: ${JSON.stringify(guarded)}`);
  else console.log('  ✓ the command is byte-identical after rot ran over it');

  console.log('twin / overwrite / palimpsest:');
  for (const [fx, text, args] of [
    ['twin', 'two copies drifting apart', ''],
    ['overwrite', 'a buffer with two writers', ''],
  ]) {
    await reset();
    await layout(fx, text, args);
    await wait(1600);
    await shoot(win, fx);
  }

  // palimpsest is the one span with no <i> children — it's a whole-span ghost
  // reading its old text out of data-fx-args — so layout() doesn't fit it.
  await reset();
  await win.webContents.executeJavaScript(`
    (function () {
      const t = document.getElementById('transcript');
      t.innerHTML = '';
      const line = document.createElement('div');
      line.className = 'line assistant'; line.style.fontSize = '34px'; line.style.marginTop = '60px';
      const body = document.createElement('div'); body.className = 'body';
      const span = document.createElement('span');
      span.dataset.fx = 'palimpsest'; span.className = 'fx-palimpsest';
      span.dataset.fxArgs = 'what the line said before someone edited it';
      span.textContent = 'what it says now';
      body.appendChild(span); line.appendChild(body); t.appendChild(line);
      return true;
    })();`);
  await wait(2200);
  await shoot(win, 'palimpsest');
  await wait(400);
  await reset();
  await win.webContents.executeJavaScript(`document.getElementById('transcript').innerHTML = ''; true;`);

  // A labelled contact sheet of every text span — the reference image. Unlike
  // spans.png (which is a smoke test that the CSS applies at all), this one has
  // to include burn and cascade, so it fires them and captures mid-flight.
  console.log('text-effects contact sheet:');
  await reset();
  await win.webContents.executeJavaScript(`
    (function () {
      const SPANS = ${JSON.stringify(SHEET)};
      const t = document.getElementById('transcript');
      t.innerHTML = '';
      const wrap = document.createElement('div');
      wrap.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:9px 34px;padding:6px 4px;';
      const PC = window.Flourish.PER_CHAR_SPANS;
      window.__sheetSpans = {};
      for (const [name, desc] of SPANS) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:baseline;gap:12px;';
        const s = document.createElement('span');
        s.dataset.fx = name;
        if (name === 'color') s.style.color = '#ff5cad'; else s.className = 'fx-' + name;
        // palimpsest's ghost is content:attr(data-fx-args). With no args its row
        // renders as plain text — i.e. as the one thing it isn't.
        if (name === 'palimpsest') s.dataset.fxArgs = 'an earlier draft of this';
        s.style.cssText += ';font-size:23px;min-width:148px;';
        const label = name === 'color' ? 'color #ff5cad' : name;
        if (PC.has(name)) {
          let n = 0;
          for (const ch of label) {
            const i = document.createElement('i');
            i.textContent = ch;
            i.dataset.c = ch;   // twin's ghost reads this; see renderer.js
            // The scripted spans are driven from textfx below; a CSS stagger
            // here would fight them.
            if (!window.Flourish.SCRIPTED_SPANS.has(name) && name !== 'scramble' && name !== 'hexdump') {
              i.style.animationDelay = ((n++ % 24) * 0.05).toFixed(2) + 's';
            }
            s.appendChild(i);
          }
        } else {
          s.textContent = label;
        }
        const d = document.createElement('em');
        d.textContent = desc;
        d.style.cssText = 'color:#6f8a7d;font-style:normal;font-size:12.5px;';
        row.appendChild(s); row.appendChild(d);
        wrap.appendChild(row);
        window.__sheetSpans[name] = s;
      }
      t.appendChild(wrap);
      return Object.keys(window.__sheetSpans).length;
    })();`);
  await wait(400);
  // Light the fuse on the two destructive ones. They're staggered on purpose:
  // cascade empties its label in ~400ms, so firing both together and waiting
  // long enough to see fire means cascade has already finished eating itself
  // and its row is blank. Start burn first, cascade late, catch both alight.
  const play = (n, args) => win.webContents.executeJavaScript(`
    (function () {
      window.__tfx = window.__tfx || new window.FlourishTextFX(window.__fx);
      window.__tfx.play('${n}', window.__sheetSpans.${n}, ${JSON.stringify(args)});
      return true;
    })();`);
  // overwrite is scripted too, and its whole effect is the margins textfx sets —
  // left unplayed its row is indistinguishable from plain text. Fired first
  // because its pull-back is a 1.1s transition and the sheet is shot in ~1.2s.
  //
  // rot, confabulate and intrusive are deliberately NOT played here: rot would
  // eat its own label before the shutter, and the other two are no-ops on a
  // one-word label (nothing in "confabulate" is in the drift table; "intrusive"
  // has no space to push into). Their rows show the name in its own styling,
  // which is what the sheet is for. The sequences above are where they're proved.
  await play('overwrite', 'hard');
  await wait(700);
  await play('burn', 'right breeze');
  await wait(300);
  await play('cascade', 'right');
  await wait(180);
  await shoot(win, 'text-effects');
  await wait(300);
  await reset();
  await win.webContents.executeJavaScript(`document.getElementById('transcript').innerHTML = ''; true;`);

  console.log('prompt-box typing heat:');
  // Drive the input the way a keyboard would: set the value, then dispatch the
  // same input event the browser fires, so the app's own listener does the work.
  const type = async (n) => win.webContents.executeJavaScript(`
    (function () {
      const inp = document.getElementById('input');
      for (let i = 0; i < ${n}; i++) {
        inp.value += 'abcdefghij'[i % 10];
        inp.dispatchEvent(new InputEvent('input', { inputType: 'insertText', bubbles: true }));
      }
      return inp.value.length;
    })();`);

  for (const [label, keys] of [['typing-cool', 3], ['typing-warm', 4], ['typing-hot', 4],
                               ['typing-blaze', 4], ['typing-inferno', 5]]) {
    await type(keys);
    await wait(90);
    await shoot(win, label);
  }

  console.log('\nwrote', POINT.length + PALETTE_SHOTS.length + 6, 'frames to assets/fx/');
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
