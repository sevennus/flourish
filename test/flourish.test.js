'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { FlourishParser, POINT_EFFECTS, STYLE_SPANS, PER_CHAR_SPANS } = require('../src/flourish');
const { pickDemoResponse, SHOWCASE, RESPONSES } = require('../src/demo');
const { FLOURISH_SYSTEM_PROMPT } = require('../src/prompt');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// Run a whole string through a fresh parser and collect events + visible text.
function parseAll(str, sliceLen) {
  const p = new FlourishParser();
  const events = [];
  if (sliceLen) {
    for (let i = 0; i < str.length; i += sliceLen) events.push(...p.feed(str.slice(i, i + sliceLen)));
  } else {
    events.push(...p.feed(str));
  }
  events.push(...p.flush());
  const text = events.filter((e) => e.t === 'text').map((e) => e.value).join('');
  return { events, text };
}

test('plain text passes through untouched', () => {
  const { text, events } = parseAll('hello world');
  assert.strictEqual(text, 'hello world');
  assert.ok(events.every((e) => e.t === 'text'));
});

test('point effect is stripped and emitted', () => {
  const { text, events } = parseAll('hello {{fx:spark}}world');
  assert.strictEqual(text, 'hello world');
  const fx = events.filter((e) => e.t === 'effect');
  assert.strictEqual(fx.length, 1);
  assert.strictEqual(fx[0].name, 'spark');
});

test('directive split across feed() boundaries still resolves', () => {
  const p = new FlourishParser();
  const ev = [];
  ev.push(...p.feed('hel'));
  ev.push(...p.feed('lo {{fx:sp'));
  ev.push(...p.feed('ark}} x'));
  ev.push(...p.flush());
  const text = ev.filter((e) => e.t === 'text').map((e) => e.value).join('');
  assert.strictEqual(text, 'hello  x');
  assert.strictEqual(ev.filter((e) => e.t === 'effect').length, 1);
});

test('character-at-a-time streaming matches one-shot', () => {
  const s = 'a {{fx:confetti}} b {{fx:glow}}c{{/fx:glow}} d';
  const oneShot = parseAll(s);
  const streamed = parseAll(s, 1);
  assert.strictEqual(streamed.text, oneShot.text);
  assert.strictEqual(
    streamed.events.filter((e) => e.t !== 'text').length,
    oneShot.events.filter((e) => e.t !== 'text').length,
  );
});

test('style span emits start/end around the wrapped text', () => {
  const { text, events } = parseAll('{{fx:shimmer}}hi{{/fx:shimmer}}');
  assert.strictEqual(text, 'hi');
  assert.deepStrictEqual(
    events.map((e) => e.t),
    ['style-start', 'text', 'style-end'],
  );
  assert.strictEqual(events[0].name, 'shimmer');
  assert.strictEqual(events[2].name, 'shimmer');
});

test('color span carries its hex argument', () => {
  const { events } = parseAll('{{fx:color #ff0066}}pink{{/fx:color}}');
  const start = events.find((e) => e.t === 'style-start');
  assert.strictEqual(start.name, 'color');
  assert.strictEqual(start.args, '#ff0066');
});

test('unknown directive is left as literal text', () => {
  const { text, events } = parseAll('a {{fx:bogus}} b {{notadirective}} c');
  assert.strictEqual(text, 'a {{fx:bogus}} b {{notadirective}} c');
  assert.strictEqual(events.filter((e) => e.t !== 'text').length, 0);
});

test('dangling open brace is flushed, not swallowed', () => {
  const { text } = parseAll('the answer is {{fx:sp');
  assert.strictEqual(text, 'the answer is {{fx:sp');
});

test('single stray brace is literal', () => {
  const { text } = parseAll('use { and } freely');
  assert.strictEqual(text, 'use { and } freely');
});

test('an overlong {{ run does not buffer forever', () => {
  const junk = '{{' + 'x'.repeat(100);
  const { text } = parseAll(junk + ' end');
  assert.ok(text.includes('end'));
  assert.ok(text.includes('x'.repeat(100)));
});

