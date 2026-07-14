/*
 * inputfx.js — flourishes on the prompt box while you type.
 *
 * Classic browser script: attaches window.FlourishInputFX.
 *
 * Every inserted character throws a small spark off the caret. Typing fast
 * builds "heat" (which decays whenever you pause), and heat drives the tier of
 * the sparks — from a couple of cool green flecks up to a blazing orange
 * plume — plus a glow on the input row itself. Sending spends the heat: a hot
 * streak launches with a nova instead of a spark.
 *
 * Finding the caret's screen position inside an <input> is the only fiddly
 * part: there's no Range API for form fields, so we measure the text before the
 * caret with the input's own computed font on a scratch canvas and offset by
 * the box's padding and scroll.
 */
(function () {
  'use strict';

  const TIERS = [
    { at: 0.00, name: 'cool',  n: [2, 4],  speed: [0.5, 2.2], size: [0.8, 1.8], colors: ['#35f0a0', '#7effc4', '#ffffff'] },
    { at: 0.30, name: 'warm',  n: [4, 7],  speed: [0.7, 3.0], size: [1.0, 2.2], colors: ['#7effc4', '#37b6ff', '#ffffff', '#ffd27a'] },
    { at: 0.62, name: 'hot',   n: [6, 10], speed: [0.9, 3.8], size: [1.2, 2.6], colors: ['#ffd27a', '#ff9d3c', '#ffffff', '#35f0a0'] },
    { at: 0.86, name: 'blaze', n: [9, 14], speed: [1.2, 4.6], size: [1.4, 3.0], colors: ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ffffff'] },
  ];

  const HEAT_PER_KEY = 0.075;   // ~13 quick keys to go from cold to blazing
  const HEAT_HALFLIFE = 900;    // ms for heat to halve while you're not typing

  const rand = (a, b) => a + Math.random() * (b - a);
  const tierFor = (h) => { let t = TIERS[0]; for (const c of TIERS) if (h >= c.at) t = c; return t; };

  class FlourishInputFX {
    constructor(input, effects, row) {
      this.input = input;
      this.effects = effects;
      this.row = row || input.parentElement;
      this.heat = 0;
      this.keys = 0;          // keys typed in the current streak
      this.tierName = 'cool';
      this.enabled = true;
      this.measure = document.createElement('canvas').getContext('2d');
      this._decaying = false;

      input.addEventListener('input', (e) => this._onInput(e));
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

      if (type.startsWith('delete')) {
        // Deleting is a small cold puff, and it cools the streak down.
        this.effects.emit(p.x, p.y, {
          n: 4, colors: ['#6f8a7d', '#ff5c7a', '#3f5349'],
          speedMin: 0.3, speedMax: 1.6, sizeMin: 0.8, sizeMax: 1.8,
          lifeMin: 180, lifeMax: 420, grav: 0.03, jitter: 2,
        });
        this._setHeat(Math.max(0, this.heat - HEAT_PER_KEY * 1.5));
        this.keys = 0;
        return;
      }

      if (type === 'insertFromPaste') {
        this.effects.fire('ripple', p.x, p.y);
        this.effects.emit(p.x, p.y, { n: 26, speedMin: 1, speedMax: 5, lifeMin: 400, lifeMax: 900, jitter: 3 });
        this._setHeat(Math.min(1, this.heat + 0.25));
        return;
      }

      this.keys++;
      this._setHeat(Math.min(1, this.heat + HEAT_PER_KEY));
      const t = tierFor(this.heat);

      this.effects.emit(p.x, p.y, {
        n: Math.round(rand(t.n[0], t.n[1])),
        colors: t.colors,
        // Sparks fly up and out of the caret, so bias the cone upward.
        angle: -Math.PI / 2, spread: 1.5,
        speedMin: t.speed[0], speedMax: t.speed[1],
        sizeMin: t.size[0], sizeMax: t.size[1],
        lifeMin: 220, lifeMax: 560 + this.heat * 300,
        grav: 0.035 - this.heat * 0.03,   // hot sparks float, cold ones fall
        jitter: 2,
      });

      // Crossing into a new tier is worth marking once, not every keystroke.
      if (t.name !== this.tierName) {
        const up = TIERS.findIndex((x) => x.name === t.name) > TIERS.findIndex((x) => x.name === this.tierName);
        this.tierName = t.name;
        this.row.dataset.heat = t.name;
        if (up && t.name === 'hot') this.effects.fire('ripple', p.x, p.y);
        if (up && t.name === 'blaze') this.effects.fire('embers', p.x, p.y);
      }
      // While blazing, keep a lick of flame going every so often.
      if (t.name === 'blaze' && this.keys % 9 === 0) this.effects.fire('embers', p.x, p.y);
    }

    /** Called by the renderer when a message is sent — spends the heat. */
    launch() {
      const p = this.caret();
      const r = this.input.getBoundingClientRect();
      const at = { x: Math.max(p.x, r.left + 12), y: p.y };
      if (this.heat >= 0.86) this.effects.fire('nova', at.x, at.y);
      else if (this.heat >= 0.62) this.effects.fire('fireworks', at.x, at.y);
      else this.effects.fire('spark', at.x, at.y);
      this._setHeat(0);
      this.keys = 0;
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
