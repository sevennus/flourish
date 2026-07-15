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
  ['lightning', 140], ['nova', 260], ['matrix', 700], ['glitch', 150],
  ['shake', 140],
  // Slower ones need longer to become themselves: frost has to creep, the
  // constellation has to find its links, aurora has to fade up.
  ['aurora', 1500], ['constellation', 900], ['shatter', 420], ['swarm', 1100],
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

  // A dedicated engine instance over the same canvas — the renderer's own is
  // idle unless a reply is streaming, so the two never fight over the frame.
  await win.webContents.executeJavaScript(
    `window.__fx = new window.FlourishEffects(document.getElementById('fx-canvas'));
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
      fx.links = null; fx.frost = null; fx.matrix = null;
      fx.noise = null; fx.grid = null; fx.traces = null; fx.tracers = null;
      // The DOM-driven ones latch a class rather than living in an array.
      const app = document.getElementById('app');
      if (app) app.classList.remove('vhs', 'glitch', 'shake');
      const scan = document.getElementById('fx-scanlines');
      if (scan) scan.classList.remove('go');
      return true;
    })();`);

  console.log('point effects:');
  for (const [name, delay] of POINT) {
    await reset();
    await wait(160);
    await win.webContents.executeJavaScript(`window.__fx.fire('${name}', 560, 330); true;`);
    await wait(delay);
    await shoot(win, name);
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
        const i = document.createElement('i'); i.textContent = ch; span.appendChild(i);
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
  await wait(400);
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
