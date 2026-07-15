'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseWind, planBurn, WIND_STRENGTH, CONSUMING_SPANS, PER_CHAR_SPANS, STYLE_SPANS } = require('../src/flourish');

// ---- wind grammar ----

test('wind defaults to a rightward breeze', () => {
  assert.deepStrictEqual(parseWind(''), { dir: 1, strength: WIND_STRENGTH.breeze });
  assert.deepStrictEqual(parseWind(undefined), { dir: 1, strength: WIND_STRENGTH.breeze });
});

test('wind takes a direction and a strength, in either order', () => {
  assert.deepStrictEqual(parseWind('left'), { dir: -1, strength: WIND_STRENGTH.breeze });
  assert.deepStrictEqual(parseWind('left gale'), { dir: -1, strength: WIND_STRENGTH.gale });
  assert.deepStrictEqual(parseWind('gale left'), { dir: -1, strength: WIND_STRENGTH.gale });
  assert.deepStrictEqual(parseWind('STILL RIGHT'), { dir: 1, strength: WIND_STRENGTH.still });
});

test('an unknown wind word degrades to the default', () => {
  assert.deepStrictEqual(parseWind('sideways'), { dir: 1, strength: WIND_STRENGTH.breeze });
});

// ---- spread model ----

const gale = { dir: 1, strength: 1 };
const still = { dir: 1, strength: 0 };

test('the seed ignites first, at zero', () => {
  const at = planBurn(10, gale, 4);
  assert.strictEqual(at[4], 0);
  assert.ok(at.every((t) => t >= 0));
});

test('every character eventually ignites', () => {
  const at = planBurn(30, gale, 12);
  assert.strictEqual(at.length, 30);
  assert.ok(at.every((t) => Number.isFinite(t)), 'a character never catches');
});

test('fire races downwind and creeps upwind', () => {
  // The whole point of the effect: from the same seed, the character one step
  // downwind must catch well before the one an equal step upwind.
  const at = planBurn(21, gale, 10);
  assert.ok(at[11] < at[9], 'downwind neighbour should ignite first');
  assert.ok(at[20] < at[0], 'the downwind end should burn before the upwind end');
  assert.ok(at[9] / at[11] > 3, `upwind should be markedly slower (got ${at[9]}ms vs ${at[11]}ms)`);
});

test('a still wind spreads evenly in both directions', () => {
  const at = planBurn(21, still, 10);
  for (let d = 1; d <= 10; d++) {
    assert.strictEqual(at[10 + d], at[10 - d], `asymmetric at distance ${d} with no wind`);
  }
});

test('reversing the wind mirrors the plan', () => {
  const n = 15;
  const right = planBurn(n, { dir: 1, strength: 0.8 }, 3);
  const left = planBurn(n, { dir: -1, strength: 0.8 }, n - 1 - 3);
  assert.deepStrictEqual(left, right.slice().reverse());
});

test('ignition times increase with distance from the seed', () => {
  const at = planBurn(12, gale, 0);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1], `character ${i} caught before ${i - 1}`);
  }
});

test('a stronger wind makes the downwind run quicker', () => {
  const breeze = planBurn(10, { dir: 1, strength: 0.3 }, 0);
  const strong = planBurn(10, { dir: 1, strength: 0.9 }, 0);
  assert.ok(strong[9] < breeze[9], 'a gale should cross the text sooner than a breeze');
});

test('degenerate spans do not throw', () => {
  assert.deepStrictEqual(planBurn(0, gale, 0), []);
  assert.deepStrictEqual(planBurn(1, gale, 0), [0]);
  // A seed outside the span is clamped rather than producing Infinity holes.
  assert.ok(planBurn(5, gale, 99).every((t) => Number.isFinite(t)));
  assert.ok(planBurn(5, gale, -3).every((t) => Number.isFinite(t)));
});

// ---- vocabulary wiring ----

test('consuming spans are per-char style spans', () => {
  for (const n of CONSUMING_SPANS) {
    assert.ok(STYLE_SPANS.has(n), `${n} consumes but is not a style span`);
    assert.ok(PER_CHAR_SPANS.has(n), `${n} consumes but is not rendered per character`);
  }
});
