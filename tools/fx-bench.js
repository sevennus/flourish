/*
 * fx-bench.js — particle-budget benchmark.
 *
 * MAX_PARTICLES is a ceiling, not a count: raising it changes nothing until an
 * effect actually emits that many, and the only honest way to know what the
 * ceiling costs is to fill it and count frames. This is the harness that says
 * whether a given budget still paints at 60fps or turns into a slideshow.
 *
 *   npm run fx-bench
 *
 * Alternate Electron entry point, like fx-shots. Runs under xvfb with SOFTWARE
 * GL, which is the pessimistic case — a real Windows box with a GPU does better,
 * so treat these numbers as a floor rather than a prediction.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

// Rung 2 is the old cap, rung 5 the new one.
const RUNGS = [400, 1600, 4000, 8000, 16000];
const SAMPLE_MS = 1400;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  const win = new BrowserWindow({
    // Same rules as fx-shots: a hidden or occluded window throttles rAF, which
    // would make every measurement here a lie.
    width: 1120, height: 720, show: true,
    backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, sandbox: false, backgroundThrottling: false,
    },
  });
  await win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
  await wait(600);

  await win.webContents.executeJavaScript(`
    window.__fx = new window.FlourishEffects(document.getElementById('fx-canvas'));

    // Fill with n long-lived, slow-moving glowing particles. Slow on purpose:
    // particles that stay on screen keep overdrawing, which is the worst case
    // and the one worth measuring.
    window.__fill = (n) => {
      const cols = ['#35f0a0', '#37b6ff', '#ffd27a', '#ff5c7a', '#b47cff'];
      const P = [];
      for (let i = 0; i < n; i++) {
        P.push({
          x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
          vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4,
          life: 0, max: 1e9, size: 1 + Math.random() * 2.4,
          color: cols[(Math.random() * cols.length) | 0],
          grav: 0, drag: 1, shape: 'dot', halo: 12,
        });
      }
      window.__fx.particles = P;
      window.__fx._ensureRunning();
      return window.__fx.particles.length;
    };

    // Count real frames while the engine animates on the same rAF clock.
    window.__measure = (ms) => new Promise((res) => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        const el = performance.now() - t0;
        if (el < ms) requestAnimationFrame(tick);
        else res({ frames, ms: el });
      };
      requestAnimationFrame(tick);
    });
    true;`);

  console.log('Software GL (xvfb) — a floor, not a prediction.\n');
  console.log('  particles     fps    frame');
  console.log('  ---------  ------  -------');
  const rows = [];
  for (const n of RUNGS) {
    await win.webContents.executeJavaScript(`window.__fill(${n}); true;`);
    await wait(250);   // let it settle before we start counting
    const r = await win.webContents.executeJavaScript(`window.__measure(${SAMPLE_MS});`);
    const fps = r.frames / (r.ms / 1000);
    rows.push({ n, fps });
    console.log(
      '  ' + String(n).padStart(9)
      + '  ' + fps.toFixed(1).padStart(6)
      + '  ' + (1000 / fps).toFixed(1).padStart(5) + 'ms',
    );
  }

  // What the effects actually ask for, as opposed to what the cap allows.
  console.log('\nreal effects — peak particle count:');
  for (const [name, args] of [['spark', '{}'], ['fireworks', '{}'], ['confetti', '{}'],
                              ['nova', '{}'], ['nova', "{ scale: 2.6 }"],
                              ['swarm', '{}'], ['rain', '{}'], ['warp', '{}']]) {
    const peak = await win.webContents.executeJavaScript(`
      (function () {
        window.__fx.particles = [];
        window.__fx.fire('${name}', 560, 330, ${args});
        return window.__fx.particles.length;
      })();`);
    console.log('  ' + (name + (args === '{}' ? '' : ' xl')).padEnd(12) + String(peak).padStart(6));
  }

  await win.webContents.executeJavaScript(`window.__fx.particles = []; true;`);
  app.quit();
}

app.whenReady().then(run).catch((e) => { console.error(e); app.exit(1); });
