/*
 * textfx.js — the spans that do something to the text itself, from script.
 *
 * Classic browser script: attaches window.FlourishTextFX.
 *
 * Everything else in Flourish keeps the two layers apart — spans style DOM,
 * effects paint canvas, and they never touch. These are the exception: they
 * animate real characters AND throw real particles off them, so the embers
 * peeling off a burning letter come from the same engine as a nova.
 *
 * The consuming spans — text that destroys itself:
 *
 *   burn     — a character catches, and fire spreads outward from it. Wind
 *              makes the spread asymmetric: downwind it races, upwind it
 *              creeps. Each character goes ignite → white-hot → charcoal →
 *              ash, shedding embers at its peak and ash as it dies.
 *   cascade  — characters detach and fall away as Matrix glyphs.
 *
 * The unreliable spans — text that lies:
 *
 *   rot         — characters decay toward lookalikes, in place, slowly. The
 *                 line stays exactly as long as you leave it and stops being
 *                 what you wrote.
 *   confabulate — words quietly turn over behind the reader. Never announces,
 *                 never flickers; the only evidence is the reader's memory.
 *   intrusive   — a word that was never said pushes in, sits, and withdraws.
 *   overwrite   — characters land on top of each other instead of after.
 *
 * The difference matters: burn and cascade are honest about being destructive —
 * you watch them eat the line. The unreliable three are built so you don't
 * notice, which is why they are the only effects in the app that can cost the
 * reader something they'd act on, and why MUTABLE_REJECT below is not optional.
 *
 * Three things are load-bearing:
 *
 * 1. CONSUMED CHARACTERS KEEP THEIR BOX. The <i> is never removed and never
 *    display:none — it stays in place. Removing it would reflow the paragraph
 *    mid-burn and the text would visibly jump around while it's being eaten,
 *    which looks like a bug rather than like fire.
 *
 *    Burn and cascade differ in what they leave there. Burn settles to a
 *    readable ash grey: the fire ruins the text, it doesn't delete it, and a
 *    burnt line can still be read afterwards. Cascade really does take the
 *    character away — the glyph detaches onto the canvas and falls, so the DOM
 *    copy blanking to opacity 0 is the point rather than a shortcut.
 *
 * 2. RECTS ARE READ SPARINGLY. getBoundingClientRect() forces layout, and the
 *    typewriter is still appending text below, so a rect read per character per
 *    frame would both stall and lie. Each character's position is read once, at
 *    its own ignition, and reused for its embers and ash.
 *
 * 3. NOTHING MUTATES WHAT A READER MIGHT COPY. rot and confabulate change what
 *    the text SAYS, so a span aimed carelessly could put a command or a path on
 *    screen that the model never wrote — and neither Jim nor the model would
 *    find out, because the screen is the only record either of them checks.
 *    Flourish.mutableMask() decides what is plainly prose, and MUTABLE_REJECT
 *    below applies it per character. The system prompt asks the model to aim
 *    these well; the mask is what makes aiming badly harmless.
 */
