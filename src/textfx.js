/*
 * textfx.js — the consuming spans: text that destroys itself.
 *
 * Classic browser script: attaches window.FlourishTextFX.
 *
 * Everything else in Flourish keeps the two layers apart — spans style DOM,
 * effects paint canvas, and they never touch. These are the exception: they
 * animate real characters AND throw real particles off them, so the embers
 * peeling off a burning letter come from the same engine as a nova.
 *
 *   burn     — a character catches, and fire spreads outward from it. Wind
 *              makes the spread asymmetric: downwind it races, upwind it
 *              creeps. Each character goes ignite → white-hot → charcoal →
 *              gone, shedding embers at its peak and ash as it dies.
 *   cascade  — characters detach and fall away as Matrix glyphs.
 *
 * Two things are load-bearing:
 *
 * 1. CONSUMED CHARACTERS KEEP THEIR BOX. The <i> is never removed and never
 *    display:none — it goes to opacity 0 in place. Removing it would reflow the
 *    paragraph mid-burn and the text would visibly jump around while it's being
 *    eaten, which looks like a bug rather than like fire.
 *
 * 2. RECTS ARE READ SPARINGLY. getBoundingClientRect() forces layout, and the
 *    typewriter is still appending text below, so a rect read per character per
 *    frame would both stall and lie. Each character's position is read once, at
 *    its own ignition, and reused for its embers and ash.
 */
(function () {
  'use strict';

  const rand = (a, b) => a + Math.random() * (b - a);
  const chance = (p) => Math.random() < p;

  // How long one character takes to go from catching to gone.
  const RISE_MS = 190;     // ignite → peak
  const FALL_MS = 520;     // peak → charcoal
  const ASH_MS = 340;      // charcoal → gone

  const EMBER = ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ff3860'];
  const ASH = ['#4a4038', '#6b5f54', '#332c26'];

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
            // Charcoal, crumbling.
            const k = (age - RISE_MS - FALL_MS) / ASH_MS;
            c.style.color = '#3b322c';
            c.style.textShadow = 'none';
            c.style.opacity = (1 - k).toFixed(2);
            c.style.transform = `translateY(${(k * 3).toFixed(2)}px) scale(${(1 - k * 0.25).toFixed(3)})`;
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
            // Gone — but still occupying its box, so nothing reflows.
            c.style.opacity = '0';
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
  }

  window.FlourishTextFX = FlourishTextFX;
})();
