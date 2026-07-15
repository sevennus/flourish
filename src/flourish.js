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
  ]);
  const STYLE_SPANS = new Set([
    'shimmer', 'rainbow', 'glow', 'wave', 'color',
    'fire', 'neon', 'scramble', 'bounce',
    'flicker', 'redact', 'stamp', 'chrome', 'ghost', 'corrupt', 'sparkle',
    'burn', 'cascade', 'hologram', 'hexdump',
  ]);

  // Spans rendered one <i> per character (staggered animation or per-char JS)
  // rather than as a single styled span. The renderer needs this; it lives here
  // so the vocabulary stays in one place.
  const PER_CHAR_SPANS = new Set([
    'wave', 'bounce', 'scramble', 'stamp', 'corrupt', 'sparkle',
    'burn', 'cascade', 'hexdump',
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
    PALETTES, SIZES, parseArgs,
    WIND_STRENGTH, parseWind, planBurn,
  };
});
