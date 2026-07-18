/*
 * flourish.js — the Flourish protocol parser.
 *
 * Pure, dependency-free, and streaming-safe: you feed it text as it arrives
 * (possibly one character at a time, possibly with a directive split across
 * two chunks) and it emits an ordered list of events. It never renders and
 * never touches the DOM, so it runs identically in the browser renderer and
 * under `node --test`.
 *
 * The model embeds directives in its replies; the app strips them from the
 * visible text and turns them into effects at the exact point they appear:
 *
 *   Point effects (fire once, at the current caret):
 *     {{fx:spark}} {{fx:confetti}} {{fx:fireworks}} {{fx:ripple}}
 *     {{fx:pulse}} {{fx:shake}} {{fx:matrix}} {{fx:lightning}} {{fx:nova}}
 *     {{fx:meteor}} {{fx:embers}} {{fx:vortex}} {{fx:glitch}} {{fx:aurora}}
 *     {{fx:constellation}} {{fx:shatter}} {{fx:swarm}} {{fx:sonar}}
 *     {{fx:warp}} {{fx:frost}} {{fx:bloom}} {{fx:rain}} {{fx:beam}}
 *     {{fx:implode}}
 *
 *   Point effects take optional args — a palette and/or a size:
 *     {{fx:spark gold}}  {{fx:nova sm}}  {{fx:swarm violet lg}}
 *
 *   Text spans (style the wrapped characters):
 *     {{fx:shimmer}}...{{/fx:shimmer}}   {{fx:rainbow}}...{{/fx:rainbow}}
 *     {{fx:glow}}...{{/fx:glow}}         {{fx:wave}}...{{/fx:wave}}
 *     {{fx:fire}}...{{/fx:fire}}         {{fx:neon}}...{{/fx:neon}}
 *     {{fx:scramble}}...{{/fx:scramble}} {{fx:bounce}}...{{/fx:bounce}}
 *     {{fx:flicker}}...{{/fx:flicker}}   {{fx:redact}}...{{/fx:redact}}
 *     {{fx:stamp}}...{{/fx:stamp}}       {{fx:chrome}}...{{/fx:chrome}}
 *     {{fx:ghost}}...{{/fx:ghost}}       {{fx:corrupt}}...{{/fx:corrupt}}
 *     {{fx:sparkle}}...{{/fx:sparkle}}
 *     {{fx:color #ff0066}}...{{/fx:color}}
 *
 * Emitted events:
 *     { t: 'text',        value: '<string>' }
 *     { t: 'effect',      name: '<name>', args: '<raw args string>' }
 *     { t: 'style-start', name: '<name>', args: '<raw args string>' }
 *     { t: 'style-end',   name: '<name>' }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Flourish = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // The ASCII register: scenes made of monospace text on the canvas, each one
  // a machine talking to itself. They share one engine and one array in
  // effects.js, and this set is what makes that possible — the dispatch, the
  // draw pass and fx-shots' reset all read this name rather than each carrying
  // its own hand-maintained copy of the list. Adding an eleventh means adding
  // it here and teaching it in prompt.js; nothing else needs to know.
  const ASCII_EFFECTS = new Set([
    'gibson', 'wardial', 'crack', 'banner', 'sniffer',
    'trace', 'daemon', 'portscan', 'skull', 'overflow',
    'wireframe', 'plasma', 'tunnel', 'firewall', 'cat',
    'snake', 'invaders', 'pacman', 'ufo', 'blackhole',
    'life', 'melt', 'quake', 'dvd', 'aquarium',
    // elemental grid effects (volume III): a front sweeps across the prose and
    // transmutes it — burns, freezes, corrodes, floods, buries.
    'ignite', 'frostbite', 'corrode', 'electrify', 'overgrow',
    'rust', 'flood', 'petrify', 'smokescreen', 'glaciate',
    'magma', 'windshear', 'thunderhead', 'sandbury', 'spores',
  ]);

  // The grid register: effects that are painted INTO the terminal's own
  // character grid rather than floating over it. The renderer measures the
  // grid — cell size, every visible character and where it sits — and hands
  // the snapshot in as o.grid (plus o.platforms for the cat). Two rules:
  //
  //   1. Wherever the effect's ink lands on a REAL character, it uses that
  //      character — the prose itself lights up, and the effect is visibly
  //      built out of what was already on screen.
  //   2. No grid, no paint. A grid effect fired bare must draw NOTHING —
  //      this repo's signature bug is an effect quietly running a fallback
  //      and photographing well (apophenia, fx-shots, the probe's font
  //      regex). A blank shot is a failure someone sees.
  const GRID_EFFECTS = new Set([
    'skull', 'banner', 'wireframe', 'plasma', 'tunnel', 'firewall', 'cat',
    'snake', 'invaders', 'pacman', 'ufo', 'blackhole',
    'life', 'melt', 'quake', 'dvd', 'aquarium',
    'ignite', 'frostbite', 'corrode', 'electrify', 'overgrow',
    'rust', 'flood', 'petrify', 'smokescreen', 'glaciate',
    'magma', 'windshear', 'thunderhead', 'sandbury', 'spores',
  ]);

  // Which directive names are point effects vs. wrapping style spans.
  const POINT_EFFECTS = new Set([
    'spark', 'confetti', 'fireworks', 'ripple', 'pulse', 'shake', 'matrix',
    'lightning', 'nova', 'meteor', 'embers', 'vortex', 'glitch',
    'aurora', 'constellation', 'shatter', 'swarm', 'sonar', 'warp',
    'frost', 'bloom', 'rain', 'beam', 'implode',
    'scanlines', 'static', 'vhs', 'grid', 'circuit', 'tracer',
    'apophenia', 'dilate',
    // elemental particle effects (volume III)
    'firebomb', 'napalm', 'blizzard', 'electricity', 'smoke',
    'lava', 'hail', 'steam', 'acid', 'sandstorm',
    'cinders', 'shockwave', 'whirlwind', 'geyser', 'venom',
    ...ASCII_EFFECTS,
  ]);

  // Effects that still parse but no longer paint.
  //
  // apophenia is retired. It shipped drawing a straight rule through the prose
  // instead of a web, its sampling guaranteed that by construction, and the
  // screenshot that passed review was of its own fallback path. It was fixed
  // (f3eedff), seen working, and turned down on the merits — a fair trial and a
  // real verdict.
  //
  // Retired rather than deleted, for two reasons. Its anchor geometry —
  // anchorsFlat, stratifyAnchors, wordAnchors — is the only code here that
  // hangs an effect off real words, and lightning now depends on all of it;
  // keeping apophenia's tests alive keeps that machinery honest. And a name
  // that still PARSES is a name that gets stripped from the stream: drop it
  // from the vocabulary instead, and any stray `{{fx:apophenia}}` in an old
  // transcript starts printing itself on screen as literal braces.
  //
  // shatter is retired on the merits: breaking glass was the one effect that
  // looked like a stock asset rather than like this terminal, and it said
  // nothing `shake` and `glitch` don't say better. Turned down 2026-07-16.
  //
  // Retiring rather than deleting matters MORE here than it did for apophenia,
  // and for the reason spelled out above: shatter was in the prompt for months
  // and the model reached for it constantly, so the transcripts are full of it.
  // Drop the name from POINT_EFFECTS and every one of those replies starts
  // rendering `{{fx:shatter}}` as literal braces the next time it's scrolled
  // back through — a delete that corrupts the archive instead of the feature.
  // `_shatter` and the `shard` particle shape stay in effects.js, unreachable:
  // the renderer never dispatches a disabled name, so they cost a few dead
  // lines and buy a one-word revert.
  //
  // So it resolves, and the renderer drops it on the floor. To bring it back,
  // take it out of this set and restore its line in prompt.js.
  const DISABLED_EFFECTS = new Set(['apophenia', 'shatter']);

  // dilate paints nothing. It's here because it fires like a point effect and
  // the model names it like one, but the renderer intercepts it before the
  // engine ever sees it: the whole effect is the typewriter holding still for a
  // beat, and in a terminal that never stops painting, stopping is the only
  // thing left that can unsettle anyone. See DILATE_MS in renderer.js.
  const RENDERER_EFFECTS = new Set(['dilate']);
  const STYLE_SPANS = new Set([
    'shimmer', 'rainbow', 'glow', 'wave', 'color',
    'fire', 'neon', 'scramble', 'bounce',
    'flicker', 'redact', 'stamp', 'chrome', 'ghost', 'corrupt', 'sparkle',
    'burn', 'cascade', 'hologram', 'hexdump',
    'twin', 'overwrite', 'palimpsest', 'rot', 'confabulate', 'intrusive',
    'salvage',
  ]);

  // Spans rendered one <i> per character (staggered animation or per-char JS)
  // rather than as a single styled span. The renderer needs this; it lives here
  // so the vocabulary stays in one place.
  const PER_CHAR_SPANS = new Set([
    'wave', 'bounce', 'scramble', 'stamp', 'corrupt', 'sparkle',
    'burn', 'cascade', 'hexdump',
    'twin', 'overwrite', 'rot', 'confabulate', 'intrusive',
    'salvage',
  ]);

  // Spans that CHANGE THE TEXT after it has landed, rather than styling it.
  // They're the unreliable register: rot degrades characters in place,
  // confabulate rewrites words behind the reader, intrusive pushes a word in
  // that was never said. Driven from textfx.js once the span closes, like the
  // consuming spans, and for the same reason — a word can't be rewritten until
  // it has finished being typed.
  //
  // Everything else in the vocabulary is safe to point at anything: a glowing
  // command is still the command. These are not, so they carry a hard
  // restriction that lives in textfx.js rather than in the system prompt —
  // see MUTABLE_REJECT there. The prompt can only ask the model to aim them
  // well; the guard is what makes aiming badly harmless.
  const MUTATING_SPANS = new Set(['rot', 'confabulate', 'intrusive']);

  // Spans driven from script (textfx.js) once the closing directive arrives,
  // rather than as characters stream in. They all share one reason: they need
  // the span to be COMPLETE. Fire can't spread through a word that's still being
  // typed, a word can't be swapped before it exists, and overwrite can't ramp a
  // pull-back across `n` characters until it knows what `n` is.
  const SCRIPTED_SPANS = new Set([
    'burn', 'cascade', 'rot', 'confabulate', 'intrusive', 'overwrite',
    'salvage',
  ]);

  // Spans that DESTROY the text they wrap — the characters are gone when the
  // effect finishes. They're driven by src/textfx.js rather than by CSS, and
  // they're the one part of the vocabulary that can cost the reader something,
  // so the system prompt scopes them to moments where the disappearing IS the
  // point rather than to decoration on a sentence someone needs to read.
  const CONSUMING_SPANS = new Set(['burn', 'cascade']);

  // Point-effect args. A directive may carry a palette name and/or a size, in
  // any order: `{{fx:spark gold}}`, `{{fx:nova sm}}`, `{{fx:swarm violet lg}}`.
  // Parsed here (rather than in the engine) so the vocabulary — including what
  // counts as a valid argument — stays in one place.
  const PALETTES = new Set(['mint', 'ice', 'gold', 'ember', 'violet', 'rose', 'mono']);
  const SIZES = { sm: 0.55, md: 1, lg: 1.7, xl: 2.6 };

  /**
   * Parse a raw point-effect args string into { palette, scale }.
   * Unknown words are ignored, so a typo degrades to the default rather than
   * killing the effect.
   */
  function parseArgs(raw) {
    // `words` carries every arg that isn't a palette or a size, in order —
    // that's how a directive names a variant ({{fx:wireframe prism}}) without
    // each effect growing its own parser. Unknown words still cost nothing:
    // an effect that doesn't read o.words behaves exactly as before.
    const out = { palette: null, scale: 1, words: [] };
    for (const w of String(raw || '').toLowerCase().split(/\s+/)) {
      if (!w) continue;
      if (PALETTES.has(w)) out.palette = w;
      else if (SIZES[w] != null) out.scale = SIZES[w];
      else out.words.push(w);
    }
    return out;
  }

  // ---- wind, for the consuming spans ----

  const WIND_STRENGTH = { still: 0, breeze: 0.55, gale: 1 };

  /**
   * Parse a consuming span's args into { dir, strength }.
   *   {{fx:burn}}            → downwind right, a breeze
   *   {{fx:burn left}}       → blows left
   *   {{fx:burn left gale}}  → blows left, hard
   *   {{fx:burn still}}      → no wind; spreads evenly in both directions
   * dir is +1 (rightwards) or -1 (leftwards); strength is 0..1.
   */
  function parseWind(raw) {
    const out = { dir: 1, strength: WIND_STRENGTH.breeze };
    for (const w of String(raw || '').toLowerCase().split(/\s+/)) {
      if (!w) continue;
      if (w === 'left') out.dir = -1;
      else if (w === 'right') out.dir = 1;
      else if (WIND_STRENGTH[w] != null) out.strength = WIND_STRENGTH[w];
    }
    return out;
  }

  /**
   * Plan how a fire spreads through `count` characters from `seed`.
   * Returns ignition times in ms, relative to the start — one per character.
   *
   * Fire crawls outward from where it started, and wind makes that crawl
   * asymmetric: downwind it races, upwind it creeps. That asymmetry IS the
   * effect — it's what makes the flame front visibly travel — so it lives here
   * as pure arithmetic rather than buried in a requestAnimationFrame loop, and
   * gets tested without a browser.
   *
   * `strength` 0 spreads evenly both ways; 1 is a gale that barely backs up.
   */
  function planBurn(count, wind, seed, spreadMs) {
    const w = wind || { dir: 1, strength: WIND_STRENGTH.breeze };
    const base = spreadMs || 90;
    const s = Math.max(0, Math.min(1, w.strength));
    // Downwind gets faster as the wind rises; upwind gets slower. At strength 0
    // both are `base` and the fire is a symmetric ring.
    const downwind = base * (1 - 0.72 * s);
    const upwind = base * (1 + 3.4 * s);
    const at = new Array(count).fill(Infinity);
    if (count <= 0) return at;
    const from = Math.max(0, Math.min(count - 1, seed | 0));
    at[from] = 0;
    // Walk out from the seed in each direction, accumulating step costs.
    for (let i = from + 1; i < count; i++) at[i] = at[i - 1] + (w.dir > 0 ? downwind : upwind);
    for (let i = from - 1; i >= 0; i--) at[i] = at[i + 1] + (w.dir > 0 ? upwind : downwind);
    return at;
  }

  // ---- salvage: text assembled out of letters already on screen ----

  /**
   * Plan when each character of a salvage span launches, in ms from the start.
   * One entry per character, in character order.
   *
   * Default is reading order: the line assembles left to right, so it reads as
   * text being written by something that had to go and fetch every letter
   * first. `scatter` launches in a random order instead, which reads as the
   * whole line condensing out of the page at once.
   *
   * The jitter is deliberately bounded under one step. Ragged arrival is the
   * point — a perfectly even launch reads as a progress bar, the same trap
   * leaderStair documents below — but jitter wide enough to reorder the line
   * would turn reading order into a lie, and the default mode's only job is to
   * be reading order.
   */
  function planSalvage(count, args, rnd) {
    const random = rnd || Math.random;
    const a = String(args || '').toLowerCase();
    const step = a.includes('fast') ? 24 : (a.includes('slow') ? 88 : 44);
    const order = [];
    for (let i = 0; i < count; i++) order.push(i);
    if (a.includes('scatter')) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = (random() * (i + 1)) | 0;
        const t = order[i]; order[i] = order[j]; order[j] = t;
      }
    }
    const at = new Array(count).fill(0);
    for (let k = 0; k < order.length; k++) {
      at[order[k]] = k * step + random() * step * 0.55;
    }
    return at;
  }

  // ---- rot: characters flickering between lookalikes ----

  // Glyphs grouped by SHAPE: every member of a group is one the reader could
  // plausibly misread another member as. Shape, not meaning — a swap that isn't
  // a lookalike reads as corruption (which `corrupt` already does, loudly)
  // rather than as one character failing to sit still.
  //
  // These replace a set of one-way decay chains. Every character used to walk
  // down its chain toward '.', dimming as it went, so a paragraph didn't wobble
  // — it eroded into punctuation and then into the background. rot now picks a
  // lookalike, holds it for a beat, and puts the true character back, which
  // makes the groups deliberately CYCLIC. There is no terminal glyph left to
  // reach, so there is nothing to prove terminates and nothing to bottom out
  // at; a character is never anywhere it can't come back from.
  //
  // Each group is a closed set and the groups don't overlap — a character has
  // exactly one family it wobbles inside. The partition is what the test checks,
  // since a glyph in two groups would flicker between families and read as the
  // word changing rather than the letter twitching.
  const ROT_GROUPS = [
    'aoce0O',    // round and open
    'il1|IjJ',   // thin strokes
    'nmhr',      // an arch on a stem
    'uvwyV',     // the V shapes
    'bdpq69g',   // a bowl on a stem, in every rotation
    't7f',       // crossed strokes
    's5S', 'z2Z', '38B', '4A', 'MW', 'xX', 'kK', 'CG', 'EF', 'DQ',
    'LT', 'NH', 'RP', 'UY',
  ];

  // ch -> the other glyphs in its group, precomputed. A character in no group
  // (punctuation, emoji, anything non-Latin) maps to '' and simply never
  // flickers, the same way it previously never decayed — rot on a line of CJK
  // quietly does nothing rather than throwing inside a timer.
  const ROT_VARIANTS = (function () {
    const m = {};
    for (const g of ROT_GROUPS) {
      for (const ch of g) {
        m[ch] = g.split('').filter((o) => o !== ch).join('');
      }
    }
    return m;
  })();

  /**
   * The glyphs `ch` can flicker to, as a string, or '' if it has no lookalikes.
   * Pure and total; never returns `ch` itself, so a swap is always visible.
   */
  function rotVariants(ch) {
    return ROT_VARIANTS[ch] || '';
  }

  // ---- confabulate: words that change behind you ----

  // Substitutions that leave the sentence perfectly grammatical and quietly
  // reverse it. Negations and pronouns only: a swap the reader's eye slides over
  // is the whole effect, and anything that needs a thesaurus would need the
  // engine to understand the sentence.
  //
  // Deliberately symmetric — the table is walked in both directions — so the
  // reader who looks twice finds it changed back.
  const CONFAB_PAIRS = [
    ['always', 'never'], ['all', 'none'], ['can', 'cannot'], ['is', 'is not'],
    ['will', 'will not'], ['did', 'did not'], ['does', 'does not'],
    ['yes', 'no'], ['safe', 'unsafe'], ['every', 'no'],
    ['your', 'my'], ['you', 'I'], ['yours', 'mine'], ['yourself', 'myself'],
    ['remember', 'forget'], ['remembered', 'forgot'],
    ['here', 'there'], ['now', 'then'], ['first', 'last'],
    ['before', 'after'], ['more', 'less'], ['true', 'false'],
  ];

  // Keyed lowercase because lookups are; the VALUES keep their own natural
  // casing, which is what carries "I" through as a capital.
  const CONFAB_MAP = (() => {
    const m = new Map();
    for (const [a, b] of CONFAB_PAIRS) { m.set(a.toLowerCase(), b); m.set(b.toLowerCase(), a); }
    return m;
  })();

  // Words that are capitalised wherever they stand. A leading capital normally
  // means "start of a sentence", and the replacement should inherit it — but
  // "I" is capital in the middle of a sentence too, so inheriting from it turns
  // "and I remember" into "and You forget". English has exactly one of these.
  const ALWAYS_CAPITAL = new Set(['i']);

  /**
   * Find the words in `text` that confabulate could turn over.
   * Returns [{ start, end, from, to }] in document order — offsets into `text`,
   * so the caller can map them onto whichever characters it actually owns.
   *
   * Case is inherited on the first letter only, which covers "Always"→"Never"
   * at the start of a sentence without pretending to know about acronyms.
   */
  function planConfab(text) {
    const out = [];
    const re = /[A-Za-z]+/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      const w = m[0];
      const lower = w.toLowerCase();
      const to = CONFAB_MAP.get(lower);
      if (!to) continue;
      const inherit = /^[A-Z]/.test(w) && !ALWAYS_CAPITAL.has(lower);
      const cased = inherit ? to[0].toUpperCase() + to.slice(1) : to;
      out.push({ start: m.index, end: m.index + w.length, from: w, to: cased });
    }
    return out;
  }

  // ---- what the mutating spans refuse to touch ----

  /**
   * Which characters of `text` a mutating span is allowed to rewrite.
   * Returns a boolean array, one per character; true means safe.
   *
   * This is a WHITELIST, and deliberately so. Every other span in the
   * vocabulary is safe to point at anything — a glowing command is still the
   * command — so the rule about not wrapping code and numbers is only a matter
   * of taste, and the system prompt is the right place for it. rot and
   * confabulate are the exception: the text on screen stops being the text that
   * was said. If one lands on a path or a command, the reader copies something
   * the model never wrote, and neither of us finds out.
   *
   * So the prompt asks the model to aim these well, and this makes aiming badly
   * harmless: a run is mutable only if it is plainly a word of English prose.
   * Anything carrying a digit, a slash, a dot, a dash, an underscore or a sigil
   * is left exactly as it arrived, as is anything inside backticks — which is
   * where this app's code and paths always live, because autofx.js exists to put
   * them there.
   *
   * Blacklisting the dangerous shapes would need this to know every shape that
   * could ever matter. Whitelisting prose only needs it to know what a word
   * looks like, and fails toward doing nothing.
   *
   * Shape alone isn't enough, though, because `rm` and `git` are perfectly good
   * words by shape. What makes them commands is the `-rf` and the `--hard` next
   * to them. So contamination SPREADS: a path or a flag freezes the words around
   * it, and keeps spreading until it reaches the end of a sentence. That catches
   * every bare command verb without needing a list of what the commands are
   * called, and it costs nothing when it overreaches — the words simply don't
   * rot.
   *
   * Numbers are the exception that makes this usable: they're frozen themselves
   * but they don't spread, because "never remember this in 2026" is a sentence
   * and freezing it whole for the sake of the year would mean the effect
   * silently doing nothing on half the prose worth pointing it at.
   */
  function mutableMask(text) {
    const s = String(text || '');
    const mask = new Array(s.length).fill(false);

    // Backtick regions are out entirely, backticks included. autofx.js can't
    // help here (the renderer turns the auto layer off inside an explicit
    // span), so the markers are read straight off the raw text.
    const code = new Array(s.length).fill(false);
    let inCode = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '`') { inCode = !inCode; code[i] = true; continue; }
      code[i] = inCode;
    }

    // Letters, with at most one piece of sentence punctuation hanging off
    // either end. Everything else — digits, /, \, ., -, _, =, $, @, ~, (, ) —
    // means this is not prose.
    const PROSE = /^["'(]?[A-Za-z]+(?:['’][A-Za-z]+)?[.,;:!?)"']?$/;
    // A bare quantity: digits with the separators a quantity is allowed to
    // carry. 143, 2026, 3.14, 1,600, 90%, 127.0.0.1:3000.
    const NUMBER = /^\d[\d.,:%]*$/;
    // A run that ends a sentence also ends the blast radius.
    const SENTENCE_END = /[.!?;:][)"']?$/;

    // Collect the runs first; the spread needs to see the neighbours before it
    // can judge any of them.
    const runs = [];
    const RUN = /\S+/g;
    let m;
    while ((m = RUN.exec(s)) !== null) {
      const text = m[0];
      const prose = !code[m.index] && PROSE.test(text);
      runs.push({
        at: m.index, text, prose,
        // What contaminates: anything that is neither prose nor a bare number.
        // A number is frozen on its own account but stops there.
        hard: !prose && !NUMBER.test(text),
        frozen: !prose,
      });
    }

    // Spread outward from every hard run until a sentence ends. The two
    // directions are not symmetric: walking left, a run ending in '.' closed the
    // PREVIOUS sentence and isn't part of this one, so it stops the spread
    // without freezing. Walking right, it's this sentence's last run and freezes
    // before the spread stops.
    for (let r = 0; r < runs.length; r++) {
      if (!runs[r].hard) continue;
      for (let i = r - 1; i >= 0; i--) {
        if (SENTENCE_END.test(runs[i].text)) break;
        runs[i].frozen = true;
      }
      for (let i = r + 1; i < runs.length; i++) {
        runs[i].frozen = true;
        if (SENTENCE_END.test(runs[i].text)) break;
      }
    }

    for (const run of runs) {
      if (run.frozen) continue;
      for (let i = 0; i < run.text.length; i++) {
        if (/[A-Za-z]/.test(run.text[i])) mask[run.at + i] = true;
      }
    }
    return mask;
  }

  // ---- overwrite: characters landing on top of each other ----

  /**
   * How far character `i` of `n` is pulled back into its predecessor, as a
   * fraction of its own width. Ramps from nothing to `max` across the span, so
   * the line starts legible and closes up as it goes — the reader watches it
   * stop being readable rather than being handed a solid block.
   */
  function overwriteShift(i, n, max) {
    if (n <= 1) return 0;
    const k = i / (n - 1);
    return (max == null ? 0.62 : max) * k * k;   // quadratic: slow start, tight finish
  }

  // ---- what a buffered `{{…` is allowed to grow into ----
  //
  // Once we've seen `{{` we buffer, waiting for `}}`. Something has to stop a
  // stray brace in ordinary prose from swallowing the rest of the reply, and
  // that used to be a flat 64-character cap: no `}}` within 64 chars, flush the
  // lot as literal text.
  //
  // That length was sized for directives shaped like `{{fx:swarm violet lg}}`,
  // and it silently broke the one effect whose args are a sentence rather than
  // a keyword. `{{fx:palimpsest ` spends 18 characters before the old text even
  // starts, so any palimpsest carrying more than 46 characters of args blew the
  // cap and landed on screen as literal braces. The only palimpsest example in
  // the repo (demo.js) is 49 characters and cleared it, so every test passed.
  //
  // So check the SHAPE instead of counting characters. Everything ahead of the
  // args is a closed vocabulary — `{{fx:` or `{{/fx:`, then a name — so a
  // candidate can be rejected the moment it stops looking like one, which is
  // both stricter than the cap where it matters (a stray `{{` in prose now dies
  // in three characters instead of sixty-four) and unbounded where it should be
  // (args run as long as the sentence needs).
  //
  // A name that's still being typed is left alone rather than matched against
  // the vocabulary, so a typo'd `{{fx:shimer}}` still reaches _resolve and gets
  // emitted whole as literal text, exactly as it always did.
  const MAX_NAME_LEN = 16;      // 'constellation' is the longest real one, at 13
  const MAX_DIRECTIVE_LEN = 512; // backstop for an opening tag that never closes

  const ALL_NAMES = new Set([...POINT_EFFECTS, ...STYLE_SPANS]);

  /**
   * Could `buf` still become a directive? `buf` starts with `{{` and does not
   * yet contain `}}`. False only when no further character could rescue it, so
   * the caller can stop buffering and flush it as literal text.
   */
  function plausibleDirective(buf) {
    if (buf.length > MAX_DIRECTIVE_LEN) return false;

    // A single trailing `}` is the first half of the `}}` we're waiting for,
    // not part of the name.
    const probe = buf.replace(/\}+$/, '');
    const prefix = probe[2] === '/' ? '{{/fx:' : '{{fx:';
    if (probe.length < prefix.length) return prefix.startsWith(probe);
    if (!probe.startsWith(prefix)) return false;

    const rest = probe.slice(prefix.length);
    const sp = rest.indexOf(' ');
    const name = sp === -1 ? rest : rest.slice(0, sp);
    // Args are free text and checked by nobody; the name is not.
    return /^[A-Za-z]*$/.test(name) && name.length <= MAX_NAME_LEN;
  }

  class FlourishParser {
    constructor() {
      // buf holds a candidate directive once we've seen an opening `{{`.
      // It always starts with the two `{` we've consumed.
      this.buf = '';
      this.inToken = false;
    }

    /**
     * Feed a chunk of text. Returns an array of events for what could be
     * fully resolved; any trailing partial directive is retained internally
     * until the next feed() or flush().
     */
    feed(text) {
      const out = [];
      let plain = ''; // accumulate literal chars, flush as one text event

      const flushPlain = () => {
        if (plain) { out.push({ t: 'text', value: plain }); plain = ''; }
      };

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (!this.inToken) {
          if (ch === '{') {
            // Could be the start of `{{`. Peek ahead within this chunk; if the
            // next char isn't available yet, stash a pending single brace.
            if (this._pendingBrace) {
              // We had a lone `{` from before and now another `{` -> token.
              this._pendingBrace = false;
              this.inToken = true;
              this.buf = '{{';
            } else {
              this._pendingBrace = true;
            }
          } else {
            if (this._pendingBrace) {
              // The earlier `{` was not part of `{{` — it's literal.
              plain += '{';
              this._pendingBrace = false;
            }
            plain += ch;
          }
          continue;
        }

        // We're inside a candidate directive.
        this.buf += ch;
        if (this.buf.endsWith('}}')) {
          // Directive closed. Resolve it.
          flushPlain();
          const ev = this._resolve(this.buf);
          if (ev) out.push(ev);
          else out.push({ t: 'text', value: this.buf }); // not a real directive
          this.buf = '';
          this.inToken = false;
        } else if (!plausibleDirective(this.buf)) {
          // It has stopped looking like a directive and no later character can
          // change that — flush what we buffered as literal.
          flushPlain();
          out.push({ t: 'text', value: this.buf });
          this.buf = '';
          this.inToken = false;
        }
      }

      flushPlain();
      return out;
    }

    /**
     * Call when the stream is complete. Emits any buffered partial as literal
     * text so nothing is silently dropped.
     */
    flush() {
      const out = [];
      if (this._pendingBrace) { out.push({ t: 'text', value: '{' }); this._pendingBrace = false; }
      if (this.inToken && this.buf) { out.push({ t: 'text', value: this.buf }); }
      this.buf = '';
      this.inToken = false;
      return out;
    }

    // Turn a fully-buffered `{{...}}` string into an event, or null if it isn't
    // a recognized directive.
    _resolve(tok) {
      const inner = tok.slice(2, -2).trim(); // strip {{ }}
      if (inner.startsWith('/')) {
        const rest = inner.slice(1).trim();
        if (!rest.startsWith('fx:')) return null;
        const name = rest.slice(3).trim().toLowerCase();
        if (!STYLE_SPANS.has(name)) return null;
        return { t: 'style-end', name };
      }
      if (!inner.startsWith('fx:')) return null;
      const body = inner.slice(3).trim();
      const sp = body.indexOf(' ');
      const name = (sp === -1 ? body : body.slice(0, sp)).toLowerCase();
      const args = sp === -1 ? '' : body.slice(sp + 1).trim();
      if (!ALL_NAMES.has(name)) return null;
      if (POINT_EFFECTS.has(name)) return { t: 'effect', name, args };
      return { t: 'style-start', name, args };
    }
  }

  // ---------- apophenia anchor geometry ----------
  //
  // apophenia is the only effect that hangs itself off real words instead of
  // inventing its own points, so it's the only one that can be handed a point
  // set that doesn't work. Both rules live here — pure, no DOM — because the
  // version that shipped was broken in a way no DOM-free test could see and no
  // screenshot caught either.

  // Words on one line of text share a baseline: spread in x, zero spread in y.
  // A web drawn between points that share a baseline is a horizontal rule
  // through the prose. It doesn't read as a faint constellation, it reads as a
  // strikethrough — see assets/fx/probe/apophenia-real-path.png.
  const ANCHOR_MIN_SPREAD = 24;   // px, required on BOTH axes

  function anchorsFlat(pts) {
    if (!pts || pts.length < 3) return true;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return (Math.max(...xs) - Math.min(...xs)) < ANCHOR_MIN_SPREAD
        || (Math.max(...ys) - Math.min(...ys)) < ANCHOR_MIN_SPREAD;
  }

  // Choose `max` anchors spread over as many lines of text as possible.
  //
  // The obvious sampling — walk back from the caret, take the first `max` words
  // — is what shipped. Fourteen consecutive words is almost exactly one line of
  // text, so it returned a collinear set every single time, by construction
  // rather than by luck. Round-robin one word per line per pass instead:
  // vertical spread is the thing this effect cannot do without.
  //
  // `rnd` is injectable so a test can pin the choice.
  //
  // ⚠ `max` SMALLER than the number of lines is a top-of-screen bias, not a
  // spread. Pass 0 walks the buckets in y order and returns the instant it has
  // `max`, so it hands back the FIRST `max` lines and never looks lower. That
  // was invisible while apophenia (max=14) was the only caller — fourteen lines
  // is most of a screen — and it was the whole of lightning's "doesn't reach
  // the bottom": max=4 meant the top four lines, forever, whatever was below.
  // A caller that wants the whole screen must ask for lineCount(cand).
  // Which visual line a word's centre sits on. One definition, because
  // stratifyAnchors buckets by it and lineCount counts those buckets — two
  // independent "same line, give or take" rounds would drift and lineCount
  // would ask for a number of lines that doesn't exist.
  const lineKey = (y) => Math.round(y / 6);

  // How many distinct lines these candidates cover. `stratifyAnchors(cand,
  // lineCount(cand))` is exactly one anchor per line, top to bottom: pass 0
  // takes one from every bucket and fills `max` precisely as it runs out.
  function lineCount(cand) {
    const rows = new Set();
    for (const c of cand || []) rows.add(lineKey(c.y));
    return rows.size;
  }

  function stratifyAnchors(cand, max, rnd) {
    const random = rnd || Math.random;
    const rows = new Map();
    for (const c of cand) {
      const key = lineKey(c.y);
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key).push(c);
    }
    const buckets = [...rows.keys()].sort((a, b) => a - b).map((k) => rows.get(k));
    // Shuffle within each line so a re-fire doesn't pick the same words twice.
    for (const b of buckets) {
      for (let i = b.length - 1; i > 0; i--) {
        const j = (random() * (i + 1)) | 0;
        const t = b[i]; b[i] = b[j]; b[j] = t;
      }
    }
    const out = [];
    for (let pass = 0; out.length < max; pass++) {
      let took = 0;
      for (const b of buckets) {
        if (b.length <= pass) continue;
        out.push(b[pass]); took++;
        if (out.length >= max) break;
      }
      if (!took) break;   // every line exhausted
    }
    return out;
  }

  // Which anchors get linked to which.
  //
  // anchorsFlat() is a whole-set check and it is not sufficient on its own: a
  // set can span six lines, pass it, and still pair two words that sit on one
  // line as each other — that pair alone draws a rule through that line.
  //
  // But "not the same baseline" isn't the rule either. Two words on ADJACENT
  // lines a thousand pixels apart make a segment at about five degrees, and it
  // grazes along the prose for its whole length. It reads as an underline just
  // as much as a flat one does. The defect was never the baseline, it's the
  // ANGLE: a shallow segment travels along the text instead of across the page.
  // One rule covers both, since a same-line pair has slope zero.
  //
  // Text is wide and short — a line of prose is ~1000px of run and ~22px of
  // rise — so this is not a symmetric threshold and shouldn't be. It has to
  // exclude the whole family of near-horizontal links the layout makes easy.
  const MIN_SLOPE = 0.18;   // rise per unit run, ≈10° off horizontal

  function pairShallow(a, b) {
    return Math.abs(a.y - b.y) < MIN_SLOPE * Math.abs(a.x - b.x);
  }

  function planApopheniaPairs(pts, rnd) {
    const random = rnd || Math.random;
    const want = Math.min(9, Math.max(3, Math.round(pts.length * 0.8)));
    const seen = new Set();
    const pairs = [];
    // Distance is deliberately ignored — apophenia links things that have
    // nothing to do with each other, and a long line is the effect working.
    // Only the angle disqualifies a pair.
    for (let k = 0; k < want * 12 && pairs.length < want; k++) {
      const i = (random() * pts.length) | 0;
      const j = (random() * pts.length) | 0;
      if (i === j) continue;
      if (pairShallow(pts[i], pts[j])) continue;
      const key = Math.min(i, j) + ':' + Math.max(i, j);
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ i, j, at: pairs.length * 210 });
    }
    return pairs;
  }

  // ---------- lightning geometry ----------
  //
  // Pure, and here rather than in effects.js for exactly the reason apophenia's
  // anchor rules are: that effect shipped drawing the wrong shape entirely, no
  // DOM-free test could see it, and the screenshot that passed review was of
  // its fallback. Geometry that can be checked by `node --test` is geometry
  // that can be wrong out loud. `rnd` is injectable throughout so a test can
  // pin the shape.

  // Each subdivision displaces by this fraction of the last one. Below ~0.5 the
  // detail dies out before it's visible and the path straightens back into the
  // stick this replaced; above it, the fine detail is as violent as the coarse
  // and the channel reads as scribble. Self-similarity is the whole trick, and
  // it lives in this one number.
  const BOLT_FALLOFF = 0.52;

  /**
   * A lightning channel from (ax,ay) to (bx,by) by midpoint displacement:
   * subdivide each segment, push the new midpoint along its perpendicular,
   * halve the push, recurse. Returns a polyline.
   *
   * The endpoints are never displaced — only midpoints move — so the bolt
   * always starts where it was aimed and lands exactly on its target. That
   * matters: the target is a word, and a strike that misses the word it set on
   * fire is worse than no strike.
   */
  function boltPath(ax, ay, bx, by, rough, detail, rnd) {
    const random = rnd || Math.random;
    let pts = [{ x: ax, y: ay }, { x: bx, y: by }];
    let off = Math.hypot(bx - ax, by - ay) * (rough == null ? 0.3 : rough);
    for (let d = 0; d < (detail | 0); d++) {
      const next = [pts[0]];
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1], q = pts[i];
        const dx = q.x - p.x, dy = q.y - p.y;
        const len = Math.hypot(dx, dy) || 1;
        const k = (random() * 2 - 1) * off;
        // (-dy, dx)/len is the unit perpendicular; the midpoint rides it.
        next.push({ x: (p.x + q.x) / 2 - (dy / len) * k, y: (p.y + q.y) / 2 + (dx / len) * k });
        next.push(q);
      }
      pts = next;
      off *= BOLT_FALLOFF;
    }
    return pts;
  }

  /** Arc-length table for a polyline, so growth can advance by distance. */
  function measurePath(pts) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    }
    return { pts, cum, total: cum[cum.length - 1] || 1 };
  }

  /**
   * Forks off a measured trunk. Each leaves a real point on the trunk and
   * inherits the trunk's heading there, turned by a third to a full radian —
   * so a fork is a smaller bolt continuing the channel's argument, rather than
   * the random walk stapled on at a random index that the old one used.
   *
   * `at` is where along the trunk it leaves, as a fraction, so it can be held
   * dark until the tip has actually got there.
   */
  function forkPaths(main, n, scale, rnd) {
    const random = rnd || Math.random;
    const out = [];
    if (!main || main.pts.length < 6) return out;
    for (let f = 0; f < n; f++) {
      const i = 2 + ((random() * (main.pts.length - 4)) | 0);
      const p = main.pts[i], prev = main.pts[i - 1];
      const heading = Math.atan2(p.y - prev.y, p.x - prev.x);
      const a = heading + (0.35 + random() * 0.5) * (random() < 0.5 ? 1 : -1);
      const len = (34 + random() * 70) * (scale || 1);
      const path = measurePath(
        boltPath(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len, 0.24, 3, rnd)
      );
      path.at = main.cum[i] / main.total;
      path.w = 0.4 + random() * 0.3;
      out.push(path);
    }
    return out;
  }

  /**
   * The stepped leader's advance: a staircase of {t, len}, both normalised to
   * 0..1 and both monotonic.
   *
   * A real leader jumps, holds dark, jumps again — it does not ease. Growth on
   * a ramp reads as a wipe pulling a picture across the screen, which is the
   * opposite of the thing. Both axes are uneven on purpose: even jumps at even
   * intervals read as a progress bar, which is worse than a wipe.
   *
   * The last step lands at exactly t=1, so the channel completes on the same
   * frame the return stroke fires rather than a beat before it.
   */
  function leaderStair(steps, rnd) {
    const random = rnd || Math.random;
    const n = Math.max(2, steps | 0);
    const out = [];
    let len = 0, t = 0;
    for (let i = 0; i < n; i++) {
      len += 0.35 + random();
      t += 0.35 + random();
      out.push({ t, len });
    }
    const T = out[n - 1].t, L = out[n - 1].len;
    return out.map((s) => ({ t: s.t / T, len: s.len / L }));
  }

  /** How much of the channel is lit at normalised time `t`. A step function. */
  function revealAt(stair, t) {
    if (t >= 1) return 1;
    if (t <= 0 || !stair || !stair.length) return 0;
    let r = 0;
    for (const s of stair) { if (s.t > t) break; r = s.len; }
    return r;
  }

  // ---- ASCII scenes -------------------------------------------------------
  //
  // The cyberpunk register taken literally: text pretending to be a machine
  // talking to itself. Ten scenes, planned here and merely *drawn* in
  // effects.js.
  //
  // That split is the only reason they can be verified at all. `npm test`
  // covers pure modules, and this repo's whole history is effects whose
  // evidence was a screenshot that turned out to be photographing a fallback.
  // A scene whose content is generated inside a canvas draw call can only be
  // checked by looking at it. A scene whose content is a pure function of a
  // seed can be counted. So everything with a fact in it — the hexdump's
  // bytes, the traceroute's latencies, the stack's addresses — is decided
  // here, where a test can call it with a fixed rng and assert on the output.
  //
  // Each planner takes an optional `rnd` and returns plain data. None of them
  // touch a canvas, a DOM node, or a clock.

  // 5x7 block font, '#' is ink. Only what a banner needs; an unknown character
  // resolves to a blank cell rather than throwing, so a stray glyph costs a
  // space instead of the scene.
  const BANNER_5x7 = {
    ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
    A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
    C: ['.####', '#....', '#....', '#....', '#....', '#....', '.####'],
    D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
    E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
    F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
    G: ['.####', '#....', '#....', '#.###', '#...#', '#...#', '.###.'],
    H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
    I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
    J: ['####.', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
    K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
    L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
    M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
    N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
    O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
    Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
    R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
    S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
    T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
    U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
    V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
    W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
    X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
    Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
    Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
    0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
    1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
    2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
    3: ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
    4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
    5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
    6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
    7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
    8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
    9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
    '!': ['..#..', '..#..', '..#..', '..#..', '..#..', '.....', '..#..'],
    '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
    '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
    '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  };

  const BANNER_H = 7;

  // Phrases a banner can spell. All from the movie, because the effect only
  // means anything if the words do.
  const BANNER_WORDS = [
    'HACK THE PLANET', 'ZERO COOL', 'CRASH OVERRIDE', 'ACID BURN',
    'THE GIBSON', 'MESS WITH THE BEST', 'DIE LIKE THE REST',
  ];

  /**
   * Rasterise `text` into BANNER_H rows of '#'/'.'.
   *
   * Every row comes back the same length — a banner is a rectangle, and a
   * ragged one shears its own columns. Unknown characters render as blank
   * cells, so a phrase with a stray glyph loses the glyph, not the banner.
   */
  function bannerRows(text, font) {
    const F = font || BANNER_5x7;
    const chars = String(text).toUpperCase().split('');
    const rows = [];
    for (let r = 0; r < BANNER_H; r++) {
      let line = '';
      for (const ch of chars) {
        const g = F[ch] || F[' '];
        line += g[r] + '.';
      }
      rows.push(line);
    }
    return rows;
  }

  // The skull. Rezzes in as-is; nothing generates it, so it's data.
  const SKULL = [
    '     .-"      "-.     ',
    '    /            \\    ',
    '   |              |   ',
    '   |,  .-.  .-.  ,|   ',
    '   | )(_o/  \\o_)( |   ',
    '   |/     /\\     \\|   ',
    '   (_     ^^     _)   ',
    '    \\__|IIIIII|__/    ',
    '     | \\IIIIII/ |     ',
    '     \\          /     ',
    "      `--------`      ",
  ];

  /**
   * Wardial: a column of numbers, nearly all of which fail.
   *
   * The carrier is ALWAYS the last two lines and is never one of the random
   * ones. That's the scene's only real invariant — a wardial that dials
   * forever and connects to nothing is just a number generator — so it's
   * asserted rather than left to the rng.
   */
  function planWardial(rnd) {
    const random = rnd || Math.random;
    const area = ['212', '415', '312', '718', '206', '303'][(random() * 6) | 0];
    const lines = [];
    const n = 14 + ((random() * 8) | 0);
    for (let i = 0; i < n; i++) {
      const num = area + '-555-' + String(1000 + ((random() * 8999) | 0));
      const r = random();
      const verdict = r < 0.10 ? 'RINGING...' : r < 0.20 ? 'BUSY' : r < 0.26 ? 'VOICE' : 'NO CARRIER';
      lines.push({ text: 'DIAL ' + num + '   ' + verdict, hit: false });
    }
    // 2600 Hz is the whistle that opened a trunk line, and 2600 is the
    // magazine named after it. It is the only number here that answers.
    lines.push({ text: 'DIAL ' + area + '-555-2600   ** CARRIER DETECTED **', hit: true });
    lines.push({ text: 'CONNECT 28800/ARQ/V34/LAPM/V42BIS', hit: true });
    return lines;
  }

  const SNIFFER_PAYLOADS = [
    'GET /garbage.dat HTTP/1.0\r\nHost: gibson.ellingson.com\r\nAuthorization: Basic emVyb2Nvb2w6bG92ZQ==\r\n\r\n',
    'USER zerocool\r\nPASS god\r\nSITE EXEC /bin/sh -c "cat /etc/shadow"\r\n226 Transfer complete.\r\n',
    'RCPT TO: <plague@ellingson.com>\r\nDATA\r\nSubject: the garbage file\r\nthey are onto the worm.\r\n.\r\n',
  ];

  /**
   * Sniffer: a hexdump pane.
   *
   * The hex column and the ASCII gutter are generated from the same bytes, so
   * they cannot disagree — which is exactly what makes this testable: decode
   * the hex back and it must reproduce the gutter, and the gutter's printable
   * characters must reproduce the payload.
   */
  function planSniffer(payload, rnd) {
    const random = rnd || Math.random;
    const src = payload || SNIFFER_PAYLOADS[(random() * SNIFFER_PAYLOADS.length) | 0];
    const bytes = [];
    for (let i = 0; i < src.length; i++) bytes.push(src.charCodeAt(i) & 0xff);

    // Where the interesting bytes are, matched against the WHOLE payload and
    // then intersected with each 16-byte row.
    //
    // The obvious version tests each row's own gutter, and it is wrong in a way
    // that paints perfectly: a 16-byte window splits `Authorization` about as
    // often as not, so the substring is present in the dump and in no single
    // row. Two of the three payloads here flagged nothing at all, and the scene
    // still drew — just with the credential in the same colour as the rest.
    const marks = [];
    const re = /(PASS\s+\S+|Authorization:\s*\S+|\/etc\/shadow|garbage\.dat|worm)/gi;
    for (let m = re.exec(src); m; m = re.exec(src)) marks.push([m.index, m.index + m[0].length]);

    const lines = [];
    for (let off = 0; off < bytes.length; off += 16) {
      const chunk = bytes.slice(off, off + 16);
      const hex = [];
      for (let i = 0; i < 16; i++) {
        hex.push(i < chunk.length ? ('0' + chunk[i].toString(16)).slice(-2) : '  ');
      }
      const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      const offs = ('000' + off.toString(16)).slice(-4);
      lines.push({
        text: offs + '  ' + hex.slice(0, 8).join(' ') + '  ' + hex.slice(8).join(' ')
          + '  |' + (ascii + '                ').slice(0, 16) + '|',
        // Flagged if this row overlaps a mark at all — a credential split
        // across two rows lights both, which is what it looks like on the wire.
        hit: marks.some(([a, b]) => a < off + 16 && b > off),
      });
    }
    return lines;
  }

  const TRACE_HOPS = [
    'gateway', 'core1.isp.net', 'ae-3.border-rtr', 'xe-0-0-1.nyc09',
    'level3.transit', 'ellingson-edge', 'fw-01.ellingson', 'gibson.ellingson.com',
  ];

  /**
   * Traceroute: hops out to the Gibson, with a latency bar.
   *
   * Latency is cumulative and therefore monotonic — each hop is strictly
   * further than the last. A trace whose times wander is a trace that isn't
   * modelling distance, and the bars stop meaning anything.
   */
  function planTrace(rnd) {
    const random = rnd || Math.random;
    const lines = [];
    let ms = 0.4 + random() * 2;
    for (let i = 0; i < TRACE_HOPS.length; i++) {
      ms += 2 + random() * 18;
      const bar = '#'.repeat(Math.max(1, Math.min(14, Math.round(ms / 6))));
      lines.push({
        text: String(i + 1).padStart(2) + '  ' + TRACE_HOPS[i].padEnd(22)
          + ms.toFixed(1).padStart(6) + ' ms  ' + bar,
        ms,
        hit: i === TRACE_HOPS.length - 1,
      });
    }
    lines.push({ text: '    ** TRACE COMPLETE - ' + TRACE_HOPS.length + ' HOPS TO THE GIBSON **', ms, hit: true });
    return lines;
  }

  /**
   * Daemon: a process tree that grows a branch at a time.
   *
   * Depth decides the prefix, and the last child of any parent gets the elbow
   * rather than the tee — get that wrong and the tree grows a rail to nowhere.
   */
  function planDaemon(rnd) {
    const random = rnd || Math.random;
    const pid = () => 100 + ((random() * 9000) | 0);
    const spec = [
      ['init', []],
      ['inetd', ['telnetd', 'fingerd']],
      ['sshd', ['bash', 'scp']],
      ['httpd', ['worker', 'worker', 'cgi-bin/phf']],
      ['garbaged', ['worm', 'worm', 'worm']],
    ];
    const lines = [];
    lines.push({ text: 'init(1)', depth: 0, hit: false });
    for (let i = 1; i < spec.length; i++) {
      const [name, kids] = spec[i];
      const last = i === spec.length - 1;
      lines.push({ text: (last ? ' `- ' : ' |- ') + name + '(' + pid() + ')', depth: 1, hit: false });
      for (let k = 0; k < kids.length; k++) {
        const kl = k === kids.length - 1;
        lines.push({
          text: (last ? '    ' : ' |  ') + (kl ? ' `- ' : ' |- ') + kids[k] + '(' + pid() + ')',
          depth: 2,
          hit: kids[k] === 'worm',
        });
      }
    }
    return lines;
  }

  const PORT_SVC = {
    21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 79: 'finger',
    80: 'http', 110: 'pop3', 111: 'rpcbind', 135: 'msrpc', 139: 'netbios',
    143: 'imap', 443: 'https', 445: 'microsoft-ds', 512: 'exec', 513: 'login',
    514: 'shell', 993: 'imaps', 995: 'pop3s', 1080: 'socks', 1433: 'ms-sql',
    1521: 'oracle', 2600: 'phreak', 3306: 'mysql', 3389: 'ms-wbt', 5432: 'postgres',
    5900: 'vnc', 6000: 'x11', 6667: 'irc', 8080: 'http-alt', 8443: 'https-alt',
    31337: 'elite',
  };

  /**
   * Portscan: a grid of ports, a few of them open.
   *
   * 2600 and 31337 are open unconditionally. Left to the rng they'd be open
   * about a fifth of the time, and the two ports that are the entire joke
   * would be dark in most runs.
   */
  function planPortscan(rnd) {
    const random = rnd || Math.random;
    const ports = Object.keys(PORT_SVC).map(Number).sort((a, b) => a - b);
    return ports.map((port) => {
      if (port === 2600 || port === 31337) return { port, state: 'open', svc: PORT_SVC[port] };
      const r = random();
      const state = r < 0.16 ? 'open' : r < 0.26 ? 'filtered' : 'closed';
      return { port, state, svc: PORT_SVC[port] };
    });
  }

  /**
   * Overflow: a stack frame, and then the smash.
   *
   * `rows` is the frame drawn top-down (high addresses first, the way every
   * stack diagram is drawn). `flood` is how many rows of 0x41414141 the
   * payload writes — always enough to reach the saved return address, because
   * an overflow that stops inside the buffer is a bounds check working.
   */
  function planOverflow(rnd) {
    const random = rnd || Math.random;
    const base = 0xbffff000 + (((random() * 0x800) | 0) & ~3);
    const hex = (n) => '0x' + ('0000000' + (n >>> 0).toString(16)).slice(-8);
    const rows = [
      { label: 'ret  ', addr: base + 0x1c, val: hex(0x08048400 + ((random() * 0x200) | 0)), kind: 'ret' },
      { label: 'ebp  ', addr: base + 0x18, val: hex(base + 0x40), kind: 'ebp' },
      { label: 'buf12', addr: base + 0x14, val: hex(0), kind: 'buf' },
      { label: 'buf8 ', addr: base + 0x10, val: hex(0), kind: 'buf' },
      { label: 'buf4 ', addr: base + 0x0c, val: hex(0), kind: 'buf' },
      { label: 'buf0 ', addr: base + 0x08, val: hex(0), kind: 'buf' },
    ];
    // Filled bottom-up: buf0 first, ret last. Reaching `rows.length` means the
    // return address is ours.
    return { rows, flood: rows.length, smashed: '0x41414141' };
  }

  // The movie's four, verbatim: "the four most common passwords: love, secret,
  // sex and god." The handles are the same joke one film later.
  const CRACK_WORDS = ['LOVE', 'SECRET', 'SEX', 'GOD', 'ZEROCOOL', 'ACIDBURN', 'CRASHOVERRIDE'];
  const CRACK_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';

  /**
   * Crack: a field of characters that lock left to right.
   *
   * Each cell gets its own lock time, strictly increasing, so the reveal
   * always sweeps one way. Cells are returned with the real character already
   * in them — the spinning is a draw-time concern, not a data one.
   */
  function planCrack(word, rnd) {
    const random = rnd || Math.random;
    const target = (word || CRACK_WORDS[(random() * CRACK_WORDS.length) | 0]).toUpperCase();
    const cells = [];
    let t = 220;
    for (let i = 0; i < target.length; i++) {
      t += 90 + random() * 190;
      cells.push({ ch: target[i], lockAt: t });
    }
    return { target, cells, doneAt: t + 260 };
  }

  /**
   * Gibson: towers on a ground plane, pulled toward the viewer.
   *
   * Pure placement only. The projection is a 1/z divide and lives in the draw
   * pass, because it needs the canvas size; what's decided here is where the
   * city is and how tall it is, which is what a test can check.
   */
  function planGibson(rnd) {
    const random = rnd || Math.random;
    const towers = [];
    const n = 30 + ((random() * 14) | 0);
    for (let i = 0; i < n; i++) {
      towers.push({
        gx: (random() * 18) - 9,          // ground units either side of centre
        z: 1.4 + random() * 26,           // depth; the viewer is at 0
        rows: 3 + ((random() * 10) | 0),  // storeys
        cols: 2 + ((random() * 3) | 0),
        lit: random() < 0.4,
      });
    }
    return towers;
  }

  // ---- the grid register: planners ----
  //
  // Same contract as the ASCII scenes: every fact a grid effect paints is
  // decided here, pure and seeded, so `node --test` can pin it without a
  // canvas. effects.js keeps only geometry and paint.

  // The skull's mandible starts at this row of SKULL — everything from the
  // lower teeth down is jaw, and the jaw is what moves.
  const SKULL_JAW_ROW = 8;

  // The chomp choreography: when the jaw opens, how long it gapes, how fast
  // it snaps shut. Times are ms into the scene; the cycles must not overlap.
  // The rez takes ~1.1s (see planSkull), so the first chomp waits for a whole
  // skull to chomp with.
  const SKULL_CHOMPS = [
    { at: 1300, open: 320, hold: 260, snap: 90 },
    { at: 2150, open: 260, hold: 210, snap: 80 },
    { at: 2850, open: 300, hold: 230, snap: 90 },
  ];
  const JAW_DROP = 1.6;   // rows of gape at full stretch

  /**
   * Where the jaw is, in rows below rest, `ms` into the scene.
   * Ease out on the open (muscle), linear on the snap (gravity) — the snap
   * being fast is what makes it a chomp rather than a yawn.
   */
  function jawDropAt(ms, chomps) {
    for (const ch of (chomps || SKULL_CHOMPS)) {
      const t = ms - ch.at;
      if (t < 0) continue;
      if (t < ch.open) { const k = t / ch.open; return JAW_DROP * (1 - (1 - k) * (1 - k)); }
      if (t < ch.open + ch.hold) return JAW_DROP;
      if (t < ch.open + ch.hold + ch.snap) {
        return JAW_DROP * (1 - (t - ch.open - ch.hold) / ch.snap);
      }
    }
    return 0;
  }

  /**
   * The skull as cells: each with its glyph, its grid offset, whether it
   * belongs to the jaw, and its own rez schedule. `at` is when the cell
   * starts scrambling — showing whatever REAL character sits under it, or a
   * spinning glyph over bare ground — and `lockAt` is when it settles into
   * the art. The scatter is the point: an image that assembles in reading
   * order reads as text.
   */
  function planSkull(rnd) {
    const r = rnd || Math.random;
    const cells = [];
    for (let row = 0; row < SKULL.length; row++) {
      for (let col = 0; col < SKULL[row].length; col++) {
        const ch = SKULL[row][col];
        if (ch === ' ') continue;
        const at = r() * 900;
        cells.push({
          ch, r: row, c: col,
          jaw: row >= SKULL_JAW_ROW,
          eye: ch === 'o',
          at, lockAt: at + 180 + r() * 240,
        });
      }
    }
    return {
      cells, w: SKULL[0].length, h: SKULL.length,
      jawTop: SKULL_JAW_ROW, chomps: SKULL_CHOMPS, drop: JAW_DROP,
    };
  }

  // Wireframe solids. Verts on the unit ball, edges as index pairs — the
  // engine rotates, projects and rasterises per frame, but WHAT spins is
  // decided here.
  const WIREFRAME_SHAPES = ['sphere', 'prism', 'cube'];

  function planWireframe(shape, rnd) {
    const r = rnd || Math.random;
    const kind = WIREFRAME_SHAPES.indexOf(shape) !== -1
      ? shape
      : WIREFRAME_SHAPES[(r() * WIREFRAME_SHAPES.length) | 0];
    const verts = [], edges = [];
    const ring = (n, at) => {
      const base = verts.length;
      for (let i = 0; i < n; i++) {
        verts.push(at(i / n * Math.PI * 2));
        edges.push([base + i, base + (i + 1) % n]);
      }
      return base;
    };
    if (kind === 'sphere') {
      // Latitude rings + three great circles through the poles. A sphere has
      // no edges of its own, so the wireframe IS the sphere — too few rings
      // and it's an atom diagram, too many and it's a fillrate bill.
      for (const phi of [-54, -18, 18, 54]) {
        const p = phi * Math.PI / 180, y = Math.sin(p), rad = Math.cos(p);
        ring(14, (a) => [Math.cos(a) * rad, y, Math.sin(a) * rad]);
      }
      for (const th of [0, 60, 120]) {
        const t0 = th * Math.PI / 180;
        ring(18, (a) => [Math.cos(a) * Math.cos(t0), Math.sin(a), Math.cos(a) * Math.sin(t0)]);
      }
    } else if (kind === 'prism') {
      // A long triangular prism — the laser-show one. Length along z so the
      // tumble shows it end-on and side-on in one life.
      const L = 1.05, R2 = 0.62;
      for (const z of [-L, L]) {
        for (let i = 0; i < 3; i++) {
          const a = i / 3 * Math.PI * 2 + Math.PI / 6;
          verts.push([Math.cos(a) * R2, Math.sin(a) * R2, z]);
        }
      }
      for (const b of [0, 3]) for (let i = 0; i < 3; i++) edges.push([b + i, b + (i + 1) % 3]);
      for (let i = 0; i < 3; i++) edges.push([i, i + 3]);
    } else {
      const s = 0.68;
      for (const x of [-s, s]) for (const y of [-s, s]) for (const z of [-s, s]) verts.push([x, y, z]);
      // Pairs differing in exactly one axis — a cube's 12 edges.
      for (let i = 0; i < 8; i++) {
        for (const j of [i ^ 1, i ^ 2, i ^ 4]) if (j > i) edges.push([i, j]);
      }
    }
    return {
      kind, verts, edges,
      // Two independent tumble rates (rad/ms), one of them signed, so no two
      // castings spin alike and the rotation never degenerates into a flat
      // spin about one axis.
      rateA: (0.9 + r() * 0.5) * 0.0016 * (r() < 0.5 ? -1 : 1),
      rateB: (0.6 + r() * 0.5) * 0.0011,
      tilt: r() * Math.PI * 2,
    };
  }

  /**
   * Which glyph a stroke through a cell should be, from the stroke's on-screen
   * direction in PIXELS (y down). Fold the angle into four octant pairs:
   * horizontal, down-right, vertical, up-right.
   */
  function slopeGlyph(dx, dy) {
    if (!dx && !dy) return '·';
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) & 3;
    return ['-', '\\', '|', '/'][oct];
  }

  /**
   * The cells a segment crosses, endpoints in fractional cell coords.
   * Stepped on the longer axis so a line can't gap however the aspect ratio
   * of the cells distorts it.
   */
  function rasterCells(c0, r0, c1, r1) {
    const n = Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0));
    if (n < 1) return [{ c: Math.round(c0), r: Math.round(r0) }];
    const out = [];
    for (let i = 0; i <= n; i++) {
      const c = Math.round(c0 + (c1 - c0) * i / n), r = Math.round(r0 + (r1 - r0) * i / n);
      if (!out.length || out[out.length - 1].c !== c || out[out.length - 1].r !== r) out.push({ c, r });
    }
    return out;
  }

  // Plasma: three drifting sine fields summed and normalised to -1..1. The
  // coefficients are the plan; the field is pure so a test can pin its range.
  function planPlasma(rnd) {
    const r = rnd || Math.random;
    return {
      f1: 0.006 + r() * 0.004, f2: 0.008 + r() * 0.005, f3: 0.004 + r() * 0.003,
      p1: r() * Math.PI * 2, p2: r() * Math.PI * 2, p3: r() * Math.PI * 2,
      speed: 0.0012 + r() * 0.0008,
      hue0: r() * 360,
    };
  }

  function plasmaField(x, y, t, P) {
    return (Math.sin(x * P.f1 + t + P.p1)
      + Math.sin(y * P.f2 - t * 1.3 + P.p2)
      + Math.sin((x + y) * P.f3 + t * 0.7 + P.p3)) / 3;
  }

  function planTunnel(rnd) {
    const r = rnd || Math.random;
    return {
      spacing: 46 + r() * 18,        // px between rings
      speed: 0.055 + r() * 0.04,     // px/ms outward
      hue0: r() * 360,
      hueRate: 0.055,                // deg/ms of drift
    };
  }

  // Firewall: the doom-fire cellular automaton. `heat` is row-major,
  // rows*cols, row 0 at the TOP of the fire; the bottom row is the source and
  // is re-flickered every step. Each cell pulls from roughly below itself,
  // cooled a little — heat can only climb by having been hotter underneath,
  // which is the whole physics of the thing.
  const FIREWALL_MAX_HEAT = 36;
  const FIREWALL_RAMP = ' .:;+*x%#@';

  function stepFirewall(heat, cols, rows, rnd) {
    const r = rnd || Math.random;
    for (let c = 0; c < cols; c++) {
      heat[(rows - 1) * cols + c] = FIREWALL_MAX_HEAT - ((r() * 6) | 0);
    }
    for (let row = 0; row < rows - 1; row++) {
      for (let c = 0; c < cols; c++) {
        const drift = ((r() * 3) | 0) - 1;
        const sc = Math.min(cols - 1, Math.max(0, c + drift));
        const cool = 2 + ((r() * 3.2) | 0);
        heat[row * cols + c] = Math.max(0, heat[(row + 1) * cols + sc] - cool);
      }
    }
    return heat;
  }

  function planFirewall(rnd) {
    const r = rnd || Math.random;
    return { rows: 10 + ((r() * 4) | 0), stepMs: 40 };
  }

  // The cat. Two rows of glyphs, facing right, tail trailing. Frames are
  // data; mirroring is arithmetic; everything about WHERE it walks comes from
  // the renderer's measured line platforms at runtime.
  const CAT_W = 8;
  const CAT_FRAMES = {
    walkA: ['  /\\_/\\ ', '~(=o.o=)'],
    walkB: ['  /\\_/\\ ', '-(=o.o=)'],
    sit:   ['  /\\_/\\ ', '~(=^.^=)'],
    blink: ['  /\\_/\\ ', '~(=-.-=)'],
    fall:  ['  /\\_/\\ ', ' (=O.O=)'],
    land:  ['        ', '~(=>.<=)'],
  };
  const CAT_MIRROR = { '(': ')', ')': '(', '/': '\\', '\\': '/', '<': '>', '>': '<' };

  function mirrorCatFrame(rows) {
    return rows.map((row) => row.split('').reverse()
      .map((ch) => CAT_MIRROR[ch] || ch).join(''));
  }

  function planCat(rnd) {
    const r = rnd || Math.random;
    return {
      speed: 0.055 + r() * 0.025,    // px/ms of walk
      stepMs: 150,                   // gait frame flip
      life: 8000 + r() * 3000,
      dir: r() < 0.5 ? -1 : 1,
      // Measured, not vibes: at 0.0004/ms the first cut sat every ~2.5s and
      // spent half its life parked — a rug, not a cat. One sit per ~5-6s of
      // walking reads as a cat with somewhere to be.
      sitP: 0.00018,
      turnP: 0.25,                   // chance a sit ends in walking back the other way
      blinkEvery: 2200 + r() * 1400,
    };
  }

  // ---- the grid register, volume II: ten more, and cheekier ----
  //
  // Same contract as everything above it: each fact is a pure seeded plan, so
  // node --test pins it; the geometry and the incorporation happen in
  // effects.js against a grid it can't see. Every one of these is built to be
  // recognisable at a glance and to do something to the prose it lands on.

  // snake — the Nokia snake, slithering the grid and eating the prose one
  // character at a time. Speed and appetite are the plan; the PATH is emergent
  // (it seeks the nearest uneaten character at runtime), because a seeded path
  // over text nobody has typed yet is meaningless.
  function planSnake(rnd) {
    const r = rnd || Math.random;
    return { stepMs: 60 + r() * 26, grow: 2, len0: 5, maxEat: 55, hue: 96 + r() * 46 };
  }

  // invaders — a formation steps side to side and creeps down, drops the odd
  // bomb on your prose, and gets shot out of the sky by a cannon that sweeps
  // the bottom. Cadences and formation size are seeded; the targets are words.
  const INVADER = { a: ['/oo\\', '<--<'], b: ['/oo\\', '>-->'] };
  const CANNON = ['/^\\', '###'];
  function planInvaders(rnd) {
    const r = rnd || Math.random;
    return {
      cols: 6 + ((r() * 3) | 0), rows: 3 + ((r() * 2) | 0),
      stepMs: 300 + r() * 150, dropEvery: 6, bombP: 0.9, shotMs: 460 + r() * 220,
    };
  }

  // pacman — waka-waka along a line, the characters ahead are pellets and go
  // dark as they're eaten, a ghost gives chase. Cheeky and iconic.
  function planPacman(rnd) {
    const r = rnd || Math.random;
    return { speed: 0.10 + r() * 0.05, chompMs: 140, ghostGap: 6, ghostHue: (r() * 360) | 0 };
  }

  // ufo — a saucer drifts in, parks over a word, and tractor-beams it clean off
  // the line. The word floats back down when the saucer leaves; no abduction
  // here is permanent.
  const SAUCER = [' .==. ', '(====)'];
  function planUfo(rnd) {
    const r = rnd || Math.random;
    return { drift: 0.05 + r() * 0.03, hover: 1500, dir: r() < 0.5 ? -1 : 1 };
  }

  // blackhole — a singularity opens in the prose and the nearby characters
  // spiral in and stretch toward it, then fall back out when it closes.
  function planBlackhole(rnd) {
    const r = rnd || Math.random;
    return { radius: 200 + r() * 90, spin: 0.0018 + r() * 0.001, pull: 1600, hue: (r() * 360) | 0 };
  }

  // life — Conway's Game of Life, seeded from the INK of whatever is on screen:
  // every character is a live cell and you watch your own words breed and die.
  function planLife(rnd) {
    const r = rnd || Math.random;
    return { stepMs: 150 + r() * 80, gens: 44, hue: 128 + r() * 90 };
  }

  // The Conway step, pure so a test can pin a blinker and a block. Flat
  // row-major 0/1 grids; edges are dead (no wrap), which is fine for a
  // screenful of text that reaches the borders anyway.
  function stepLife(alive, cols, rows) {
    const next = new Uint8Array(cols * rows);
    for (let rr = 0; rr < rows; rr++) {
      for (let cc = 0; cc < cols; cc++) {
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if (!dr && !dc) continue;
            const a = rr + dr, b = cc + dc;
            if (a < 0 || b < 0 || a >= rows || b >= cols) continue;
            n += alive[a * cols + b] ? 1 : 0;
          }
        }
        const live = alive[rr * cols + cc];
        next[rr * cols + cc] = ((live && (n === 2 || n === 3)) || (!live && n === 3)) ? 1 : 0;
      }
    }
    return next;
  }

  // melt — the whole screen turns to wax: every column of characters sags and
  // drips downward at its own pace, pooling at the bottom, then eases back home
  // at the end. The drips are canvas; the real text never moves.
  function planMelt(rnd) {
    const r = rnd || Math.random;
    return { speed: 0.05 + r() * 0.03, stagger: 1100, hold: 900 };
  }

  // quake — the ground shakes, the characters rattle off their lines, fall into
  // a heap at the bottom, then spring back home. Cheeky property damage;
  // everything is put back.
  function planQuake(rnd) {
    const r = rnd || Math.random;
    return { grav: 0.0024 + r() * 0.001, fallSpread: 700, home: 2400, jitter: 3 };
  }

  // dvd — the screensaver dream: a word lifted off the screen bounces around as
  // a logo, and if it ever hits a corner exactly, the crowd goes wild.
  function planDvd(rnd) {
    const r = rnd || Math.random;
    const ang = (0.28 + r() * 0.44) * Math.PI;
    return {
      vx: Math.cos(ang) * (r() < 0.5 ? 1 : -1),
      vy: Math.sin(ang) * (r() < 0.5 ? 1 : -1),
      speed: 0.10 + r() * 0.05, hue: (r() * 360) | 0,
    };
  }

  // aquarium — the terminal floods and the prose becomes the reef: ascii fish
  // swim the lines, bubbles rise, and nobody gets any work done.
  function planAquarium(rnd) {
    const r = rnd || Math.random;
    const n = 4 + ((r() * 4) | 0);
    const fish = [];
    for (let i = 0; i < n; i++) {
      fish.push({
        yF: 0.12 + r() * 0.74,
        speed: (0.03 + r() * 0.05) * (r() < 0.5 ? -1 : 1),
        phase: r() * Math.PI * 2,
        hue: (r() * 360) | 0,
        big: r() < 0.35,
      });
    }
    return { fish, bubbleP: 0.06 };
  }

  // ---- elemental grid effects (volume III): planners ----
  //
  // These transmute the on-screen text, so most of the behaviour is procedural
  // over a grid the tests can't see. The planner seeds pace, settle time and
  // direction; the transform (which glyph, which colour) lives in effects.js.
  // Each returns a plain params object so _gridScene has something truthy to
  // fire, and so a test can pin the numbers.
  function planIgnite(rnd) { const r = rnd || Math.random; return { speed: 0.85 + r() * 0.5, settle: 520 }; }
  function planFrostbite(rnd) { const r = rnd || Math.random; return { speed: 0.6 + r() * 0.4, settle: 700 }; }
  function planCorrode(rnd) { const r = rnd || Math.random; return { speed: 0.7 + r() * 0.4, settle: 640 }; }
  function planElectrify(rnd) { const r = rnd || Math.random; return { stepMs: 45 + r() * 30, flare: 360 }; }
  function planOvergrow(rnd) { const r = rnd || Math.random; return { speed: 0.5 + r() * 0.35, settle: 820 }; }
  function planRust(rnd) { const r = rnd || Math.random; return { speed: 0.7 + r() * 0.4, settle: 900, dir: r() < 0.5 ? 1 : -1 }; }
  function planFlood(rnd) { const r = rnd || Math.random; return { rise: 0.05 + r() * 0.03 }; }
  function planPetrify(rnd) { const r = rnd || Math.random; return { speed: 0.75 + r() * 0.4, settle: 650 }; }
  function planSmokescreen(rnd) { const r = rnd || Math.random; return { rise: 0.045 + r() * 0.03 }; }
  function planGlaciate(rnd) { const r = rnd || Math.random; return { speed: 0.9 + r() * 0.5, settle: 600, dir: r() < 0.5 ? 1 : -1 }; }
  function planMagma(rnd) { const r = rnd || Math.random; return { speed: 0.8 + r() * 0.5, settle: 720 }; }
  function planWindshear(rnd) { const r = rnd || Math.random; return { gust: 900, ret: 1500, dir: r() < 0.5 ? 1 : -1 }; }
  function planThunderhead(rnd) { const r = rnd || Math.random; return { strikeMs: 260 + r() * 160 }; }
  function planSandbury(rnd) { const r = rnd || Math.random; return { rise: 0.05 + r() * 0.03, dir: r() < 0.5 ? 1 : -1 }; }
  function planSpores(rnd) { const r = rnd || Math.random; return { speed: 0.55 + r() * 0.4, settle: 900 }; }

  return {
    FlourishParser, POINT_EFFECTS, STYLE_SPANS, PER_CHAR_SPANS, CONSUMING_SPANS,
    MUTATING_SPANS, SCRIPTED_SPANS, RENDERER_EFFECTS, DISABLED_EFFECTS,
    PALETTES, SIZES, parseArgs,
    WIND_STRENGTH, parseWind, planBurn, planSalvage,
    ROT_GROUPS, ROT_VARIANTS, rotVariants,
    CONFAB_PAIRS, planConfab, overwriteShift, mutableMask,
    plausibleDirective, MAX_DIRECTIVE_LEN,
    BOLT_FALLOFF, boltPath, measurePath, forkPaths, leaderStair, revealAt,
    ANCHOR_MIN_SPREAD, MIN_SLOPE, anchorsFlat, stratifyAnchors, lineCount,
    pairShallow, planApopheniaPairs,
    ASCII_EFFECTS, BANNER_5x7, BANNER_H, BANNER_WORDS, bannerRows, SKULL,
    SNIFFER_PAYLOADS, TRACE_HOPS, PORT_SVC, CRACK_WORDS, CRACK_CHARSET,
    planWardial, planSniffer, planTrace, planDaemon, planPortscan,
    planOverflow, planCrack, planGibson,
    GRID_EFFECTS, SKULL_JAW_ROW, SKULL_CHOMPS, JAW_DROP, jawDropAt, planSkull,
    WIREFRAME_SHAPES, planWireframe, slopeGlyph, rasterCells,
    planPlasma, plasmaField, planTunnel,
    FIREWALL_MAX_HEAT, FIREWALL_RAMP, stepFirewall, planFirewall,
    CAT_W, CAT_FRAMES, mirrorCatFrame, planCat,
    planSnake, INVADER, CANNON, planInvaders, planPacman, SAUCER, planUfo,
    planBlackhole, planLife, stepLife, planMelt, planQuake, planDvd, planAquarium,
    planIgnite, planFrostbite, planCorrode, planElectrify, planOvergrow,
    planRust, planFlood, planPetrify, planSmokescreen, planGlaciate,
    planMagma, planWindshear, planThunderhead, planSandbury, planSpores,
  };
});
