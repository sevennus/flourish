'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AutoStyler } = require('../src/autofx');

// Run a string through a fresh styler and collect the runs. `sliceLen` streams
// it in fixed-size pieces, the way the typewriter actually feeds it.
function styleAll(str, sliceLen) {
  const s = new AutoStyler();
  const runs = [];
  if (sliceLen) {
    for (let i = 0; i < str.length; i += sliceLen) runs.push(...s.feed(str.slice(i, i + sliceLen)));
  } else {
    runs.push(...s.feed(str));
  }
  runs.push(...s.flush());
  return runs;
}
const visible = (runs) => runs.map((r) => r.text).join('');

// What the renderer actually builds. feed() flushes plain text every time so
// nothing is ever held back from the screen, which means a code span revealed
// one character at a time comes back as one run per character. The renderer
// merges adjacent same-class runs into a single <span> (it keeps `autoCls` on
// the line across feeds), so THAT is the contract worth asserting — not the raw
// run list, which legitimately varies with chunk size.
function coalesce(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && last.cls === r.cls) last.text += r.text;
    else out.push({ text: r.text, cls: r.cls });
  }
  return out;
}
const classed = (runs, cls) => coalesce(runs).filter((r) => r.cls === cls).map((r) => r.text);

test('plain prose is one unstyled run', () => {
  const runs = styleAll('hello world');
  assert.strictEqual(visible(runs), 'hello world');
  assert.ok(runs.every((r) => r.cls === null));
});

test('backticks become code and are eaten', () => {
  const runs = styleAll('run `npm test` now');
  assert.strictEqual(visible(runs), 'run npm test now');
  assert.deepStrictEqual(classed(runs, 'auto-code'), ['npm test']);
});

test('double asterisks become bold and are eaten', () => {
  const runs = styleAll('that is **really** important');
  assert.strictEqual(visible(runs), 'that is really important');
  assert.deepStrictEqual(classed(runs, 'auto-bold'), ['really']);
});

test('a lone asterisk is literal, not a dangling bold', () => {
  const runs = styleAll('2 * 3 = 6');
  assert.strictEqual(visible(runs), '2 * 3 = 6');
  assert.strictEqual(classed(runs, 'auto-bold').length, 0);
});

test('a trailing lone asterisk survives flush', () => {
  assert.strictEqual(visible(styleAll('wildcard *')), 'wildcard *');
});

test('numbers are highlighted on their own', () => {
  const runs = styleAll('cap is 16000 now');
  assert.strictEqual(visible(runs), 'cap is 16000 now');
  assert.deepStrictEqual(classed(runs, 'auto-num'), ['16000']);
});

test('separators inside a number keep it one run', () => {
  assert.deepStrictEqual(classed(styleAll('pi is 3.14 ok'), 'auto-num'), ['3.14']);
  assert.deepStrictEqual(classed(styleAll('about 1,600 of them'), 'auto-num'), ['1,600']);
  assert.deepStrictEqual(classed(styleAll('at 90% load'), 'auto-num'), ['90%']);
});

test('a sentence-ending period is not part of the number', () => {
  const runs = styleAll('we measured 61.');
  assert.strictEqual(visible(runs), 'we measured 61.');
  assert.deepStrictEqual(classed(runs, 'auto-num'), ['61']);
});

test('a number at the very end still flushes', () => {
  const runs = styleAll('the answer is 42');
  assert.strictEqual(visible(runs), 'the answer is 42');
  assert.deepStrictEqual(classed(runs, 'auto-num'), ['42']);
});

test('numbers inside code are left to the code styling', () => {
  const runs = styleAll('`port 8080` here');
  assert.strictEqual(visible(runs), 'port 8080 here');
  assert.deepStrictEqual(classed(runs, 'auto-code'), ['port 8080']);
  assert.strictEqual(classed(runs, 'auto-num').length, 0);
});

test('asterisks inside code are literal', () => {
  const runs = styleAll('`a ** b` done');
  assert.strictEqual(visible(runs), 'a ** b done');
  assert.deepStrictEqual(classed(runs, 'auto-code'), ['a ** b']);
});

test('character-at-a-time streaming matches one-shot', () => {
  // The whole reason this is a state machine: the typewriter reveals ~14 chars
  // a frame, so `**`, a backtick pair and a number all straddle feeds.
  const s = 'set `MAX` to **16000** (was 1600) — 10x more, at 61.5fps.';
  const oneShot = styleAll(s);
  for (const slice of [1, 2, 3, 7, 14]) {
    const streamed = styleAll(s, slice);
    assert.strictEqual(visible(streamed), visible(oneShot), `visible text differs at slice=${slice}`);
    for (const cls of ['auto-code', 'auto-bold', 'auto-num']) {
      assert.deepStrictEqual(
        classed(streamed, cls), classed(oneShot, cls),
        `${cls} runs differ at slice=${slice}`,
      );
    }
  }
});

test('runs come back in source order', () => {
  const runs = styleAll('a 1 `b` **c** d');
  assert.strictEqual(visible(runs), 'a 1 b c d');
  assert.deepStrictEqual(
    coalesce(runs).filter((r) => r.text.trim()).map((r) => [r.text.trim(), r.cls]),
    [['a', null], ['1', 'auto-num'], ['b', 'auto-code'], ['c', 'auto-bold'], ['d', null]],
  );
});

test('a code span split across feeds coalesces to one span', () => {
  // Verbatim the renderer's merge rule. If this ever stops holding, a long
  // `code` run paints one bordered box per typewriter chunk instead of one box.
  const runs = styleAll('`npm test`', 1);
  assert.ok(runs.length > 1, 'expected one run per character at slice=1');
  assert.deepStrictEqual(coalesce(runs), [{ text: 'npm test', cls: 'auto-code' }]);
});

test('an unclosed code span still emits its text', () => {
  const runs = styleAll('oops `never closed');
  assert.strictEqual(visible(runs), 'oops never closed');
});
