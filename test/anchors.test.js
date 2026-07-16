/*
 * anchors.test.js — apophenia's point set.
 *
 * apophenia shipped drawing a horizontal rule through the prose instead of a
 * web, and stayed that way through 122 unit tests, a smoke run and a committed
 * screenshot. Nothing here loaded the DOM, so nothing here could see it; the
 * screenshot was of the fallback path because the harness fired the effect with
 * no anchors at all.
 *
 * So the geometry lives in flourish.js as pure functions, and these are the
 * tests that would have caught it. The collinear case below is not invented:
 * it's the anchor set the real renderer actually produced, captured by
 * tools/apophenia-probe.js (14 words, x 77→786, y 178 for every one).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  anchorsFlat, stratifyAnchors, planApopheniaPairs, pairShallow, MIN_SLOPE,
} = require(path.join(__dirname, '..', 'src', 'flourish'));

// The exact anchors the shipped wordAnchors(14) handed the engine.
const SHIPPED = [786, 736, 686, 619, 564, 501, 424, 361, 302, 262, 217, 176, 126, 77]
  .map((x) => ({ x, y: 178 }));

// A pool of words over eight lines of transcript, ~11 words each.
const POOL = [];
for (let line = 0; line < 8; line++) {
  for (let w = 0; w < 11; w++) POOL.push({ x: 60 + w * 64, y: 154 + line * 24 });
}

test('anchorsFlat: the anchor set that actually shipped is rejected', () => {
  assert.strictEqual(anchorsFlat(SHIPPED), true);
});

test('anchorsFlat: too few points to argue from', () => {
  assert.strictEqual(anchorsFlat([]), true);
  assert.strictEqual(anchorsFlat([{ x: 0, y: 0 }, { x: 300, y: 300 }]), true);
});

test('anchorsFlat: a column of words is as degenerate as a row', () => {
  const column = [0, 1, 2, 3, 4].map((i) => ({ x: 400, y: 100 + i * 30 }));
  assert.strictEqual(anchorsFlat(column), true);
});

test('anchorsFlat: a genuine two-dimensional spread is accepted', () => {
  assert.strictEqual(anchorsFlat(POOL.slice(0, 6).concat(POOL.slice(60, 66))), false);
});

test('stratifyAnchors: picks across lines, not one line-ful', () => {
  const out = stratifyAnchors(POOL, 14, () => 0);
  assert.strictEqual(out.length, 14);
  const lines = new Set(out.map((p) => p.y));
  assert.ok(lines.size >= 7, `expected words from most lines, got ${lines.size}`);
  assert.strictEqual(anchorsFlat(out), false);
});

test('stratifyAnchors: the regression — never returns a collinear set from a 2-D pool', () => {
  // Every seed, not just a lucky one: the old sampling failed 100% of the time,
  // so a single passing draw would prove nothing.
  for (let seed = 0; seed < 50; seed++) {
    const rnd = () => ((seed * 9301 + 49297) % 233280) / 233280;
    assert.strictEqual(anchorsFlat(stratifyAnchors(POOL, 14, rnd)), false, `seed ${seed}`);
  }
});

test('stratifyAnchors: one line of transcript still yields a flat set, and the engine must fall back', () => {
  // Not a bug — a one-line reply genuinely has nowhere to hang a web. The point
  // is that it's detectable, so _apophenia takes its invented-points path
  // rather than striking the only line of text out.
  const oneLine = POOL.slice(0, 11);
  assert.strictEqual(anchorsFlat(stratifyAnchors(oneLine, 14, () => 0)), true);
});

test('stratifyAnchors: returns real candidates, never duplicates or inventions', () => {
  const out = stratifyAnchors(POOL, 14, () => 0);
  const key = (p) => `${p.x}:${p.y}`;
  assert.strictEqual(new Set(out.map(key)).size, out.length, 'duplicate anchors');
  const pool = new Set(POOL.map(key));
  for (const p of out) assert.ok(pool.has(key(p)), `invented anchor ${key(p)}`);
});

test('stratifyAnchors: asking for more than exists returns everything, and terminates', () => {
  const out = stratifyAnchors(POOL, 5000, () => 0);
  assert.strictEqual(out.length, POOL.length);
});

test('stratifyAnchors: empty pool', () => {
  assert.deepStrictEqual(stratifyAnchors([], 14, () => 0), []);
});

// ---- pair selection ----
//
// The whole-set check is not enough on its own: a set can span the transcript,
// pass anchorsFlat, and still contain a pair of words sitting on one line. That
// pair alone draws a rule through that line, which is the shipped bug at pair
// scale — and it's what the first attempt at this fix still did (see
// assets/fx/probe/apophenia-pairs-before.png, top line struck through).

test('pairShallow: a same-line pair is the flat case of a shallow one', () => {
  assert.strictEqual(pairShallow({ x: 60, y: 178 }, { x: 900, y: 178 }), true);
});

test('pairShallow: adjacent lines, far apart — the ~5° graze along the prose', () => {
  // Exactly the segments the second attempt at this fix still drew.
  assert.strictEqual(pairShallow({ x: 30, y: 154 }, { x: 1050, y: 178 }), true);
});

test('pairShallow: steep links are kept, however short or long', () => {
  assert.strictEqual(pairShallow({ x: 400, y: 154 }, { x: 430, y: 300 }), false);  // near-vertical
  assert.strictEqual(pairShallow({ x: 60, y: 154 }, { x: 900, y: 560 }), false);   // long diagonal
});

test('pairShallow: symmetric, and a coincident pair is shallow not NaN', () => {
  const a = { x: 100, y: 200 }, b = { x: 700, y: 480 };
  assert.strictEqual(pairShallow(a, b), pairShallow(b, a));
  assert.strictEqual(pairShallow({ x: 5, y: 5 }, { x: 5, y: 5 }), false);  // dx=0: vertical, not shallow
});

test('planApopheniaPairs: never draws a line that travels along the prose', () => {
  for (let seed = 1; seed <= 200; seed++) {
    let n = seed;
    const rnd = () => { n = (n * 1103515245 + 12345) % 2147483648; return n / 2147483648; };
    for (const pr of planApopheniaPairs(POOL, rnd)) {
      const a = POOL[pr.i], b = POOL[pr.j];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      assert.ok(dy >= MIN_SLOPE * dx,
        `seed ${seed}: linked a ${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)}° segment`);
    }
  }
});

test('planApopheniaPairs: still finds enough lines to argue with', () => {
  const pairs = planApopheniaPairs(POOL, Math.random);
  assert.ok(pairs.length >= 3, `only ${pairs.length} pairs`);
  assert.ok(pairs.length <= 9);
});

test('planApopheniaPairs: no pair twice, and no point linked to itself', () => {
  const pairs = planApopheniaPairs(POOL, Math.random);
  const keys = pairs.map((p) => Math.min(p.i, p.j) + ':' + Math.max(p.i, p.j));
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate pair');
  for (const p of pairs) assert.notStrictEqual(p.i, p.j);
});

test('planApopheniaPairs: lines draw one after another, not all at once', () => {
  const pairs = planApopheniaPairs(POOL, Math.random);
  pairs.forEach((p, i) => assert.strictEqual(p.at, i * 210));
});

test('planApopheniaPairs: a single line of anchors yields no pairs rather than a strikethrough', () => {
  // Belt and braces: _apophenia's anchorsFlat guard means this set never
  // reaches here. If it ever does, drawing nothing beats drawing a rule.
  assert.deepStrictEqual(planApopheniaPairs(SHIPPED, Math.random), []);
});

test('planApopheniaPairs: terminates on hostile input', () => {
  assert.deepStrictEqual(planApopheniaPairs([], Math.random), []);
  assert.deepStrictEqual(planApopheniaPairs([{ x: 1, y: 1 }], Math.random), []);
});
