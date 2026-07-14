'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { translate, LineBuffer } = require('../src/ccstream');
const { FlourishParser } = require('../src/flourish');

// Real `claude -p --output-format stream-json` capture (a trivial "pong" turn
// whose appended system prompt asked for a literal {{fx:spark}}).
const FIXTURE = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'stream.jsonl'), 'utf8');
const OBJECTS = FIXTURE.split('\n').filter(Boolean).map((l) => JSON.parse(l));

function allEvents() {
  const ev = [];
  for (const o of OBJECTS) ev.push(...translate(o));
  return ev;
}

test('reconstructs assistant text from real text_delta events', () => {
  const text = allEvents().filter((e) => e.t === 'text').map((e) => e.value).join('');
  assert.strictEqual(text, 'pong\n\n{{fx:spark}}');
});

test('emits a session event with id + model from init', () => {
  const s = allEvents().find((e) => e.t === 'session');
  assert.ok(s, 'has a session event');
  assert.ok(s.id && s.id.length > 10, 'session id present');
  assert.ok(/claude/.test(s.model), 'model present');
});

test('emits a done event carrying session_id, cost, and no error', () => {
  const ev = allEvents();
  const done = ev.filter((e) => e.t === 'done');
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].isError, false);
  assert.strictEqual(typeof done[0].cost, 'number');
  const session = ev.find((e) => e.t === 'session');
  assert.strictEqual(done[0].sessionId, session.id, 'result session_id matches init');
  assert.strictEqual(done[0].result, 'pong\n\n{{fx:spark}}');
});

test('LineBuffer reassembles objects across arbitrary chunk splits', () => {
  const buf = new LineBuffer();
  const got = [];
  // feed the raw bytes in jagged 7-char slices to simulate socket chunks
  for (let i = 0; i < FIXTURE.length; i += 7) got.push(...buf.push(FIXTURE.slice(i, i + 7)));
  got.push(...buf.flush());
  assert.strictEqual(got.length, OBJECTS.length, 'same object count as line-split');
  assert.deepStrictEqual(got[0], OBJECTS[0]);
  assert.deepStrictEqual(got[got.length - 1], OBJECTS[OBJECTS.length - 1]);
});

test('ignores non-content events (assistant dup, rate_limit, message_delta)', () => {
  // The fixture contains a rate_limit_event and a full assistant message; neither
  // should produce visible text (only text_delta does).
  const notices = allEvents().filter((e) => e.t === 'notice');
  assert.ok(notices.some((n) => n.kind === 'rate_limit'), 'rate_limit surfaced as a notice, not text');
});

test('end to end: stream-json text → flourish parser strips the directive', () => {
  const text = allEvents().filter((e) => e.t === 'text').map((e) => e.value).join('');
  const fp = new FlourishParser();
  const ev = [...fp.feed(text), ...fp.flush()];
  const visible = ev.filter((e) => e.t === 'text').map((e) => e.value).join('');
  const effects = ev.filter((e) => e.t === 'effect');
  assert.strictEqual(visible, 'pong\n\n');
  assert.strictEqual(effects.length, 1);
  assert.strictEqual(effects[0].name, 'spark');
});

test('a bad/partial JSON line is skipped, not thrown', () => {
  const buf = new LineBuffer();
  const got = buf.push('{"type":"result","session_id":"x","is_error":false}\n{ broken json \n');
  assert.strictEqual(got.length, 1);
  assert.strictEqual(translate(got[0])[0].t, 'done');
});
