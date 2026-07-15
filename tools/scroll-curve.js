/*
 * scroll-curve.js — plot what the scroll spring actually does.
 *
 *   node tools/scroll-curve.js
 *
 * The feel of a scroll is invisible in a screenshot and hard to argue about in
 * prose, so this draws it: the step response (does it ease, does it overshoot)
 * and the streaming response (does it keep up, does the lag grow). It's also
 * where the OMEGA in src/scroller.js comes from — the table in that comment is
 * this script's stdout.
 *
 * Writes assets/fx/scroll-curve.svg. No dependencies: hand-rolled SVG so it runs
 * anywhere `node` does, and stays diffable in git.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const S = require('../src/scroller.js');

const FRAME = 1 / 60;
const OUT = path.join(__dirname, '..', 'assets', 'fx', 'scroll-curve.svg');

const SERIES = [
  { omega: 14, color: '#4a566a', label: 'ω=14 (loose)' },
  { omega: 26, color: '#cba33f', label: 'ω=26 (chosen)', wide: true },
  { omega: 40, color: '#3fa37a', label: 'ω=40 (taut)' },
];

/** Step response: sit at 0, ask for `dist`, record where we are each frame. */
function stepResponse(dist, omega, frames) {
  const pts = [];
  let pos = 0, vel = 0;
  for (let i = 0; i < frames; i++) {
    pts.push(pos);
    const s = S.step(pos, vel, dist, FRAME, omega);
    pos = s.pos; vel = s.vel;
  }
  return pts;
}

/** Streaming: target ramps away at `rate` px/s while we chase it. */
function rampResponse(rate, omega, frames) {
  const out = { target: [], pos: [] };
  let pos = 0, vel = 0, target = 0;
  for (let i = 0; i < frames; i++) {
    target += rate * FRAME;
    const s = S.step(pos, vel, target, FRAME, omega);
    pos = s.pos; vel = s.vel;
    out.target.push(target); out.pos.push(pos);
  }
  return out;
}

function settleMs(dist, omega) {
  let pos = 0, vel = 0, n = 0;
  while (n < 2000 && !S.settled(pos, vel, dist)) {
    const s = S.step(pos, vel, dist, FRAME, omega); pos = s.pos; vel = s.vel; n++;
  }
  return (n / 60) * 1000;
}

function steadyLag(rate, omega) {
  let pos = 0, vel = 0, target = 0, lag = 0;
  for (let i = 0; i < 400; i++) {
    target += rate * FRAME;
    const s = S.step(pos, vel, target, FRAME, omega); pos = s.pos; vel = s.vel;
    lag = target - pos;
  }
  return lag;
}

// ---- plumbing ----------------------------------------------------------
const W = 1120, H = 460, PAD = 56;
const PW = W / 2 - PAD * 1.4, PH = H - PAD * 2.2;