(function () {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);
  const chance = (p) => Math.random() < p;

  // How long one character takes to go from catching to spent. The flame is the
  // slow part on purpose: a character that catches should be alight long enough
  // to watch it burn, not blink. The fire still spreads between characters at
  // its own pace (planBurn), so a longer flame means more of the span is alight
  // at once — a flame front rather than a travelling dot.
  const RISE_MS = 260;     // ignite → peak
  const FALL_MS = 980;     // peak → charcoal
  const ASH_MS = 620;      // charcoal → ashed over

  const EMBER = ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ff3860'];
  const ASH = ['#4a4038', '#6b5f54', '#332c26'];

  const parseHex = (s) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(s || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const mix = (a, b, k) => ({
    r: a.r + (b.r - a.r) * k, g: a.g + (b.g - a.g) * k, b: a.b + (b.b - a.b) * k,
  });
  const hex = (c) =>
    '#' + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

  const CHARCOAL = parseHex('#3b322c');

  // Where a burnt character comes to rest. Fire leaves ash, not a hole: the
  // characters stay readable as spent grey, dimmer than the UI's own dim text
  // but nowhere near the near-black background. Burning has to read as "this is
  // gone" without actually costing the reader the characters.
  //
  // The colour itself lives in styles.css as --ash, so this and the
  // [data-burnt] backstop rule there can't drift apart. Read once, on first
  // use: it's a computed-style read, and it can't run at module scope because
  // this file loads before the stylesheet has necessarily applied.
  let restCache = null;
  function restColor() {
    if (restCache) return restCache;
    let v = '';
    try {
      v = getComputedStyle(document.documentElement).getPropertyValue('--ash');
    } catch (e) { /* no document (tests, headless) — fall through */ }
    restCache = parseHex(v) || parseHex('#6f665e');
    return restCache;
  }

  // Colour of a character at a given heat (0 cold → 1 white-hot).
  function heatColor(h) {
    if (h >= 0.82) return '#fff8e0';
    if (h >= 0.62) return '#ffd27a';
    if (h >= 0.40) return '#ff9d3c';
    if (h >= 0.20) return '#ff5c2a';
    return '#ff3860';
  }

  class FlourishTextFX {
    constructor(effects) {
      this.effects = effects;
      this.running = new Set();
    }

    /**
     * Drive a consuming span. `span` is the wrapper; its <i> children are the
     * characters. Safe to call on a span with no characters.
     */
    play(name, span, args) {
      const chars = Array.prototype.filter.call(span.children, (n) => n.tagName === 'I');
      if (!chars.length) return;
      if (name === 'burn') this._burn(span, chars, args);
      else if (name === 'cascade') this._cascade(span, chars, args);
      else if (name === 'rot') this._rot(span, chars, args);
      else if (name === 'confabulate') this._confabulate(span, chars, args);
      else if (name === 'intrusive') this._intrusive(span, chars, args);
      else if (name === 'overwrite') this._overwrite(span, chars, args);
    }

    /**
     * The characters of `chars` that a mutating span may rewrite.
     * Returns a Set of indices.
     *
     * The mask is computed from the span's own text rather than from the DOM,
     * because the renderer switches the auto-highlight layer off inside an
     * explicit fx span (see appendText in renderer.js) — so there are no
     * .auto-code nodes in here to key off, and the shape of the text is all
     * there is to go on.
     */
    _mutable(chars) {
      const text = chars.map((c) => c.textContent).join('');
      const mask = window.Flourish.mutableMask(text);
      const out = new Set();
      // One <i> per character, so the mask indexes the chars array directly —
      // but only while that holds. Bail rather than guess if it ever doesn't.
      if (mask.length !== chars.length) return out;
      for (let i = 0; i < mask.length; i++) if (mask[i]) out.add(i);
      return out;
    }

    _burn(span, chars, args) {
      const F = window.Flourish;
      const wind = F.parseWind(args);
      // A character somewhere in the middle catches, and it goes from there —
      // that reads as ignition. Seeding at the upwind edge reads as a wipe.
      const seed = (Math.random() * chars.length) | 0;
      const at = F.planBurn(chars.length, wind, seed, rand(70, 110));

      const st = chars.map(() => ({ rect: null, embers: 0, ashed: false }));
      const total = Math.max.apply(null, at) + RISE_MS + FALL_MS + ASH_MS + 60;
      const t0 = performance.now();
      const drift = wind.dir * wind.strength;   // how hard embers lean

      const step = (now) => {
        const el = now - t0;
        for (let i = 0; i < chars.length; i++) {
          const ig = at[i];
          if (el < ig) continue;
          const age = el - ig;
          const c = chars[i];
          const s = st[i];

          if (!s.rect) {
            // First frame this character is alight: read its position once.
            const r = c.getBoundingClientRect();
            s.rect = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }

          if (age <= RISE_MS + FALL_MS) {
            const h = age < RISE_MS
              ? age / RISE_MS
              : Math.max(0, 1 - (age - RISE_MS) / FALL_MS);
            c.style.color = heatColor(h);
            c.style.textShadow = `0 0 ${(4 + h * 14).toFixed(1)}px rgba(255,${(90 + h * 130) | 0},40,${(0.5 + h * 0.5).toFixed(2)})`;
            // A hot character shouldn't sit still.
            if (h > 0.45) {
              c.style.transform = `translate(${rand(-0.8, 0.8).toFixed(2)}px, ${rand(-1.1, 0.3).toFixed(2)}px)`;
            }
            // Embers, only from the flame front, only a few per character.
            if (h > 0.55 && s.embers < 3 && chance(0.5)) {
              s.embers++;
              this.effects.emit(s.rect.x, s.rect.y, {
                n: 2, colors: EMBER,
                angle: -Math.PI / 2 + drift * 0.5, spread: 0.7,
                speedMin: 0.4, speedMax: 1.8,
                sizeMin: 0.8, sizeMax: 1.9,
                lifeMin: 500, lifeMax: 1200,
                grav: -0.012, drag: 0.995, jitter: 2, halo: 10, twinkle: true,
              });
            }
          } else if (age <= RISE_MS + FALL_MS + ASH_MS) {
            // The ember dies dark, then ashes over — the character comes back
            // up as a spent grey instead of fading out of existence. It never
            // touches opacity: legibility here is all colour, so the resting
            // state is exactly --ash rather than --ash washed toward the
            // background by a half-faded alpha.
            const k = (age - RISE_MS - FALL_MS) / ASH_MS;
            c.style.color = hex(mix(CHARCOAL, restColor(), k));
            c.style.textShadow = 'none';
            c.style.transform = `translateY(${(k * 1.5).toFixed(2)}px) scale(${(1 - k * 0.06).toFixed(3)})`;
            if (!s.ashed && k > 0.25) {
              s.ashed = true;
              this.effects.emit(s.rect.x, s.rect.y, {
                n: 3, colors: ASH,
                angle: Math.PI / 2 + drift * 0.6, spread: 0.9,
                speedMin: 0.2, speedMax: 0.9,
                sizeMin: 0.7, sizeMax: 1.6,
                lifeMin: 700, lifeMax: 1600,
                grav: 0.012, drag: 0.99, jitter: 3, sway: true,
              });
            }
          } else {
            // Spent, not deleted: a legible grey ghost, still in its own box.
            c.style.color = hex(restColor());
            c.style.transform = 'translateY(1.5px) scale(0.94)';
          }
        }
        if (el < total) requestAnimationFrame(step);
        else { this.running.delete(span); span.dataset.burnt = '1'; }
      };
      this.running.add(span);
      requestAnimationFrame(step);
    }

    _cascade(span, chars, args) {
      const F = window.Flourish;
      const wind = F.parseWind(args);
      // Left to right by default, so it reads as the line being pulled apart
      // in reading order rather than collapsing at random.
      const order = wind.dir > 0 ? 0 : chars.length - 1;
      const at = F.planBurn(chars.length, { dir: wind.dir, strength: 1 }, order, rand(28, 52));
      const st = chars.map(() => ({ rect: null, dropped: false }));
      const total = Math.max.apply(null, at) + 900;
      const t0 = performance.now();

      const step = (now) => {
        const el = now - t0;
        for (let i = 0; i < chars.length; i++) {
          if (el < at[i]) continue;
          const age = el - at[i];
          const c = chars[i];
          const s = st[i];
          if (!s.rect) {
            const r = c.getBoundingClientRect();
            s.rect = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          if (!s.dropped) {
            s.dropped = true;
            // Hand the character over to the canvas: it falls as a glyph while
            // the DOM copy blanks out. The engine picks the alphabet it decays
            // into — it knows which glyphs this font can actually draw.
            this.effects.glyphFall(s.rect.x, s.rect.y, c.textContent);
          }
          const k = Math.min(1, age / 260);
          c.style.opacity = (1 - k).toFixed(2);
        }
        if (el < total) requestAnimationFrame(step);
        else this.running.delete(span);
      };
      this.running.add(span);
      requestAnimationFrame(step);
    }

    // ---- the unreliable spans ----

    /*
     * rot — characters decaying toward lookalikes, slowly, in place.
     *
     * Scheduled with setTimeout rather than rAF, and that's the whole design:
     * this effect is measured in tens of seconds and touches a character maybe
     * four times in its life. A rAF loop would wake 60 times a second for
     * ~30 seconds to do nothing, per span, forever — text has a shelf life here,
     * so the spans don't end, they just run out of steps.
     */
    _rot(span, chars, args) {
      const F = window.Flourish;
      const mutable = this._mutable(chars);
      const rest = restColor();
      // Slower with `slow`, quicker with `fast` — the default is tuned so a
      // paragraph looks untouched while you read it and wrong when you come back.
      const a = String(args || '').toLowerCase();
      const scale = a.includes('fast') ? 0.35 : (a.includes('slow') ? 2.4 : 1);
      const FIRST = 4200 * scale;   // nothing moves while the reader is still on the line
      const STEP = 3400 * scale;

      for (let i = 0; i < chars.length; i++) {
        if (!mutable.has(i)) continue;
        const c = chars[i];
        let left = F.rotDepth(c.textContent);
        if (!left) continue;
        const tick = () => {
          const next = F.rotNext(c.textContent);
          if (next === c.textContent) return;       // spent
          c.textContent = next;
          // Each step dims a little toward ash. Colour only, never opacity: a
          // rotted character is exactly as legible as the glyph it rotted into.
          const k = 1 - left / (left + 1);
          c.style.color = hex(mix(parseHex('#cfe9d8'), rest, Math.min(1, k + 0.25)));
          if (--left > 0) setTimeout(tick, STEP + rand(-700, 700) * scale);
        };
        setTimeout(tick, FIRST + rand(0, 2600) * scale);
      }
    }

    /*
     * confabulate — words that turn over behind the reader.
     *
     * The word keeps its box. A six-letter word becoming a five-letter one would
     * otherwise reflow the line, and a paragraph that twitches gives the whole
     * thing away — the same constraint burn has, for the same reason (see 1
     * above). So the replacement is measured against the original's width and
     * scaled into it: layout never learns anything happened.
     *
     * Widths are read in one pass up front. They stay true no matter when each
     * swap actually fires, precisely because every swap preserves width.
     */
    _confabulate(span, chars, args) {
      const F = window.Flourish;
      const text = chars.map((c) => c.textContent).join('');
      const mask = F.mutableMask(text);
      if (mask.length !== chars.length) return;

      const plan = F.planConfab(text).filter((p) => {
        for (let i = p.start; i < p.end; i++) if (!mask[i]) return false;
        return true;
      });
      if (!plan.length) return;

      // Two or three per span. All of them at once reads as a glitch; one is
      // easy to talk yourself out of having seen.
      const picks = [];
      const pool = plan.slice();
      const want = Math.min(pool.length, 2 + ((Math.random() * 2) | 0));
      while (picks.length < want && pool.length) {
        picks.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
      }

      // One layout pass for every word we're going to touch.
      for (const p of picks) {
        const a = chars[p.start].getBoundingClientRect();
        const b = chars[p.end - 1].getBoundingClientRect();
        p.w = b.right - a.left;
      }

      for (const p of picks) {
        const delay = 2600 + Math.random() * 9000;
        setTimeout(() => {
          if (!chars[p.start].parentNode) return;   // line was cleared underneath us
          const box = document.createElement('b');
          box.style.width = p.w.toFixed(2) + 'px';
          const inner = document.createElement('span');
          inner.textContent = p.to;
          box.appendChild(inner);
          chars[p.start].parentNode.insertBefore(box, chars[p.start]);
          for (let i = p.start; i < p.end; i++) chars[i].remove();
          // Scale the replacement into the width the original left behind. Read
          // after insertion because the natural width isn't knowable before it.
          const natural = inner.getBoundingClientRect().width;
          if (natural > 0) {
            inner.style.transform = 'scaleX(' + (p.w / natural).toFixed(4) + ')';
          }
        }, delay);
      }
    }

    /*
     * intrusive — a word that was never said.
     *
     * The only effect in the file that WANTS the reflow: the sentence opens to
     * let the word in and closes behind it, and that movement is the effect.
     * The word rides in the directive's own args.
     */
    _intrusive(span, chars, args) {
      const word = String(args || '').trim();
      if (!word) return;

      // Land it on a space, so it reads as a word pushing between two words
      // rather than splitting one open.
      const gaps = [];
      for (let i = 1; i < chars.length - 1; i++) {
        if (chars[i].textContent === ' ') gaps.push(i);
      }
      if (!gaps.length) return;
      const at = gaps[(Math.random() * gaps.length) | 0];

      const el = document.createElement('span');
      el.className = 'intruder';
      el.textContent = word + ' ';
      chars[at].parentNode.insertBefore(el, chars[at + 1]);

      // width:0 + overflow:hidden means scrollWidth is the width it WOULD have.
      const w = el.scrollWidth;
      const open = [{ width: '0px', opacity: 0 }, { width: w + 'px', opacity: 1 }];
      const shut = [{ width: w + 'px', opacity: 1 }, { width: '0px', opacity: 0 }];
      const ease = { duration: 420, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1)', fill: 'forwards' };

      el.animate(open, ease);
      setTimeout(() => {
        const a = el.animate(shut, ease);
        a.onfinish = () => el.remove();   // the text closes over the gap
      }, 1500 + Math.random() * 1200);
    }

    /*
     * overwrite — characters landing on top of each other.
     *
     * margin-left, not translateX: the point is that the line gets DENSER, and a
     * transform would slide the glyphs together while leaving the line its
     * original width — a word pile with a gap after it, which reads as a layout
     * bug. Margins actually shorten the line. It reflows every frame of the
     * transition, which is affordable exactly once, on a span this short.
     */
    _overwrite(span, chars, args) {
      const F = window.Flourish;
      const a = String(args || '').toLowerCase();
      const max = a.includes('hard') ? 0.82 : (a.includes('soft') ? 0.38 : null);
      const n = chars.length;
      for (let i = 0; i < n; i++) {
        chars[i].style.transition = 'margin-left 1.1s cubic-bezier(0.4, 0, 0.2, 1)';
        chars[i].style.transitionDelay = (i * 0.012).toFixed(3) + 's';
      }
      // Next frame, so the transition has a start value to leave from.
      requestAnimationFrame(() => {
        for (let i = 0; i < n; i++) {
          chars[i].style.marginLeft = '-' + F.overwriteShift(i, n, max).toFixed(3) + 'ch';
        }
      });
    }
  }

  window.FlourishTextFX = FlourishTextFX;
})();
