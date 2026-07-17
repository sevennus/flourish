'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  FlourishParser, POINT_EFFECTS, STYLE_SPANS, PER_CHAR_SPANS, PALETTES, SIZES, parseArgs,
  DISABLED_EFFECTS,
} = require('../src/flourish');
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

test('every point effect parses on its own and leaves no text', () => {
  for (const n of POINT_EFFECTS) {
    const { text, events } = parseAll(`{{fx:${n}}}`);
    assert.strictEqual(text, '', `${n} left visible text behind`);
    assert.strictEqual(events.length, 1, `${n} did not emit exactly one event`);
    assert.strictEqual(events[0].t, 'effect');
    assert.strictEqual(events[0].name, n);
  }
});

test('every style span round-trips its wrapped text', () => {
  for (const n of STYLE_SPANS) {
    const { text, events } = parseAll(`{{fx:${n}}}x{{/fx:${n}}}`);
    assert.strictEqual(text, 'x', `${n} lost its text`);
    assert.deepStrictEqual(events.map((e) => e.t), ['style-start', 'text', 'style-end'], `${n} span is unbalanced`);
  }
});

// ---- point-effect args ----

test('point effects carry a palette and a size arg', () => {
  const { events } = parseAll('{{fx:swarm violet lg}}');
  assert.strictEqual(events[0].name, 'swarm');
  assert.strictEqual(events[0].args, 'violet lg');
  const a = parseArgs(events[0].args);
  assert.strictEqual(a.palette, 'violet');
  assert.strictEqual(a.scale, SIZES.lg);
});

test('args parse in either order, and default when absent', () => {
  assert.deepStrictEqual(parseArgs('lg gold'), { palette: 'gold', scale: SIZES.lg, words: [] });
  assert.deepStrictEqual(parseArgs('gold lg'), { palette: 'gold', scale: SIZES.lg, words: [] });
  assert.deepStrictEqual(parseArgs(''), { palette: null, scale: 1, words: [] });
  assert.deepStrictEqual(parseArgs(undefined), { palette: null, scale: 1, words: [] });
});

test('a bogus arg degrades to the default instead of killing the effect', () => {
  // The model will typo one of these eventually; it must not cost us the
  // effect. Unrecognised words ride along in `words` — that's how wireframe
  // hears "prism" — and an effect that doesn't read them is unchanged.
  assert.deepStrictEqual(parseArgs('chartreuse enormous'),
    { palette: null, scale: 1, words: ['chartreuse', 'enormous'] });
  assert.deepStrictEqual(parseArgs('chartreuse lg'),
    { palette: null, scale: SIZES.lg, words: ['chartreuse'] });
  const { text, events } = parseAll('{{fx:spark chartreuse}}');
  assert.strictEqual(text, '');
  assert.strictEqual(events[0].name, 'spark');
});

test('args are case-insensitive', () => {
  assert.deepStrictEqual(parseArgs('GOLD XL'), { palette: 'gold', scale: SIZES.xl, words: [] });
});

// The seams below are where this thing silently breaks: a name can exist in the
// parser but have no engine case / no CSS rule / no mention in the system
// prompt, and the effect just never plays with nothing to show for it.

test('every point effect is handled by the engine', () => {
  const { RENDERER_EFFECTS, ASCII_EFFECTS } = require('../src/flourish');
  const src = read('src/effects.js');
  for (const n of POINT_EFFECTS) {
    if (RENDERER_EFFECTS.has(n)) continue;   // handled before the engine ever sees it
    if (ASCII_EFFECTS.has(n)) {
      // The ASCII family has no case labels on purpose: fire() dispatches the
      // whole set by name off ASCII_EFFECTS, so an eleventh scene costs no
      // switch edit. A `case '...'` assertion here would be testing the
      // mechanism rather than the defect — and the defect this test has always
      // been about is a name in the vocabulary that nothing implements. So
      // check the thing the dispatch actually reaches for.
      assert.ok(src.includes(`_${n}(x, y, o) {`),
        `effects.js has no _${n}() for the ascii dispatch to land on`);
      continue;
    }
    assert.ok(src.includes(`case '${n}':`), `effects.js fire() has no case for ${n}`);
  }
});

