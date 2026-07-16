'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  planSalvage, STYLE_SPANS, PER_CHAR_SPANS, SCRIPTED_SPANS,
  POINT_EFFECTS, DISABLED_EFFECTS, FlourishParser,
} = require('../src/flourish');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// A fixed sequence stands in for Math.random, so a plan is exactly reproducible
// and the assertions below are about the model rather than about luck. Same
// trick planBurn's tests use.
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length]; };
const mid = () => 0.5;

// ---- launch scheduling ----

test('by default the line assembles in reading order', () => {
  const at = planSalvage(8, '', mid);
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1], `character ${i} launches before ${i - 1}`);
  }
});

test('jitter is bounded under one step, so reading order survives it', () => {
  // The worst case: every character that could be pushed late is, and every
  // character that could be pulled early is. Order must still hold.
  const at = planSalvage(40, '', seq([0.999, 0]));
  for (let i = 1; i < at.length; i++) {
    assert.ok(at[i] > at[i - 1],
      `jitter reordered the line at ${i}: ${at[i - 1]} then ${at[i]}`);
  }
});

test('scatter breaks reading order', () => {
  // Shuffled with a generator that is not the identity permutation.
  const at = planSalvage(24, 'scatter', seq([0.11, 0.83, 0.47, 0.29, 0.95, 0.62]));
  const ordered = at.every((v, i) => i === 0 || v > at[i - 1]);
  assert.ok(!ordered, 'scatter produced reading order, which is the default mode');
});

test('scatter still launches every character exactly once', () => {
  const at = planSalvage(24, 'scatter', seq([0.11, 0.83, 0.47, 0.29, 0.95, 0.62]));
  assert.strictEqual(at.length, 24);
  assert.ok(at.every((v) => Number.isFinite(v) && v >= 0), 'a character never launches');
  // Every slot got a distinct order index, so nothing was dropped or doubled.
  assert.strictEqual(new Set(at).size, 24);
});

test('fast and slow scale the whole plan, not just the first step', () => {
  const norm = planSalvage(10, '', mid);
  const fast = planSalvage(10, 'fast', mid);
  const slow = planSalvage(10, 'slow', mid);
  assert.ok(fast[9] < norm[9], 'fast is not quicker');
  assert.ok(slow[9] > norm[9], 'slow is not slower');
});

test('an empty span plans nothing rather than throwing', () => {
  assert.deepStrictEqual(planSalvage(0, '', mid), []);
});

test('an unknown arg degrades to the default plan', () => {
  assert.deepStrictEqual(planSalvage(6, 'sideways', mid), planSalvage(6, '', mid));
});

// ---- wiring ----
//
// salvage is inert unless it is in all three sets, and the failure is silent in
// a different way for each: missing from STYLE_SPANS it renders as literal
// braces, missing from PER_CHAR_SPANS the span has no <i> children and textfx
// returns immediately, missing from SCRIPTED_SPANS nothing ever calls it and
// the text stays invisible forever — which is worse than no effect, because
// styles.css has already hidden it.

test('salvage is wired into all three vocabulary sets', () => {
  assert.ok(STYLE_SPANS.has('salvage'), 'not a span: renders as braces');
  assert.ok(PER_CHAR_SPANS.has('salvage'), 'not per-character: no <i>s to fly');
  assert.ok(SCRIPTED_SPANS.has('salvage'), 'not scripted: text stays hidden forever');
});

test('salvage characters start hidden, or there is nothing to fly in', () => {
  // The CSS is the effect's initial state, not decoration on it.
  const css = read('src/styles.css');
  const block = css.slice(css.indexOf('.fx-salvage > i'), css.indexOf('.fx-hexdump {'));
  assert.match(block, /opacity:\s*0/, 'salvage text is visible before it arrives');
});

test('textfx reveals a salvaged character only when its copy lands', () => {
  // The reveal is the onLand callback and nothing else. A version that showed
  // the text on a timer would look almost identical and would be lying: the
  // letters would appear whether or not anything arrived.
  const src = read('src/textfx.js');
  const block = src.slice(src.indexOf('_salvage(span, chars, args)'), src.indexOf('* overwrite —'));
  assert.match(block, /onLand:\s*\(\)\s*=>\s*\{\s*c\.style\.opacity\s*=\s*'1'/,
    'salvage does not hand the reveal to the flier');
});

test('the model is taught salvage', () => {
  const { FLOURISH_SYSTEM_PROMPT } = require('../src/prompt');
  assert.ok(FLOURISH_SYSTEM_PROMPT.includes('{{fx:salvage}}'), 'prompt never teaches salvage');
});

// ---- shatter's retirement ----

test('shatter no longer paints', () => {
  assert.ok(DISABLED_EFFECTS.has('shatter'), 'shatter is still live');
});

test('shatter still parses, so old transcripts never print its braces', () => {
  // The whole reason it is retired rather than deleted. shatter was in the
  // prompt for months and the model reached for it constantly, so the
  // transcripts are full of it; a name dropped from the vocabulary stops being
  // stripped from the stream and starts being rendered.
  assert.ok(POINT_EFFECTS.has('shatter'), 'shatter was deleted, which corrupts the archive');
  const p = new FlourishParser();
  const evs = p.feed('glass {{fx:shatter}} breaks');
  assert.ok(!evs.some((e) => e.t === 'text' && e.value.includes('{{')),
    'a retired shatter leaked braces onto the screen');
  assert.ok(evs.some((e) => e.t === 'effect' && e.name === 'shatter'),
    'shatter stopped resolving, so it will not be dropped on the floor either');
});

test('the model is no longer taught shatter', () => {
  const { FLOURISH_SYSTEM_PROMPT } = require('../src/prompt');
  assert.ok(!FLOURISH_SYSTEM_PROMPT.includes('{{fx:shatter}}'),
    'the prompt still offers a retired effect');
});

test('nothing advertises a retired effect as live', () => {
  // demo.js and the shot harness both drive the real vocabulary. A retired
  // effect left in either produces a demo beat that paints nothing and a
  // screenshot of an empty screen — which is exactly how a broken effect
  // shipped with a beautiful picture of its own fallback once before.
  //
  // Written against DISABLED_EFFECTS rather than against 'shatter': this
  // caught apophenia still firing in the showcase months after it was retired,
  // and a shatter-shaped assertion would have missed it exactly the way the
  // last one did.
  const demo = read('src/demo.js');
  const shots = read('tools/fx-shots.js');
  const prompt = read('src/prompt.js');
  for (const n of DISABLED_EFFECTS) {
    assert.ok(!demo.includes(`{{fx:${n}}}`), `demo still fires retired ${n}`);
    assert.ok(!new RegExp(`\\['${n}',`).test(shots), `shot harness still shoots retired ${n}`);
    assert.ok(!prompt.includes(`{{fx:${n}}}`), `prompt still teaches retired ${n}`);
  }
});
