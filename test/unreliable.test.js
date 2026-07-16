/*
 * unreliable.test.js — the spans that change the text after it lands.
 *
 * These are the only effects that can cost the reader something, so what's
 * tested here is mostly the ways they could misbehave rather than the ways they
 * look:
 *
 *   - rot's chains have to terminate. A cycle is a character that keeps
 *     changing forever inside a rAF loop, and it's invisible until someone rots
 *     the one word containing the bad letter.
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

test('every rot chain terminates', () => {
  // The whole table, plus every glyph that appears anywhere inside a chain —
  // the mid-chain glyphs are the ones that don't get their own key and so are
  // easiest to leave dangling in a loop.
  const glyphs = new Set(Object.keys(F.ROT_CHAINS));
  for (const k of Object.keys(F.ROT_CHAINS)) for (const c of F.ROT_CHAINS[k]) glyphs.add(c);
  for (const g of glyphs) {
    assert.ok(F.rotTerminates(g), `rot chain from '${g}' does not terminate`);
  }
});

test('rot bottoms out at a full stop, keeping the character box', () => {
  for (const start of ['e', 'B', 'q', '8', 'M']) {
    let c = start;
    for (let i = 0; i < 12; i++) { const n = F.rotNext(c); if (n === c) break; c = n; }
    assert.strictEqual(c, '.', `'${start}' rotted to '${c}', expected '.'`);
  }
});

test('rot leaves characters it has no chain for alone', () => {
  // Punctuation, whitespace and anything non-Latin are their own terminal
  // state: rot on a line of CJK should quietly do nothing, not throw.
  for (const ch of [' ', '\n', '—', '好', '🙂', '.']) {
    assert.strictEqual(F.rotNext(ch), ch);
    assert.strictEqual(F.rotDepth(ch), 0);
  }
});

test('rotDepth counts the steps actually available', () => {
  assert.strictEqual(F.rotDepth('r'), 1);      // r → .
  assert.strictEqual(F.rotDepth('e'), 3);      // e → c → r → .
  assert.ok(F.rotDepth('a') > F.rotDepth('c')); // longer chains take longer to spend
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
  '/var/www/simjim/apps/flourish',
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