test('the ascii dispatch exists, so its methods are actually reachable', () => {
  // The test above proves _gibson() etc. exist. Existing is not the same as
  // being called: delete the default branch in fire() and every one of those
  // methods is still there, still tested, and never runs again. This asserts
  // the branch that connects them.
  const src = read('src/effects.js');
  assert.ok(/ASCII_EFFECTS\.has\(name\)/.test(src),
    'fire() no longer dispatches ASCII_EFFECTS, so every ascii scene is dead code');
  assert.ok(/const ASCII_EFFECTS = A\.ASCII_EFFECTS/.test(src),
    'effects.js does not import ASCII_EFFECTS, so the dispatch matches nothing');
});

test('the renderer-handled effects are handled by the renderer', () => {
  // dilate paints nothing — it stalls the typewriter — so it's the one point
  // effect with no engine case. That has to be because the renderer intercepts
  // it, not because someone forgot to write it: a name in POINT_EFFECTS that
  // nothing implements is a directive that silently does nothing on screen.
  const { RENDERER_EFFECTS } = require('../src/flourish');
  const rend = read('src/renderer.js');
  assert.ok(RENDERER_EFFECTS.size, 'expected at least one renderer-handled effect');
  assert.match(rend, /RENDERER_EFFECTS\.has\(ev\.name\)/,
    'applyEvents must route renderer effects away from the engine');
  for (const n of RENDERER_EFFECTS) {
    assert.ok(POINT_EFFECTS.has(n), `${n} must still be a point effect the parser knows`);
    assert.ok(rend.includes(`'${n}'`), `renderer.js never mentions ${n}`);
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

test('per-char spans style their <i> children, not just the wrapper', () => {
  // A per-char span renders one <i> per character; CSS that targets only
  // `.fx-name` and never `.fx-name > i` animates the whole run as one block —
  // which is exactly the thing per-char rendering exists to avoid, and it fails
  // silently.
  const css = read('src/styles.css');
  for (const n of PER_CHAR_SPANS) {
    assert.ok(new RegExp(`\\.fx-${n}\\s*>\\s*i`).test(css), `styles.css has no .fx-${n} > i rule`);
  }
});

test('every palette the parser accepts exists in the engine', () => {
  // `{{fx:spark gold}}` where the engine has no gold would silently paint the
  // default and nobody would ever know the arg was dead.
  const src = read('src/effects.js');
  const block = src.slice(src.indexOf('const PALETTES = {'), src.indexOf('const PARTY'));
  for (const n of PALETTES) {
    assert.ok(new RegExp(`^\\s*${n}:`, 'm').test(block), `effects.js PALETTES has no ${n}`);
  }
});

test('the tool-to-effect map only names real effects and palettes', () => {
  // These fire from app events rather than from the model, so no amount of
  // prompt-checking covers them; a typo here is a tool that paints nothing.
  const src = read('src/renderer.js');
  const block = src.slice(src.indexOf('const TOOL_FX = {'), src.indexOf('const DEFAULT_TOOL_FX'));
  const pairs = [...block.matchAll(/\['([a-z]+)',\s*'([a-z]+)'\]/g)];
  assert.ok(pairs.length >= 10, 'expected a populated TOOL_FX map');
  for (const [, fx, pal] of pairs) {
    assert.ok(POINT_EFFECTS.has(fx), `TOOL_FX names unknown effect ${fx}`);
    assert.ok(PALETTES.has(pal), `TOOL_FX names unknown palette ${pal}`);
  }
});

test('the system prompt teaches exactly the vocabulary the parser accepts', () => {
  // Retirement splits what the parser ACCEPTS from what the model is TOLD, and
  // the split has to go one way only. A retired effect stays in the parser so
  // its directive is still stripped from the stream — drop it and any stray
  // {{fx:apophenia}} in an old transcript prints its own braces on screen — but
  // it leaves the prompt so the model stops reaching for it.
  const taught = new Set([...FLOURISH_SYSTEM_PROMPT.matchAll(/\{\{fx:([a-z]+)/g)].map((m) => m[1]));
  for (const n of [...POINT_EFFECTS, ...STYLE_SPANS]) {
    if (DISABLED_EFFECTS.has(n)) {
      assert.ok(!taught.has(n), `${n} is retired but prompt.js still teaches it`);
      continue;
    }
    assert.ok(taught.has(n), `prompt.js never teaches ${n}, so the model will never fire it`);
  }
  for (const n of taught) {
    assert.ok(POINT_EFFECTS.has(n) || STYLE_SPANS.has(n), `prompt.js teaches unknown effect ${n}`);
  }
});

test('a retired effect is still parsed, so it never leaks onto the screen', () => {
  for (const n of DISABLED_EFFECTS) {
    assert.ok(POINT_EFFECTS.has(n) || STYLE_SPANS.has(n),
      `${n} is disabled by removal, which prints its braces instead of hiding them`);
  }
});

test('the text-effects reference sheet covers every style span', () => {
  // assets/fx/text-effects.png is what gets shown to people as "here are the
  // text effects". A span missing from the sheet is a span nobody knows exists.
  const src = read('tools/fx-shots.js');
  const block = src.slice(src.indexOf('const SHEET = ['), src.indexOf('const wait ='));
  const listed = new Set([...block.matchAll(/\['([a-z]+)',/g)].map((m) => m[1]));
  for (const n of STYLE_SPANS) {
    assert.ok(listed.has(n), `the reference sheet never shows ${n}`);
  }
  for (const n of listed) {
    assert.ok(STYLE_SPANS.has(n), `the reference sheet shows unknown span ${n}`);
  }
});

test('the vocabulary is the full 74 effects', () => {
  // The count is asserted because the installed .exe embeds its own copy of
  // prompt.js, so the vocabulary Claude actually has is the one in the BUILD,
  // not the one in the repo. A session once reported "all 40 verified" against
  // a repo holding 50. A bare number here is the cheapest way to make that
  // drift fail loudly instead of quietly.
  // POINT_EFFECTS is 47: 32 + the ten ASCII scenes + the five grid effects
  // (wireframe, plasma, tunnel, firewall, cat — skull and banner were already
  // counted as scenes). Both counts include names that no longer paint — a
  // disabled effect keeps its name in the vocabulary so old transcripts don't
  // print braces (see the retirement test above).
  assert.strictEqual(POINT_EFFECTS.size, 47);
  assert.strictEqual(STYLE_SPANS.size, 27);
  const { ASCII_EFFECTS, GRID_EFFECTS } = require('../src/flourish');
  assert.strictEqual(ASCII_EFFECTS.size, 15);
  assert.strictEqual(GRID_EFFECTS.size, 7);
});

test('the consuming spans are taught with their guardrail', () => {
  // burn/cascade destroy text on screen: cascade takes the characters away for
  // good, and burn leaves them as legible-but-ruined ash. Ash being readable
  // makes a mistake recoverable, not acceptable — burning still says "this is
  // dead". The engine will happily eat a load-bearing sentence, and the only
  // thing stopping it is this paragraph, so its absence is a real defect.
  const { CONSUMING_SPANS } = require('../src/flourish');
  for (const n of CONSUMING_SPANS) {
    assert.ok(FLOURISH_SYSTEM_PROMPT.includes(`{{fx:${n}}}`), `prompt never teaches ${n}`);
  }
  assert.match(FLOURISH_SYSTEM_PROMPT, /DESTROY/,
    'the prompt must say plainly that these destroy text');
  assert.match(FLOURISH_SYSTEM_PROMPT, /NEVER burn a sentence the reader needs/,
    'the prompt must scope consuming spans away from load-bearing text');
});

test('the unreliable spans are taught with their guardrail', () => {
  // rot and confabulate are the only effects in the app where the text on
  // screen stops being the text that was said. The prompt has to say so, and
  // has to aim them away from anything the reader would act on — the same job
  // the burn paragraph does, for a sharper edge.
  const { MUTATING_SPANS } = require('../src/flourish');
  for (const n of MUTATING_SPANS) {
    assert.ok(FLOURISH_SYSTEM_PROMPT.includes(`{{fx:${n}`), `prompt never teaches ${n}`);
  }
  assert.match(FLOURISH_SYSTEM_PROMPT, /CHANGE THE TEXT/,
    'the prompt must say plainly that these rewrite what was said');
  assert.match(FLOURISH_SYSTEM_PROMPT, /never at instructions, results/,
    'the prompt must scope the unreliable spans away from load-bearing text');
});

test('the unreliable spans are not rationed', () => {
  // Jim, twice, on 2026-07-16: "you can definitely do more than one mutate span
  // per reply… dont be afraid to show many. like 'load up the effects'."
  //
  // The prompt used to cap them at one per reply, which is why they'd only ever
  // been seen one at a time. The cap is a judgement call, not a safety rule —
  // the safety rule is mutableMask(), and it's enforced in code, not in prose.
  // This test exists so the cap can't drift back in on the grounds that it
  // sounds prudent. If it should return, it should return because Jim says so.
  assert.doesNotMatch(FLOURISH_SYSTEM_PROMPT, /at most one unreliable/i,
    'the one-per-reply cap on unreliable spans was removed deliberately');
  assert.match(FLOURISH_SYSTEM_PROMPT, /LOAD THEM UP/,
    'the prompt must actively invite the unreliable spans, not merely permit them');
});

test('the mutating spans actually consult the guard', () => {
  // The guard is the reason a careless unreliable span degrades to doing
  // nothing instead of to lying about a command. mutableMask() being correct
  // (see unreliable.test.js) is worth nothing if textfx never calls it, and
  // that's a wiring mistake no visual check would ever catch — the effect looks
  // completely fine either way. It only shows up as a wrong path, once, in
  // whatever Jim pastes into a shell.
  const src = read('src/textfx.js');
  // Anchor on the method DEFINITION (trailing brace), not the dispatch call in
  // play() that shares its name.
  const body = (name, next) =>
    src.slice(src.indexOf(`${name}(span, chars, args) {`), src.indexOf(`${next}(span, chars, args) {`));

  assert.match(body('_rot', '_confabulate'), /this\._mutable\(chars\)/,
    'rot must ask the guard what it may touch');
  assert.match(body('_confabulate', '_intrusive'), /mutableMask/,
    'confabulate must ask the guard what it may touch');

  // And the guard has to be the real one, not a local re-implementation that
  // could drift from the tested version.
  assert.match(src, /window\.Flourish\.mutableMask/,
    'textfx must use the shared mask, not its own copy');
});

test('consuming spans are driven from JS, not CSS', () => {
  // textfx.js animates these per character from script. A CSS animation on the
  // same <i> would fight it for transform/opacity and the fire would stutter.
  const { CONSUMING_SPANS } = require('../src/flourish');
  const css = read('src/styles.css');
  const rend = read('src/renderer.js');
  for (const n of CONSUMING_SPANS) {
    assert.ok(!new RegExp(`\\.fx-${n}\\s*>\\s*i\\s*\\{[^}]*animation:`).test(css),
      `.fx-${n} > i must not carry a CSS animation — textfx.js drives it`);
    assert.ok(!new RegExp(`'${n}'`).test(rend.slice(rend.indexOf('CSS_STAGGERED'), rend.indexOf('CSS_STAGGERED') + 200)),
      `${n} must not be in CSS_STAGGERED`);
  }
  // The seam that actually bites: a name in CONSUMING_SPANS with no branch in
  // textfx.play() is a span that eats the text and then does nothing with it.
  const tfx = read('src/textfx.js');
  for (const n of CONSUMING_SPANS) {
    assert.ok(new RegExp(`name === '${n}'`).test(tfx), `textfx.js play() has no branch for ${n}`);
    assert.ok(new RegExp(`_${n}\\s*\\(`).test(tfx), `textfx.js has no _${n}() implementation`);
  }
});

test('the renderer plays scripted spans when they close', () => {
  // They can only run once every character exists, which is the moment the
  // closing directive lands. Igniting on open would set fire to a word that
  // hadn't finished being typed; rewriting on open would swap a word that
  // hadn't finished arriving.
  const rend = read('src/renderer.js');
  const close = rend.slice(rend.indexOf('function closeStyle'), rend.indexOf('function closeStyle') + 700);
  assert.match(close, /SCRIPTED_SPANS\.has\(name\)/, 'closeStyle must check for a scripted span');
  assert.match(close, /textFX\.play\(/, 'closeStyle must hand off to textfx');
});

test('every scripted span is actually dispatched by textfx', () => {
  // SCRIPTED_SPANS is what the renderer hands to textFX.play(). A name in the
  // set that play() doesn't dispatch is a span that renders as plain text and
  // never tells anyone.
  const { SCRIPTED_SPANS, CONSUMING_SPANS, MUTATING_SPANS } = require('../src/flourish');
  const src = read('src/textfx.js');
  const play = src.slice(src.indexOf('play(name, span, args)'), src.indexOf('_mutable(chars)'));
  for (const n of SCRIPTED_SPANS) {
    assert.match(play, new RegExp(`name === '${n}'`), `textfx play() never dispatches ${n}`);
  }
  for (const n of [...CONSUMING_SPANS, ...MUTATING_SPANS]) {
    assert.ok(SCRIPTED_SPANS.has(n), `${n} needs the whole span but isn't scripted`);
  }
});