function panel(ox, title, sub, xmax, ymax, xlabel, ylabel) {
  let s = `<g transform="translate(${ox},${PAD})">`;
  s += `<text x="0" y="-22" fill="#cba33f" font-family="monospace" font-size="15" font-weight="bold">${title}</text>`;
  s += `<text x="0" y="-6" fill="#6b7688" font-family="monospace" font-size="11">${sub}</text>`;
  s += `<rect x="0" y="0" width="${PW}" height="${PH}" fill="#0b0e12" stroke="#232b36"/>`;
  for (let i = 0; i <= 4; i++) {
    const y = (PH * i) / 4;
    s += `<line x1="0" y1="${y}" x2="${PW}" y2="${y}" stroke="#171d26"/>`;
    s += `<text x="-8" y="${y + 4}" fill="#5a6472" font-family="monospace" font-size="10" text-anchor="end">${Math.round(ymax * (1 - i / 4))}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const x = (PW * i) / 4;
    s += `<line x1="${x}" y1="0" x2="${x}" y2="${PH}" stroke="#171d26"/>`;
    s += `<text x="${x}" y="${PH + 15}" fill="#5a6472" font-family="monospace" font-size="10" text-anchor="middle">${Math.round(xmax * i / 4)}</text>`;
  }
  s += `<text x="${PW / 2}" y="${PH + 34}" fill="#6b7688" font-family="monospace" font-size="11" text-anchor="middle">${xlabel}</text>`;
  s += `<text transform="translate(-40,${PH / 2}) rotate(-90)" fill="#6b7688" font-family="monospace" font-size="11" text-anchor="middle">${ylabel}</text>`;
  s += `</g>`;
  return s;
}

function poly(pts, xmax, ymax, color, width, dash) {
  const d = pts.map((v, i) => `${((i * FRAME * 1000) / xmax) * PW},${PH - (v / ymax) * PH}`).join(' ');
  return `<polyline points="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
}

// ---- panel 1: step response -------------------------------------------
const DIST = 1000, FRAMES = 60, XMAX = FRAMES * FRAME * 1000;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`;
svg += `<rect width="${W}" height="${H}" fill="#080a0e"/>`;

svg += panel(PAD, 'Step response — a 1000px jump', 'the ease you see when a multi-line reply lands at once', XMAX, DIST * 1.05, 'ms', 'scroll position (px)');
svg += `<g transform="translate(${PAD},${PAD})">`;
svg += `<line x1="0" y1="${PH - (DIST / (DIST * 1.05)) * PH}" x2="${PW}" y2="${PH - (DIST / (DIST * 1.05)) * PH}" stroke="#3a4453" stroke-dasharray="4 4"/>`;
svg += `<text x="${PW - 4}" y="${PH - (DIST / (DIST * 1.05)) * PH - 5}" fill="#3a4453" font-family="monospace" font-size="10" text-anchor="end">target</text>`;
for (const s of SERIES) svg += poly(stepResponse(DIST, s.omega, FRAMES), XMAX, DIST * 1.05, s.color, s.wide ? 2.6 : 1.3);
SERIES.forEach((s, i) => {
  svg += `<line x1="12" y1="${18 + i * 16}" x2="34" y2="${18 + i * 16}" stroke="${s.color}" stroke-width="${s.wide ? 2.6 : 1.3}"/>`;
  svg += `<text x="40" y="${22 + i * 16}" fill="#8b95a5" font-family="monospace" font-size="11">${s.label} — ${settleMs(DIST, s.omega).toFixed(0)}ms</text>`;
});
svg += `</g>`;

// ---- panel 2: streaming ramp ------------------------------------------
const RATE = 250, RFRAMES = 90, RXMAX = RFRAMES * FRAME * 1000, RYMAX = RATE * RFRAMES * FRAME * 1.05;
const ox2 = W / 2 + PAD * 0.4;
svg += panel(ox2, 'Following a moving target — 250px/s stream', 'text is still arriving; the lag must stay flat, not grow', RXMAX, RYMAX, 'ms', 'scroll position (px)');
svg += `<g transform="translate(${ox2},${PAD})">`;
const ramp = rampResponse(RATE, 26, RFRAMES);
svg += poly(ramp.target, RXMAX, RYMAX, '#3a4453', 1.6, '4 4');
svg += poly(ramp.pos, RXMAX, RYMAX, '#cba33f', 2.6);
svg += `<line x1="12" y1="18" x2="34" y2="18" stroke="#3a4453" stroke-width="1.6" stroke-dasharray="4 4"/>`;
svg += `<text x="40" y="22" fill="#8b95a5" font-family="monospace" font-size="11">bottom of transcript (target)</text>`;
svg += `<line x1="12" y1="34" x2="34" y2="34" stroke="#cba33f" stroke-width="2.6"/>`;
svg += `<text x="40" y="38" fill="#8b95a5" font-family="monospace" font-size="11">viewport — steady lag ${steadyLag(RATE, 26).toFixed(0)}px (&lt; 1 line)</text>`;
svg += `</g>`;

svg += `<text x="${PAD}" y="${H - 10}" fill="#4a566a" font-family="monospace" font-size="10">flourish/src/scroller.js — critically damped, implicit integration. Zero overshoot at every distance; see test/scroller.test.js</text>`;
svg += `</svg>`;

// Balance the tags before writing. An unclosed <g> still *renders* in Chrome —
// it just silently truncates at the first error — so a broken plot looks like a
// plot until you read the numbers off it. Cheap to check, expensive to miss.
(function assertBalanced(s) {
  const stack = [];
  const re = /<(\/?)([a-zA-Z]+)(?:\s[^>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [, close, name, self] = m;
    if (self) continue;
    if (close) {
      const open = stack.pop();
      if (open !== name) throw new Error(`SVG malformed: </${name}> closes <${open || 'nothing'}>`);
    } else stack.push(name);
  }
  if (stack.length) throw new Error('SVG malformed: unclosed <' + stack.join('>, <') + '>');
})(svg);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, svg);

// The table that lives in scroller.js's OMEGA comment.
console.log('omega |   24px   240px  1000px |  lag@250px/s  lag@700px/s');
for (const w of [14, 20, 26, 32, 40]) {
  console.log(
    String(w).padStart(5) + ' |' +
    [24, 240, 1000].map((d) => (settleMs(d, w).toFixed(0) + 'ms').padStart(8)).join('') + ' |' +
    (steadyLag(250, w).toFixed(0) + 'px').padStart(13) + (steadyLag(700, w).toFixed(0) + 'px').padStart(13)
  );
}
console.log('\nwrote', path.relative(process.cwd(), OUT));
