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

  // ---- rot: characters decaying toward lookalikes ----

  // Each character's decay path, one step at a time, ending at a full stop.
  // The chains are built on SHAPE, not on meaning: every step has to be a glyph
  // the reader could plausibly have misread the previous one as, or the effect
  // reads as corruption (which `corrupt` already does, loudly) rather than as
  // text going soft while you weren't looking.
  //
  // Everything converges on '.' rather than on ' '. A rotted line has to keep
  // its shape — holes would reflow the paragraph, and a period is the smallest
  // mark that still holds a character's box.
  //
  // Every chain has to terminate, and the digits are where that's easy to get
  // wrong: shape-wise `b`→`6` and `6`→`b` are both honest, but together they're
  // a cycle, and a cycle here is a character that never stops changing inside a
  // rAF loop. The letters step toward the digits; the digits only ever step
  // toward round shapes or straight to a stop. rotTerminates() proves it.
  const ROT_CHAINS = {
    a: 'oc.', b: '6o.', c: 'r.', d: 'cl.', e: 'cr.', f: 'r.', g: '9o.',
    h: 'nr.', i: 'l.', j: 'i.', k: 'x.', l: '|.', m: 'nr.', n: 'r.',
    o: 'c.', p: 'o.', q: 'g.', r: '.', s: '5.', t: 'fr.', u: 'v.',
    v: '.', w: 'v.', x: '.', y: 'v.', z: '2.',
    A: '4.', B: '8.', C: 'c.', D: 'O.', E: 'F.', F: 'r.', G: '6.',
    H: 'n.', I: 'l.', J: 'i.', K: 'x.', L: '|.', M: 'nn.', N: 'n.',
    O: '0.', P: 'F.', Q: 'O.', R: 'F.', S: '5.', T: 'r.', U: 'v.',
    V: 'v.', W: 'v.', X: 'x.', Y: 'v.', Z: '2.',
    '0': 'o.', '1': '|.', '2': '.', '3': '>.', '4': 'l.', '5': '.',
    '6': 'o.', '7': '/.', '8': 'o.', '9': 'o.',
  };

  /**
   * One step of decay. Returns the next glyph along `ch`'s chain, or the same
   * character if it has nowhere left to go ('.' and whitespace are terminal).
   *
   * Pure and total: an unmapped character (punctuation, emoji, anything
   * non-Latin) is its own terminal state rather than an error, so rot applied to
   * a line of CJK or a shrug emoticon quietly does nothing instead of throwing
   * inside a rAF loop.
   */
  function rotNext(ch) {
    const chain = ROT_CHAINS[ch];
    if (chain) return chain[0];
    // Mid-chain: find the character in the chain it belongs to and step along.
    for (const k in ROT_CHAINS) {
      const c = ROT_CHAINS[k];
      const at = c.indexOf(ch);
      if (at !== -1 && at < c.length - 1) return c[at + 1];
    }
    return ch;
  }

  // No chain is anywhere near this long; it's a backstop so a future edit that
  // reintroduces a cycle degrades to a bounded walk instead of hanging.
  const ROT_MAX_DEPTH = 12;

  /**
   * How many steps `ch` has left before it bottoms out. Used to size the
   * effect's lifetime so it stops scheduling frames once everything is spent.
   */
  function rotDepth(ch) {
    let n = 0;
    let c = ch;
    for (let i = 0; i < ROT_MAX_DEPTH; i++) {
      const nx = rotNext(c);
      if (nx === c) break;
      c = nx; n++;
    }
    return n;
  }

  /**
   * Does `ch` reach a terminal glyph without revisiting one? False means the
   * chains contain a cycle, which the test asserts against for every character
   * in the table — the failure mode is a rAF loop that never settles, and it's
   * invisible until someone rots the one word that contains the bad letter.
   */
  function rotTerminates(ch) {
    const seen = new Set();
    let c = ch;
    for (let i = 0; i < ROT_MAX_DEPTH; i++) {
      if (seen.has(c)) return false;
      seen.add(c);
      const nx = rotNext(c);
      if (nx === c) return true;
      c = nx;
    }
    return false;
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

  // A directive can't be longer than this; if we buffer `{{` and never find a
  // closing `}}` within this many chars, we give up and flush it as literal
  // text. Keeps a stray `{{` in normal prose from swallowing the whole reply.
  const MAX_TOKEN_LEN = 64;

  const ALL_NAMES = new Set([...POINT_EFFECTS, ...STYLE_SPANS]);

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
        } else if (this.buf.length > MAX_TOKEN_LEN) {
          // Too long to be a directive — flush what we buffered as literal.
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

  return {
    FlourishParser, POINT_EFFECTS, STYLE_SPANS, PER_CHAR_SPANS, CONSUMING_SPANS,
    MUTATING_SPANS, SCRIPTED_SPANS, RENDERER_EFFECTS,
    PALETTES, SIZES, parseArgs,
    WIND_STRENGTH, parseWind, planBurn,
    ROT_CHAINS, rotNext, rotDepth, rotTerminates,
    CONFAB_PAIRS, planConfab, overwriteShift, mutableMask,
  };
});
