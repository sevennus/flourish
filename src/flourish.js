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

  // Which directive names are point effects vs. wrapping style spans.
  const POINT_EFFECTS = new Set([
    'spark', 'confetti', 'fireworks', 'ripple', 'pulse', 'shake', 'matrix',
    'lightning', 'nova', 'meteor', 'embers', 'vortex', 'glitch',
    'aurora', 'constellation', 'shatter', 'swarm', 'sonar', 'warp',
    'frost', 'bloom', 'rain', 'beam', 'implode',
    'scanlines', 'static', 'vhs', 'grid', 'circuit', 'tracer',
    'apophenia', 'dilate',
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
  // So it resolves, and the renderer drops it on the floor. To bring it back,
  // take it out of this set and restore its line in prompt.js.
  const DISABLED_EFFECTS = new Set(['apophenia']);

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
  ]);

  // Spans rendered one <i> per character (staggered animation or per-char JS)
  // rather than as a single styled span. The renderer needs this; it lives here
  // so the vocabulary stays in one place.
  const PER_CHAR_SPANS = new Set([
    'wave', 'bounce', 'scramble', 'stamp', 'corrupt', 'sparkle',
    'burn', 'cascade', 'hexdump',
    'twin', 'overwrite', 'rot', 'confabulate', 'intrusive',
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
    const out = { palette: null, scale: 1 };
    for (const w of String(raw || '').toLowerCase().split(/\s+/)) {
      if (!w) continue;
      if (PALETTES.has(w)) out.palette = w;
      else if (SIZES[w] != null) out.scale = SIZES[w];
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
  function stratifyAnchors(cand, max, rnd) {
    const random = rnd || Math.random;
    const rows = new Map();
    for (const c of cand) {
      const key = Math.round(c.y / 6);   // same visual line, give or take
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

  return {
    FlourishParser, POINT_EFFECTS, STYLE_SPANS, PER_CHAR_SPANS, CONSUMING_SPANS,
    MUTATING_SPANS, SCRIPTED_SPANS, RENDERER_EFFECTS, DISABLED_EFFECTS,
    PALETTES, SIZES, parseArgs,
    WIND_STRENGTH, parseWind, planBurn,
    ROT_GROUPS, ROT_VARIANTS, rotVariants,
    CONFAB_PAIRS, planConfab, overwriteShift, mutableMask,
    plausibleDirective, MAX_DIRECTIVE_LEN,
    BOLT_FALLOFF, boltPath, measurePath, forkPaths, leaderStair, revealAt,
    ANCHOR_MIN_SPREAD, MIN_SLOPE, anchorsFlat, stratifyAnchors,
    pairShallow, planApopheniaPairs,
  };
});