test('every demo showcase directive is a known effect and leaves no braces', () => {
  const { text, events } = parseAll(SHOWCASE);
  assert.ok(!text.includes('{{'), 'no opening braces remain in visible text');
  assert.ok(!text.includes('}}'), 'no closing braces remain in visible text');
  const names = events
    .filter((e) => e.t === 'effect' || e.t === 'style-start')
    .map((e) => e.name);
  assert.ok(names.length >= 6, 'showcase exercises several effects');
  for (const n of names) {
    assert.ok(POINT_EFFECTS.has(n) || STYLE_SPANS.has(n), `unknown effect: ${n}`);
  }
});

test('demo responder matches keywords and falls back', () => {
  assert.ok(/fireworks|confetti/i.test(pickDemoResponse('we shipped it!')));
  assert.ok(pickDemoResponse('zzzqqq unmatched').length > 0);
});

test('every demo reply only uses known effects and closes its spans', () => {
  for (const r of RESPONSES) {
    const { text, events } = parseAll(r.text);
    assert.ok(!text.includes('{{'), `braces left in reply for ${r.match}`);
    const open = events.filter((e) => e.t === 'style-start').map((e) => e.name);
    const close = events.filter((e) => e.t === 'style-end').map((e) => e.name);
    assert.deepStrictEqual(open.sort(), close.sort(), `unbalanced spans in reply for ${r.match}`);
    for (const e of events) {
      if (e.t === 'effect') assert.ok(POINT_EFFECTS.has(e.name), `unknown point effect ${e.name}`);
    }
  }
});

test('the new effects all parse and strip cleanly', () => {
  const s = '{{fx:lightning}}{{fx:nova}}{{fx:meteor}}{{fx:embers}}{{fx:vortex}}{{fx:glitch}}'
    + '{{fx:fire}}a{{/fx:fire}}{{fx:neon}}b{{/fx:neon}}{{fx:scramble}}c{{/fx:scramble}}{{fx:bounce}}d{{/fx:bounce}}';
  const { text, events } = parseAll(s);
  assert.strictEqual(text, 'abcd');
  assert.strictEqual(events.filter((e) => e.t === 'effect').length, 6);
  assert.strictEqual(events.filter((e) => e.t === 'style-start').length, 4);
});

// The seams below are where this thing silently breaks: a name can exist in the
// parser but have no engine case / no CSS rule / no mention in the system
// prompt, and the effect just never plays with nothing to show for it.

test('every point effect is handled by the engine', () => {
  const src = read('src/effects.js');
  for (const n of POINT_EFFECTS) {
    assert.ok(src.includes(`case '${n}':`), `effects.js fire() has no case for ${n}`);
  }
});

test('every style span has a way to render', () => {
  const css = read('src/styles.css');
  for (const n of STYLE_SPANS) {
    if (n === 'color') continue; // applied as an inline style, not a class
    assert.ok(css.includes(`.fx-${n}`), `styles.css has no .fx-${n} rule`);
  }
});

test('per-char spans are a subset of the style spans', () => {
  for (const n of PER_CHAR_SPANS) {
    assert.ok(STYLE_SPANS.has(n), `${n} is per-char but not a style span`);
  }
});

test('the system prompt teaches exactly the vocabulary the parser accepts', () => {
  const taught = new Set([...FLOURISH_SYSTEM_PROMPT.matchAll(/\{\{fx:([a-z]+)/g)].map((m) => m[1]));
  for (const n of [...POINT_EFFECTS, ...STYLE_SPANS]) {
    assert.ok(taught.has(n), `prompt.js never teaches ${n}, so the model will never fire it`);
  }
  for (const n of taught) {
    assert.ok(POINT_EFFECTS.has(n) || STYLE_SPANS.has(n), `prompt.js teaches unknown effect ${n}`);
  }
});

test('the vocabulary is the full 22 effects', () => {
  assert.strictEqual(POINT_EFFECTS.size, 13);
  assert.strictEqual(STYLE_SPANS.size, 9);
});
