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
];

const SPANS = '{{fx:glow}}glow{{/fx:glow}} {{fx:shimmer}}shimmer{{/fx:shimmer}} '
  + '{{fx:rainbow}}rainbow{{/fx:rainbow}} {{fx:fire}}fire{{/fx:fire}} '
  + '{{fx:neon}}neon{{/fx:neon}} {{fx:wave}}wave{{/fx:wave}} '
  + '{{fx:bounce}}bounce{{/fx:bounce}} {{fx:scramble}}scramble{{/fx:scramble}} '
  + '{{fx:color #ff5cad}}color{{/fx:color}}';

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
  // ones (confetti falls for ~3s) would otherwise bleed into the next frame.
  const reset = () => win.webContents.executeJavaScript(
    `window.__fx.particles = []; window.__fx.rings = []; window.__fx.bolts = [];
     window.__fx.matrix = null; true;`);

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

  for (const [label, keys] of [['typing-cool', 3], ['typing-warm', 5], ['typing-hot', 5], ['typing-blaze', 6]]) {
    await type(keys);
    await wait(90);
    await shoot(win, label);
  }

  console.log('\nwrote', POINT.length + 5, 'frames to assets/fx/');
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
