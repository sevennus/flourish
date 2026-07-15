/*
 * scroller.test.js — the spring's invariants.
 *
 * These are the properties the *feel* depends on, and they're the ones a
 * plausible-looking retune can quietly break. Overshoot in particular is the
 * difference between "eases into place" and "seasick", and it's invisible in a
 * screenshot — so it gets pinned here rather than eyeballed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/scroller.js');

const FRAME = 1 / 60;

// Run to rest (or give up) and report what happened on the way.
function run(target, { from = 0, frames = 1200, omega } = {}) {
  let pos = from, vel = 0, n = 0, overshoot = 0;
  while (n < frames && !S.settled(pos, vel, target)) {
    const s = S.step(pos, vel, target, FRAME, omega);
    pos = s.pos; vel = s.vel; n++;
    overshoot = Math.max(overshoot, Math.abs(pos - from) - Math.abs(target - from));
  }
  return { pos, vel, frames: n, ms: (n / 60) * 1000, overshoot };
}

test('converges to a static target', () => {
  const r = run(1000);
  assert.ok(r.frames < 1200, 'should settle, took ' + r.frames + ' frames');
  assert.ok(Math.abs(r.pos - 1000) < S.EPS, 'ended at ' + r.pos);
});

test('never overshoots, at any distance', () => {
  // Critically damped means monotonic approach. Overshoot here would read as a
  // bounce at the bottom of the transcript.
  for (const d of [1, 5, 24, 240, 1000, 5000, 20000]) {
    assert.ok(run(d).overshoot < 0.001, d + 'px overshot by ' + run(d).overshoot);
  }
});

test('approach is monotonic — never reverses toward the target', () => {
  let pos = 0, vel = 0, prev = 0;
  for (let i = 0; i < 200; i++) {
    const s = S.step(pos, vel, 800, FRAME);
    pos = s.pos; vel = s.vel;
    assert.ok(pos >= prev - 1e-9, 'went backwards at frame ' + i);
    prev = pos;
  }
});

test('scrolls up as smoothly as down', () => {
  const r = run(0, { from: 1000 });
  assert.ok(r.overshoot < 0.001, 'overshot going up by ' + r.overshoot);
  assert.ok(Math.abs(r.pos) < S.EPS, 'ended at ' + r.pos);
});

test('is stable at a pathological dt', () => {
  // A hidden window throttles rAF; a GC pause stalls it. Implicit integration
  // has to absorb a multi-second frame without launching the viewport.
  let pos = 0, vel = 0;
  for (let i = 0; i < 20; i++) { const s = S.step(pos, vel, 1000, 5.0); pos = s.pos; vel = s.vel; }
  assert.ok(Number.isFinite(pos) && Number.isFinite(vel), 'diverged: ' + pos);
  assert.ok(pos <= 1000.001, 'overshot on a huge dt: ' + pos);
});

test('a zero or negative dt is a no-op, not a NaN', () => {
  for (const dt of [0, -1]) {
    const s = S.step(100, 5, 900, dt);
    assert.strictEqual(s.pos, 100);
    assert.strictEqual(s.vel, 5);
  }
});

test('tracks a moving target with bounded lag', () => {
  // The real case: content grows while we chase it. Lag must converge to a
  // constant, not accumulate — an accumulating lag means the caret walks off
  // the bottom of the screen during a long reply.
  let pos = 0, vel = 0, target = 0;
  const lag = [];
  for (let i = 0; i < 400; i++) {
    target += 250 / 60; // 250px/s, a realistic stream
    const s = S.step(pos, vel, target, FRAME);
    pos = s.pos; vel = s.vel;
    if (i > 200) lag.push(target - pos);
  }
  const drift = Math.abs(lag[lag.length - 1] - lag[0]);
  assert.ok(drift < 0.5, 'lag is still growing after 200 frames: drift ' + drift);
  // Under one line height, or the caret visibly detaches from the bottom.
  assert.ok(lag[lag.length - 1] < 24, 'steady-state lag too large: ' + lag[lag.length - 1]);
});

test('settle time stays in the readable band', () => {
  // Fast enough not to feel sluggish, slow enough that the ease is visible.
  // These bounds are deliberately loose — they catch a retune that changes the
  // character of the motion, not a tweak.
  const line = run(24).ms;
  const dump = run(1000).ms;
  assert.ok(line > 120 && line < 900, 'one line settles in ' + line + 'ms');
  assert.ok(dump > 250 && dump < 1400, 'a big jump settles in ' + dump + 'ms');
});

test('settled() needs both position and stillness', () => {
  assert.ok(!S.settled(1000, 500, 1000), 'at target but flying — not settled');
  assert.ok(!S.settled(0, 0, 1000), 'stopped but far away — not settled');
  assert.ok(S.settled(1000, 0, 1000), 'at target and stopped');
});
