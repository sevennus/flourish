/*
 * autofx.js — the automatic highlight layer.
 *
 * The flourish directives mark up MEANING, and only where the model thought to.
 * This marks up FORM — inline `code`, **bold**, and bare numbers — so the
 * transcript keeps painting even in a reply that never fired an effect. It also
 * means the model doesn't have to (and is told not to) wrap code and numbers
 * itself, which is the thing that would break copy/paste.
 *
 * Pure and streaming-safe for the same reason flourish.js is: the typewriter
 * reveals ~14 characters a frame, so a `**` or a number routinely straddles two
 * feeds. It never touches the DOM, so it's unit-tested without a browser.
 *
 * Emits runs, not events — { text: '<string>', cls: '<class>'|null } — and the
 * renderer coalesces adjacent runs that share a class into one span, so a long
 * `code` run is one bordered box rather than one per typewriter chunk.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AutoFX = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class AutoStyler {
    constructor() { this.code = false; this.bold = false; this.star = false; this.num = ''; this.plain = ''; }

    /**
     * Feed a chunk of text; returns the runs that could be resolved. Plain text
     * always flushes, so nothing is ever held back from the screen; only a
     * number in progress and a lone `*` awaiting its twin survive a feed.
     */
    feed(str) {
      const out = [];
      for (const ch of str) this._ch(ch, out);
      this._flushPlain(out);
      return out;
    }

    /** Call when the stream is complete, so a trailing number isn't lost. */
    flush() {
      const out = [];
      if (this.star) { this.star = false; this.plain += '*'; }
      this._flushNum(out);
      this._flushPlain(out);
      return out;
    }

    _cls() { return this.code ? 'auto-code' : (this.bold ? 'auto-bold' : null); }

    _ch(ch, out) {
      if (this.star) {                       // we held a `*` waiting for its twin
        this.star = false;
        if (ch === '*') { this._flush(out); this.bold = !this.bold; return; }
        this.plain += '*';                   // a lone asterisk is just an asterisk
      }
      if (!this.code && ch === '*') { this.star = true; return; }
      if (ch === '`') { this._flush(out); this.code = !this.code; return; }

      // Inside code or bold the formatting already says what it is; don't also
      // hunt for numbers in there.
      if (this.code || this.bold) { this.plain += ch; return; }

      if (ch >= '0' && ch <= '9') { this._flushPlain(out); this.num += ch; return; }
      if (this.num) {
        // Separators keep a run alive — 3.14, 1,600, 90%, 16:9 are one number.
        if ('.,:%'.indexOf(ch) !== -1) { this.num += ch; return; }
        this._flushNum(out);
      }
      this.plain += ch;
    }

    // Flushing before a state change is what keeps the classes correct: the run
    // that just ended is emitted under the class it was written in, not the one
    // the toggle is about to switch to.
    _flush(out) { this._flushNum(out); this._flushPlain(out); }
    _flushPlain(out) { if (this.plain) { out.push({ text: this.plain, cls: this._cls() }); this.plain = ''; } }

    _flushNum(out) {
      if (!this.num) return;
      let n = this.num; this.num = '';
      // A trailing separator belongs to the sentence, not to the number.
      let trail = '';
      while (n.length && '.,:'.indexOf(n[n.length - 1]) !== -1) { trail = n[n.length - 1] + trail; n = n.slice(0, -1); }
      if (n) out.push({ text: n, cls: 'auto-num' });
      this.plain += trail;
    }
  }

  return { AutoStyler };
});
