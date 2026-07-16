/*
 * unreliable.test.js — the spans that change the text after it lands.
 *
 * These are the only effects that can cost the reader something, so what's
 * tested here is mostly the ways they could misbehave rather than the ways they
 * look:
 *
 *   - rot's groups have to partition. A glyph in two groups would flicker
 *     between families, which reads as the word changing rather than as the
 *     letter twitching, and it's invisible until someone rots the one word
 *     containing the shared letter.
 *   - confabulate has to leave the sentence grammatical and has to be able to
 *     find its own way back — the effect is a reader who looks twice, so the
 *     table is walked in both directions.
 *   - the parser has to recognise the new names, or a directive lands on screen
 *     as literal braces.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const F = require('../src/flourish.js');

// ---------- vocabulary ----------

test('the unreliable spans are registered as spans, not point effects', () => {
  for (const n of ['twin', 'overwrite', 'palimpsest', 'rot', 'confabulate', 'intrusive']) {
    assert.ok(F.STYLE_SPANS.has(n), `${n} missing from STYLE_SPANS`);
    assert.ok(!F.POINT_EFFECTS.has(n), `${n} should not be a point effect`);
  }
});

test('the mutating spans are a subset of the per-char spans', () => {
  // Rewriting a character means owning its <i>. A mutating span that isn't
  // per-char would have nothing to rewrite.
  for (const n of F.MUTATING_SPANS) {
    assert.ok(F.PER_CHAR_SPANS.has(n), `${n} mutates but isn't per-char`);
  }
});

test('parser resolves the new spans to style-start/style-end', () => {
  const p = new F.FlourishParser();
  const ev = p.feed('a{{fx:rot}}b{{/fx:rot}}c');
  assert.deepStrictEqual(ev, [
    { t: 'text', value: 'a' },
    { t: 'style-start', name: 'rot', args: '' },
    { t: 'text', value: 'b' },
    { t: 'style-end', name: 'rot' },
    { t: 'text', value: 'c' },
  ]);
});

test('intrusive carries its word through as args', () => {
  const p = new F.FlourishParser();
  const ev = p.feed('{{fx:intrusive still there}}x{{/fx:intrusive}}');
  assert.strictEqual(ev[0].t, 'style-start');
  assert.strictEqual(ev[0].name, 'intrusive');
  assert.strictEqual(ev[0].args, 'still there');
});

// ---------- rot ----------

test('rot groups partition — no glyph belongs to two families', () => {
  const seen = new Map();
  for (const g of F.ROT_GROUPS) {
    for (const ch of g) {
      assert.ok(!seen.has(ch), `'${ch}' is in both '${seen.get(ch)}' and '${g}'`);
      seen.set(ch, g);
    }
  }
});

test('rot never offers a character itself as a swap', () => {
  // A swap that isn't visible is a twitch the reader never sees, and it burns
  // one of the character's few twitches doing nothing.
  for (const g of F.ROT_GROUPS) {
    for (const ch of g) {
      assert.ok(!F.rotVariants(ch).includes(ch), `'${ch}' can swap to itself`);
      assert.strictEqual(F.rotVariants(ch).length, g.length - 1);
    }
  }
});

test('rot covers the letters English is actually made of', () => {
  // The effect is meaningless on a paragraph if the common letters can't move.
  for (const ch of 'etaoinsrhldcum') {
    assert.ok(F.rotVariants(ch).length > 0, `'${ch}' has no lookalikes`);
  }
});

test('rot leaves characters it has no group for alone', () => {
  // Punctuation, whitespace and anything non-Latin have no lookalikes: rot on a
  // line of CJK should quietly do nothing, not throw.
  for (const ch of [' ', '\n', '—', '好', '🙂', '.']) {
    assert.strictEqual(F.rotVariants(ch), '');
  }
});

test('rot swaps stay inside the lookalike family', () => {
  // The guarantee that makes this an unstable character rather than a different
  // word: whatever a glyph flickers to, a reader could have misread it as.
  assert.ok(F.rotVariants('o').includes('0'));
  assert.ok(F.rotVariants('l').includes('1'));
  assert.ok(F.rotVariants('b').includes('6'));
  assert.ok(!F.rotVariants('o').includes('x'));
  assert.ok(!F.rotVariants('e').includes('.'));   // nothing decays to punctuation now
});

// ---------- confabulate ----------

test('planConfab finds only whole words from the table', () => {
  const plan = F.planConfab('you will always remember');
  assert.deepStrictEqual(plan.map((p) => p.from), ['you', 'will', 'always', 'remember']);
  assert.deepStrictEqual(plan.map((p) => p.to), ['I', 'will not', 'never', 'forget']);
});

test('planConfab offsets point at the word it means to replace', () => {
  const text = 'it is always here';
  for (const p of F.planConfab(text)) {
    assert.strictEqual(text.slice(p.start, p.end), p.from);
  }
});

test('planConfab does not fire inside a longer word', () => {
  // 'callous' contains 'all', 'thereafter' contains 'here'. Substring hits
  // would turn prose into nonsense, which reads as a bug rather than as a lie.
  assert.deepStrictEqual(F.planConfab('callous thereafter nowhere allison'), []);
});

test('confabulate can find its way back', () => {
  // The reader who looks twice has to find it changed back, so every
  // substitution has to itself be substitutable in the other direction.
  for (const [a, b] of F.CONFAB_PAIRS) {
    const there = F.planConfab(a);
    assert.strictEqual(there.length, 1, `'${a}' should drift`);
    assert.strictEqual(there[0].to, b);
    // Multi-word replacements ("is not") come back as their first word; what
    // matters is that the pair is reachable from both ends.
    const back = F.planConfab(b);
    assert.ok(back.length >= 1, `'${b}' should drift back`);
  }
});

test('planConfab preserves sentence-initial capitals', () => {
  const [p] = F.planConfab('Always');
  assert.strictEqual(p.to, 'Never');
});

test('planConfab does not read "I" as a sentence-initial capital', () => {
  // "I" is capital wherever it stands, so inheriting its case turns
  // "and I remember" into "and You forget".
  const [p] = F.planConfab('and I remember');
  assert.strictEqual(p.from, 'I');
  assert.strictEqual(p.to, 'you');
});

test('planConfab sends "I" back to a capital', () => {
  const [p] = F.planConfab('you');
  assert.strictEqual(p.to, 'I', '"I" has to stay capital coming back the other way');
});

// ---------- the guard ----------

// The failure this exists to prevent: the reader copies something the model
// never wrote. Each case is a shape that would cause real damage if a mutating
// span silently rewrote one character of it.
const MUST_NOT_TOUCH = [
  'rm -rf /var/www',
  '/var/www/flourish',
  '127.0.0.1:3000',
  'git reset --hard origin/main',
  'npm run smoke:web',
  'claude-opus-4-8',
  'https://simjim.net/history',
  '--dangerously-skip-permissions',
  'process.env.API_KEY',
  'C:\\Users\\jim',
  'v2.1.0',
  '`always`',
  'flourish.service',
  '$HOME/.ssh/id_ed25519',
  'planBurn(count, wind)',
  'apps/api/.env',
  'gibaloogood',   // a password is pure letters — see the test below
];

test('the guard refuses every shape a reader might copy', () => {
  for (const s of MUST_NOT_TOUCH) {
    const mask = F.mutableMask(s);
    // 'gibaloogood' is pure prose by shape and the guard cannot know better;
    // it's in the list to document that, not to claim protection.
    if (s === 'gibaloogood') continue;
    assert.ok(!mask.some(Boolean), `guard allowed a mutation inside: ${s}`);
  }
});

test('the guard allows ordinary prose', () => {
  const s = 'the process agreed to stop';
  const mask = F.mutableMask(s);
  assert.ok(mask.some(Boolean), 'prose should be mutable');
  // Every letter mutable, every space not.
  for (let i = 0; i < s.length; i++) {
    assert.strictEqual(mask[i], /[A-Za-z]/.test(s[i]), `char ${i} (${s[i]})`);
  }
});

test('a path freezes the sentence it sits in', () => {
  // 'edit', 'and', 'then', 'stop' are all prose by shape. What makes this a
  // command line rather than a sentence is the path in the middle of it, and
  // the spread is what lets one token say so about the whole line.
  const mask = F.mutableMask('edit src/main.js and then stop');
  assert.ok(!mask.some(Boolean));
});

test('a bare command verb is protected by the flag beside it', () => {
  // The case shape alone gets wrong: 'rm' and 'git' are fine English-looking
  // tokens. '-rf' and '--hard' are what make them commands.
  assert.ok(!F.mutableMask('rm -rf /var/www').some(Boolean));
  assert.ok(!F.mutableMask('git reset --hard origin/main').some(Boolean));
});

test('the guard protects backticked prose that would otherwise pass', () => {
  // `always` is a pure-letter word, so only the backticks save it — the case
  // where the model marked something up as code and shape alone would have let
  // it through.
  assert.ok(!F.mutableMask('set it to `always` now').some(Boolean));
});

test('a number freezes itself without freezing the sentence', () => {
  // The exception that makes the guard usable. If a bare year contaminated its
  // neighbours the way a path does, half the prose worth pointing these at
  // would silently do nothing.
  const s = 'you will never remember this in 2026';
  const mask = F.mutableMask(s);
  const mutable = [...s].filter((_, i) => mask[i]).join('');
  assert.strictEqual(mutable, 'youwillneverrememberthisin');
  for (const i of [s.indexOf('2026'), s.length - 1]) assert.ok(!mask[i], 'the digits stay put');
});

test('the spread stops at the end of a sentence', () => {
  // A path in the next sentence must not reach back and freeze this one.
  const s = 'The flag was always set. See config/always.json';
  const mask = F.mutableMask(s);
  assert.ok(mask[s.indexOf('always')], 'prose before the full stop survives');
  assert.ok(!mask[s.indexOf('See')], 'the sentence containing the path does not');
  assert.ok(mask[s.indexOf('set.')], 'the run that ended the sentence is not part of the next one');
});

test('the guard keeps sentence punctuation but never moves it', () => {
  const s = 'stop, then wait.';
  const mask = F.mutableMask(s);
  assert.ok(mask[0], 'stop should be mutable');
  assert.ok(!mask[s.indexOf(',')], 'punctuation is not a letter');
  assert.ok(!mask[s.length - 1], 'trailing full stop is not a letter');
});

test('planConfab and the guard agree on what confabulate may turn over', () => {
  // The composition is what actually ships: a plan is only allowed to fire
  // where the mask permits every character of the word. The same word appears
  // twice — once as prose, once inside a path — and only one may drift.
  const s = 'The flag was always set. See config/always.json';
  const mask = F.mutableMask(s);
  const allowed = F.planConfab(s).filter((p) => {
    for (let i = p.start; i < p.end; i++) if (!mask[i]) return false;
    return true;
  });
  assert.strictEqual(allowed.length, 1, 'only the prose "always" may drift');
  assert.strictEqual(allowed[0].start, s.indexOf('always'));
  assert.ok(allowed[0].start < s.indexOf('config/'), 'the path copy must be untouched');
});

// ---------- overwrite ----------

test('overwrite closes up as it goes and never reverses', () => {
  const n = 20;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const s = F.overwriteShift(i, n);
    assert.ok(s >= prev, 'shift must be monotonic');
    assert.ok(s >= 0 && s < 1, 'a shift past one character width would reverse the text');
    prev = s;
  }
  assert.strictEqual(F.overwriteShift(0, n), 0, 'the first character has nothing to land on');
});

test('overwrite is a no-op on a single character', () => {
  assert.strictEqual(F.overwriteShift(0, 1), 0);
});

// ---------- the tokenizer's tolerance for long args ----------
//
// palimpsest is the only span whose args are a sentence rather than a keyword,
// so it's the only one that can outgrow the buffer the parser is willing to
// keep. It did: a flat 64-char cap left 46 characters for the old text, and
// anything longer arrived on screen as literal braces. The example in demo.js
// is 49 characters, so it cleared the cap and every test passed.

const parse = (s) => { const p = new F.FlourishParser(); return [...p.feed(s), ...p.flush()]; };
const leaks = (s) => parse(s).some((e) => e.t === 'text' && e.value.includes('{{fx:'));

test('palimpsest survives args longer than a keyword', () => {
  const old = 'we took it down for six hours because I skipped the staging step';
  const src = `{{fx:palimpsest ${old}}}a change reduced availability{{/fx:palimpsest}}`;
  assert.ok(src.indexOf('}}') + 2 > 64, 'this test is pointless if the tag is short');

  const evs = parse(src);
  assert.ok(!leaks(src), 'the directive leaked onto the screen as literal text');
  const start = evs.find((e) => e.t === 'style-start');
  assert.strictEqual(start.name, 'palimpsest');
  assert.strictEqual(start.args, old, 'the old text must survive the trip intact');
});

test('every span that takes free-text args accepts a full sentence', () => {
  const sentence = 'a sentence long enough that no one would call it a keyword, twice over';
  for (const [name, src] of [
    ['palimpsest', `{{fx:palimpsest ${sentence}}}new{{/fx:palimpsest}}`],
    ['intrusive', `{{fx:intrusive ${sentence}}}text{{/fx:intrusive}}`],
  ]) {
    assert.ok(!leaks(src), `${name} leaked with a sentence of args`);
  }
});

test('a stray brace in prose is rejected faster than the old cap allowed', () => {
  // The reason a cap existed at all. It must still hold — and now it should
  // give up long before it has eaten 64 characters of the reader's sentence.
  for (const s of ['{{ hello there', '{{not a directive at all', '{{/nope']) {
    assert.ok(!F.plausibleDirective(s), `kept buffering: ${s}`);
  }
  assert.ok(!F.plausibleDirective('{{ '), 'three characters is enough to know');

  const src = 'a stray {{ in prose must not swallow the rest of the reply';
  const text = parse(src).filter((e) => e.t === 'text').map((e) => e.value).join('');
  assert.strictEqual(text, src, 'literal text must round-trip unchanged');
});

test('a directive still being typed is not rejected early', () => {
  for (const s of ['{{', '{{f', '{{fx:', '{{fx:glow', '{{fx:glow}', '{{/', '{{/fx:pal']) {
    assert.ok(F.plausibleDirective(s), `gave up too early on: ${s}`);
  }
});

test('a typo\'d name still lands as literal text, whole', () => {
  // Names are checked in _resolve, not while buffering, so a misspelling comes
  // through in one piece rather than in fragments.
  const evs = parse('{{fx:shimer}}');
  assert.deepStrictEqual(evs, [{ t: 'text', value: '{{fx:shimer}}' }]);
});

test('an opening tag that never closes is still bounded', () => {
  // Only the BUFFER is bounded. Text that has already been ruled out as a
  // directive is ordinary prose and streams through unbuffered, however long
  // it runs — so the assertion is about the first event, not all of them.
  const src = '{{fx:palimpsest ' + 'x'.repeat(F.MAX_DIRECTIVE_LEN * 2);
  const evs = parse(src);
  assert.strictEqual(evs[0].t, 'text', 'the runaway buffer must be flushed as text');
  assert.ok(evs[0].value.startsWith('{{fx:palimpsest'), 'the first event is the buffer');
  assert.ok(evs[0].value.length <= F.MAX_DIRECTIVE_LEN + 1, 'buffered past the backstop');
  assert.strictEqual(evs.map((e) => e.value).join(''), src, 'nothing may be dropped');
});

// ---------- lightning geometry ----------
//
// The old bolt was a straight line with noise on it, drawn whole from the first
// frame. Both defects were visible in every screenshot ever taken of it and
// nobody looked, which is the same way apophenia's straight rule survived — so
// the replacement's geometry is pure and its properties are asserted here
// rather than left to the eye.

// A pinned PRNG: the shape must be checkable, not just plausible.
const seeded = (n) => { let s = n; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; };

test('a bolt lands exactly where it was aimed', () => {
  // The target is a word that is about to catch fire. A bolt that misses the
  // word it ignites is worse than no bolt.
  for (let i = 0; i < 20; i++) {
    const pts = F.boltPath(10, -12, 400, 300, 0.3, 6, seeded(i + 1));
    assert.deepStrictEqual(pts[0], { x: 10, y: -12 }, 'origin moved');
    assert.deepStrictEqual(pts[pts.length - 1], { x: 400, y: 300 }, 'bolt missed its target');
  }
});

test('subdivision is self-similar, not merely noisy', () => {
  // The stick was a line plus uniform jitter: detail at one scale only. Each
  // level here must contribute strictly less deviation than the one above it,
  // which is what makes the channel read as lightning at every zoom.
  const spread = (detail) => {
    const pts = F.boltPath(0, 0, 0, 600, 0.3, detail, seeded(7));
    return Math.max(...pts.map((p) => Math.abs(p.x)));
  };
  let prev = 0;
  const deltas = [];
  for (let d = 1; d <= 6; d++) { const s = spread(d); deltas.push(s - prev); prev = s; }
  // Later levels may add nothing (a midpoint can be pushed back inward), but
  // none may add MORE than the coarsest did — that would be scribble.
  for (const d of deltas.slice(1)) {
    assert.ok(d <= deltas[0] + 1e-9, 'a fine level displaced more than the coarse one');
  }
  assert.ok(F.BOLT_FALLOFF > 0.5 && F.BOLT_FALLOFF < 0.6, 'falloff outside the band that reads as lightning');
});

test('detail adds points without wandering off the page', () => {
  const pts = F.boltPath(300, 0, 300, 500, 0.3, 6, seeded(3));
  assert.strictEqual(pts.length, 2 ** 6 + 1, 'subdivision dropped points');
  const off = Math.max(...pts.map((p) => Math.abs(p.x - 300)));
  assert.ok(off < 500 * 0.3 * 2, `bolt wandered ${off.toFixed(0)}px off its axis`);
});

test('the leader is a staircase, not a ramp', () => {
  // The whole point of "erratic". An even advance is a progress bar; a smooth
  // one is a wipe. Neither is lightning.
  const stair = F.leaderStair(10, seeded(11));
  assert.strictEqual(stair[stair.length - 1].t, 1, 'the last step must land on the strike');
  assert.strictEqual(stair[stair.length - 1].len, 1, 'the channel must finish complete');
  for (let i = 1; i < stair.length; i++) {
    assert.ok(stair[i].t > stair[i - 1].t, 'time went backwards');
    assert.ok(stair[i].len > stair[i - 1].len, 'the leader retreated');
  }
  // Jumps must be uneven — that is the erratic part, and it is testable.
  const jumps = stair.map((s, i) => s.len - (i ? stair[i - 1].len : 0));
  const mean = jumps.reduce((a, b) => a + b) / jumps.length;
  const spread = Math.max(...jumps) / Math.min(...jumps);
  assert.ok(spread > 1.5, `jumps too even (${spread.toFixed(2)}×) — reads as a progress bar`);
  assert.ok(mean > 0);
});

test('reveal holds still between steps', () => {
  // The dark pause between jumps is not a gap in the animation, it IS the
  // animation. If reveal moves every frame, the staircase was a ramp.
  const stair = F.leaderStair(8, seeded(5));
  const seen = new Set();
  for (let t = 0; t < 1; t += 0.01) seen.add(F.revealAt(stair, t).toFixed(6));
  assert.ok(seen.size <= 9, `reveal took ${seen.size} distinct values across 8 steps — it is ramping`);
  assert.strictEqual(F.revealAt(stair, 1), 1);
  assert.strictEqual(F.revealAt(stair, 0), 0, 'the channel must start dark');
});

test('reveal never goes backwards', () => {
  const stair = F.leaderStair(12, seeded(9));
  let prev = -1;
  for (let t = 0; t <= 1.2; t += 0.005) {
    const r = F.revealAt(stair, t);
    assert.ok(r >= prev, `reveal retreated at t=${t.toFixed(3)}`);
    prev = r;
  }
});

test('forks leave the trunk at a real point and inherit its heading', () => {
  const main = F.measurePath(F.boltPath(300, 0, 300, 500, 0.3, 6, seeded(2)));
  const forks = F.forkPaths(main, 5, 1, seeded(4));
  assert.strictEqual(forks.length, 5);
  for (const f of forks) {
    assert.ok(f.at >= 0 && f.at <= 1, 'fork point is off the trunk');
    const root = f.pts[0];
    const onTrunk = main.pts.some((p) => Math.hypot(p.x - root.x, p.y - root.y) < 1e-6);
    assert.ok(onTrunk, 'a fork started somewhere the trunk never went');
    assert.ok(f.w < 1, 'a fork must be thinner than the trunk it leaves');
  }
});

test('arc length is measured, so growth advances by distance', () => {
  // Midpoint displacement leaves segments of wildly uneven length. Revealing by
  // point index would crawl the detailed stretches and leap the smooth ones.
  const path = F.measurePath([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 14 }]);
  assert.strictEqual(path.total, 15);
  assert.deepStrictEqual(path.cum, [0, 5, 15]);
});

test('measure never divides by zero on a degenerate path', () => {
  assert.strictEqual(F.measurePath([{ x: 5, y: 5 }]).total, 1);
});

// ---------- apophenia, retired ----------

test('apophenia still parses so it cannot leak braces onto the screen', () => {
  const p = new F.FlourishParser();
  const evs = [...p.feed('{{fx:apophenia}}'), ...p.flush()];
  assert.deepStrictEqual(evs, [{ t: 'effect', name: 'apophenia', args: '' }],
    'a retired name must still resolve — dropping it from the vocabulary prints it instead');
});

test('apophenia is disabled but its geometry stays under test', () => {
  assert.ok(F.DISABLED_EFFECTS.has('apophenia'), 'apophenia should be retired');
  assert.ok(F.POINT_EFFECTS.has('apophenia'), 'it must stay in the vocabulary to be stripped');
  // The machinery lightning inherited. If this ever goes, lightning loses its
  // ability to strike words at all.
  assert.strictEqual(typeof F.stratifyAnchors, 'function');
  assert.strictEqual(typeof F.anchorsFlat, 'function');
});
