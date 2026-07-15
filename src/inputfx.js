/*
 * inputfx.js — flourishes on the prompt box while you type.
 *
 * Classic browser script: attaches window.FlourishInputFX.
 *
 * Three layers stack here:
 *
 *   HEAT — typing fast builds heat (it decays whenever you pause), and heat
 *   picks the tier of every spark, from a couple of cool green flecks up to a
 *   white-hot plume. Sending spends it: a cold prompt launches with a spark, an
 *   incandescent one with a nova.
 *
 *   KEY CLASS — what you typed matters, not just how fast. Space, punctuation,
 *   digits, capitals, `!`, `?`, delete and paste each paint differently, so the
 *   box reacts to the shape of the sentence and not only its speed.
 *
 *   STREAK — an unbroken run of keys pays out at milestones, so a long fluent
 *   burst of typing builds to something instead of staying flat.
 *
 * Finding the caret's screen position inside an <input> is the only fiddly
 * part: there's no Range API for form fields, so we measure the text before the
 * caret with the input's own computed font on a scratch canvas and offset by
 * the box's padding and scroll.
 */
(function () {
  'use strict';

  const TIERS = [
    { at: 0.00, name: 'cool',    n: [2, 4],   speed: [0.5, 2.2], size: [0.8, 1.8], colors: ['#35f0a0', '#7effc4', '#ffffff'] },
    { at: 0.24, name: 'warm',    n: [4, 7],   speed: [0.7, 3.0], size: [1.0, 2.2], colors: ['#7effc4', '#37b6ff', '#ffffff', '#ffd27a'] },
    { at: 0.50, name: 'hot',     n: [6, 10],  speed: [0.9, 3.8], size: [1.2, 2.6], colors: ['#ffd27a', '#ff9d3c', '#ffffff', '#35f0a0'] },
    { at: 0.74, name: 'blaze',   n: [9, 14],  speed: [1.2, 4.6], size: [1.4, 3.0], colors: ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ffffff'] },
    { at: 0.92, name: 'inferno', n: [14, 22], speed: [1.6, 6.0], size: [1.6, 3.6], colors: ['#ffffff', '#fff3b0', '#ff9d3c', '#ff5c2a', '#ff3860'] },
  ];

  const HEAT_PER_KEY = 0.075;   // ~13 quick keys to go from cold to blazing
  const HEAT_HALFLIFE = 900;    // ms for heat to halve while you're not typing
  const PONDER_AFTER = 3500;    // ms of stillness with text in the box

  // An unbroken run of keys pays out here. Deliberately sparse — the point is
  // that a long fluent sentence *arrives* somewhere, not that it strobes.
  const MILESTONES = {
    25: (fx, p) => fx.fire('ripple', p.x, p.y, { palette: 'mint', scale: 0.7 }),
    60: (fx, p) => fx.fire('embers', p.x, p.y, { palette: 'ember', scale: 0.8 }),
    120: (fx, p) => fx.fire('fireworks', p.x, p.y, { palette: 'gold', scale: 0.6 }),
    200: (fx, p) => fx.fire('bloom', p.x, p.y, { palette: 'rose', scale: 0.7 }),
  };

  const rand = (a, b) => a + Math.random() * (b - a);
  const tierFor = (h) => { let t = TIERS[0]; for (const c of TIERS) if (h >= c.at) t = c; return t; };

  class FlourishInputFX {
    constructor(input, effects, row) {
      this.input = input;
      this.effects = effects;
      this.row = row || input.parentElement;
      this.heat = 0;
      this.keys = 0;          // keys typed in the current streak
      this.streak = 0;        // unbroken run, for milestones
      this.tierName = 'cool';
      this.enabled = true;
      this.measure = document.createElement('canvas').getContext('2d');
      this._decaying = false;
      this._ponderTimer = null;

      input.addEventListener('input', (e) => this._onInput(e));
      // Moving the caret with the arrow keys leaves a small wake, so the box
      // acknowledges navigation and not just insertion.
      input.addEventListener('keydown', (e) => {
        if (!this.enabled) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          const p = this.caret();
          this.effects.emit(p.x, p.y, {
            n: 2, colors: ['#4d6459', '#6f8a7d'], speedMin: 0.2, speedMax: 0.9,
            sizeMin: 0.6, sizeMax: 1.2, lifeMin: 150, lifeMax: 320, grav: 0.01, jitter: 1,
          });
        }
      });
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!on) this._setHeat(0);
    }

    /** Screen position of the text caret inside the input. */
    caret() {
      const inp = this.input;
      const cs = getComputedStyle(inp);
      const r = inp.getBoundingClientRect();
      this.measure.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const pos = (inp.selectionStart == null) ? inp.value.length : inp.selectionStart;
      const w = this.measure.measureText(inp.value.slice(0, pos)).width;
      const padLeft = parseFloat(cs.paddingLeft) || 0;
      const x = r.left + padLeft + w - inp.scrollLeft;
      return {
        // Clamp inside the box so a scrolled-past caret can't spray off-screen.
        x: Math.max(r.left, Math.min(x, r.right - 2)),
        y: r.top + r.height / 2,
      };
    }

    _onInput(e) {
      if (!this.enabled) return;
      const p = this.caret();
      const type = e.inputType || 'insertText';
      this._ponder(false);

      if (type.startsWith('delete')) {
        // Deleting is a small cold puff, and it cools the streak down.
        this.effects.emit(p.x, p.y, {
          n: 4, colors: ['#6f8a7d', '#ff5c7a', '#3f5349'],
          speedMin: 0.3, speedMax: 1.6, sizeMin: 0.8, sizeMax: 1.8,
          lifeMin: 180, lifeMax: 420, grav: 0.03, jitter: 2,
        });
        this._setHeat(Math.max(0, this.heat - HEAT_PER_KEY * 1.5));
        this.keys = 0; this.streak = 0;
        return;
      }

      if (type === 'insertFromPaste') {
        // Arriving text didn't come from your hands — give it its own gesture.
        this.effects.fire('constellation', p.x, p.y, { scale: 0.45, palette: 'ice' });
        this._setHeat(Math.min(1, this.heat + 0.25));
        this.streak = 0;
        return;
      }

      this.keys++; this.streak++;
      this._setHeat(Math.min(1, this.heat + HEAT_PER_KEY));
      const t = tierFor(this.heat);
      const ch = this._lastChar(e);

      this._paintKey(ch, p, t);

      // Crossing into a new tier is worth marking once, not every keystroke.
      if (t.name !== this.tierName) {
        const up = TIERS.findIndex((x) => x.name === t.name) > TIERS.findIndex((x) => x.name === this.tierName);
        this.tierName = t.name;
        this.row.dataset.heat = t.name;
        if (up && t.name === 'hot') this.effects.fire('ripple', p.x, p.y, { scale: 0.6, palette: 'gold' });
        if (up && t.name === 'blaze') this.effects.fire('embers', p.x, p.y, { scale: 0.7, palette: 'ember' });
        if (up && t.name === 'inferno') this.effects.fire('vortex', p.x, p.y, { scale: 0.35, palette: 'ember' });
      }
      // While blazing, keep a lick of flame going every so often.
      if ((t.name === 'blaze' || t.name === 'inferno') && this.keys % 9 === 0) {
        this.effects.fire('embers', p.x, p.y, { scale: 0.5, palette: 'ember' });
      }
      const m = MILESTONES[this.streak];
      if (m) m(this.effects, p);
      this._ponder(true);
    }

    /** The character that was just inserted, as best we can tell. */
    _lastChar(e) {
      if (e.data && e.data.length) return e.data[e.data.length - 1];
      const pos = this.input.selectionStart;
      return (pos > 0) ? this.input.value[pos - 1] : '';
    }

    // Route a keystroke to a flourish by what it is, not just how fast it came.
    _paintKey(ch, p, t) {
      const fx = this.effects;
      const base = {
        // Sparks fly up and out of the caret, so bias the cone upward.
        angle: -Math.PI / 2, spread: 1.5,
        speedMin: t.speed[0], speedMax: t.speed[1],
        sizeMin: t.size[0], sizeMax: t.size[1],
        lifeMin: 220, lifeMax: 560 + this.heat * 300,
        grav: 0.035 - this.heat * 0.03,   // hot sparks float, cold ones fall
        jitter: 2,
        halo: this.heat > 0.5 ? 8 : undefined,
        twinkle: this.heat > 0.74,
      };

      if (ch === '!') { fx.fire('spark', p.x, p.y, { scale: 0.4, palette: 'gold' }); return; }
      if (ch === '?') { fx.fire('ripple', p.x, p.y, { scale: 0.4, palette: 'ice' }); return; }

      if (ch === ' ') {
        // A word just landed. A longer word is worth a little more.
        const word = /(\S+)\s*$/.exec(this.input.value.slice(0, this.input.selectionStart));
        const len = word ? word[1].length : 0;
        fx.emit(p.x, p.y, { ...base, n: Math.min(9, 2 + (len >> 1)), colors: t.colors, speedMin: 0.3, speedMax: 1.5, spread: 2.4 });
        return;
      }
      if ('.,;:'.indexOf(ch) !== -1) {
        fx.emit(p.x, p.y, { ...base, n: 2, colors: ['#6f8a7d', '#7effc4'], speedMin: 0.2, speedMax: 1.0, lifeMin: 140, lifeMax: 300 });
        return;
      }
      if (ch >= '0' && ch <= '9') {
        fx.emit(p.x, p.y, { ...base, n: Math.round(rand(t.n[0], t.n[1])), colors: ['#37b6ff', '#8fd8ff', '#ffffff'] });
        return;
      }
      if (ch && ch !== ch.toLowerCase() && ch === ch.toUpperCase()) {
        // A capital letter starts something — make it land bigger.
        fx.emit(p.x, p.y, {
          ...base, n: Math.round(rand(t.n[0], t.n[1]) * 1.6), colors: ['#ffffff', ...t.colors],
          sizeMin: t.size[0] * 1.3, sizeMax: t.size[1] * 1.4, speedMax: t.speed[1] * 1.3,
        });
        return;
      }
      fx.emit(p.x, p.y, { ...base, n: Math.round(rand(t.n[0], t.n[1])), colors: t.colors });
    }

    // A written-but-unsent message shouldn't sit there inert.
    _ponder(arm) {
      clearTimeout(this._ponderTimer);
      this.row.classList.remove('pondering');
      if (!arm) return;
      this._ponderTimer = setTimeout(() => {
        if (this.input.value.trim()) this.row.classList.add('pondering');
      }, PONDER_AFTER);
    }

    /** Called by the renderer when a message is sent — spends the heat. */
    launch() {
      const p = this.caret();
      const r = this.input.getBoundingClientRect();
      const at = { x: Math.max(p.x, r.left + 12), y: p.y };
      this._ponder(false);
      if (this.heat >= 0.92) this.effects.fire('nova', at.x, at.y, { palette: 'ember' });
      else if (this.heat >= 0.74) this.effects.fire('nova', at.x, at.y, { scale: 0.6, palette: 'gold' });
      else if (this.heat >= 0.50) this.effects.fire('fireworks', at.x, at.y, { palette: 'gold' });
      else if (this.heat >= 0.24) this.effects.fire('spark', at.x, at.y, { scale: 1.4, palette: 'mint' });
      else this.effects.fire('spark', at.x, at.y);
      this._setHeat(0);
      this.keys = 0; this.streak = 0;
    }

    _setHeat(h) {
      this.heat = h;
      this.row.style.setProperty('--heat', h.toFixed(3));
      if (h <= 0.001) {
        this.tierName = 'cool';
        delete this.row.dataset.heat;
      }
      this._startDecay();
    }

    _startDecay() {
      if (this._decaying || this.heat <= 0.001) return;
      this._decaying = true;
      let last = performance.now();
      const step = (now) => {
        const dt = now - last; last = now;
        this.heat *= Math.pow(0.5, dt / HEAT_HALFLIFE);
        if (this.heat <= 0.01) {
          this._decaying = false;
          this.heat = 0;
          this.row.style.setProperty('--heat', '0');
          this.tierName = 'cool';
          delete this.row.dataset.heat;
          return;
        }
        this.row.style.setProperty('--heat', this.heat.toFixed(3));
        const t = tierFor(this.heat);
        if (t.name !== this.tierName) { this.tierName = t.name; this.row.dataset.heat = t.name; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }

  window.FlourishInputFX = FlourishInputFX;
})();
