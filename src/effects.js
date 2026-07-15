/*
 * effects.js — the canvas particle engine and full-screen effects.
 *
 * Classic browser script: attaches window.FlourishEffects. The renderer creates
 * one instance over the overlay canvas and calls fire(name, x, y, opts) at the
 * caret position when the parser reports a point effect.
 *
 * Drawing model: most particles are drawn additively ('lighter') so overlapping
 * ones bloom into each other instead of muddying — that plus a cached glow
 * sprite is what makes a burst read as light rather than as confetti dots.
 * Opaque shapes (confetti rects, glass shards) opt out via `solid: true`.
 *
 * Variety comes from three places, in increasing cost:
 *   1. VARIANTS — most effects pick one of several structural forms at random,
 *      so the same directive never paints the same picture twice. Free.
 *   2. ARGS — `{{fx:spark gold lg}}` recolours and resizes. The renderer parses
 *      these (Flourish.parseArgs) and passes {palette, scale}.
 *   3. New effect names, which cost system-prompt tokens on every request and
 *      so are added deliberately rather than freely.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  // Named palettes, addressable from a directive: `{{fx:spark gold}}`.
  const PALETTES = {
    mint:   ['#35f0a0', '#7effc4', '#ffffff', '#37b6ff'],
    ice:    ['#ffffff', '#dff3ff', '#8fd8ff', '#37b6ff'],
    gold:   ['#fff3b0', '#ffd27a', '#ffb14e', '#ff9d3c'],
    ember:  ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ff3860'],
    violet: ['#b47cff', '#d9b8ff', '#7a5cff', '#37b6ff'],
    rose:   ['#ff5c7a', '#ffb3c4', '#ff2d6f', '#ffd27a'],
    mono:   ['#ffffff', '#cfe9d8', '#9fb8ab'],
  };
  const PARTY = ['#35f0a0', '#37b6ff', '#ffd27a', '#ff5c7a', '#b47cff', '#7effc4'];
  const FIRE = PALETTES.ember;
  const ICE = PALETTES.ice;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];
  const chance = (p) => Math.random() < p;
  // Pick one of `n` structural variants. Kept as a named helper so it's obvious
  // at each call site that the effect deliberately differs run to run.
  const variant = (n) => (Math.random() * n) | 0;

  // Glow sprites.
  //
  // The obvious way to halo a particle is ctx.shadowBlur, but Chromium
  // rasterizes canvas2d shadows on the CPU, per draw call — with 180 glowing
  // particles that measured ~6fps (vs ~70fps for the same count of un-blurred
  // confetti rects). Instead each colour gets its radial falloff baked into a
  // 64px offscreen canvas once, and every particle is a single drawImage of it.
  const _sprites = new Map();
  const _rgb = (hex) => {
    let h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const n = parseInt(h, 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  };
  function glowSprite(color) {
    let s = _sprites.get(color);
    if (s) return s;
    const R = 32;
    s = document.createElement('canvas');
    s.width = s.height = R * 2;
    const g = s.getContext('2d');
    const rgb = _rgb(color);
    const grad = g.createRadialGradient(R, R, 0, R, R, R);
    grad.addColorStop(0.00, 'rgba(255,255,255,0.95)'); // hot core
    grad.addColorStop(0.16, `rgba(${rgb},0.95)`);
    grad.addColorStop(0.42, `rgba(${rgb},0.32)`);
    grad.addColorStop(1.00, `rgba(${rgb},0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, R * 2, R * 2);
    _sprites.set(color, s);
    return s;
  }

  // Hard cap: a runaway effect (or an over-caffeinated typist) must never be
  // able to grind the frame rate down. Oldest particles are shed first.
  const MAX_PARTICLES = 16000;

  class FlourishEffects {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = window.devicePixelRatio || 1;
      this.particles = [];
      this.rings = [];
      this.bolts = [];
      this.sheets = [];   // aurora curtains
      this.sweeps = [];   // sonar arcs + beam scanlines
      this.links = null;  // constellation
      this.frost = null;  // creeping ice
      this.matrix = null;
      this.running = false;
      this._resize = this._resize.bind(this);
      this._resize();
      window.addEventListener('resize', this._resize);
    }

    _resize() {
      this.dpr = window.devicePixelRatio || 1;
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.canvas.width = Math.floor(this.w * this.dpr);
      this.canvas.height = Math.floor(this.h * this.dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    /**
     * Fire a named point effect at (x, y).
     * `opts` is {palette, scale} as parsed from the directive's args by
     * Flourish.parseArgs — both optional.
     */
    fire(name, x, y, opts) {
      x = (typeof x === 'number') ? x : this.w / 2;
      y = (typeof y === 'number') ? y : this.h / 2;
      const o = opts || {};
      // Resolve the palette once here so every effect below can just read o.pal.
      o.scale = o.scale || 1;
      o.pal = (o.palette && PALETTES[o.palette]) || null;
      switch (name) {
        case 'spark': this._spark(x, y, o); break;
        case 'confetti': this._confetti(o); break;
        case 'fireworks': this._firework(x, y, o); break;
        case 'ripple': this._ripple(x, y, o); break;
        case 'matrix': this._matrix(o); break;
        case 'pulse': this._pulse(o); break;
        case 'shake': this._shake(); break;
        case 'lightning': this._lightning(x, y, o); break;
        case 'nova': this._nova(x, y, o); break;
        case 'meteor': this._meteor(o); break;
        case 'embers': this._embers(x, y, o); break;
        case 'vortex': this._vortex(x, y, o); break;
        case 'glitch': this._glitch(); break;
        case 'aurora': this._aurora(o); break;
        case 'constellation': this._constellation(x, y, o); break;
        case 'shatter': this._shatter(x, y, o); break;
        case 'swarm': this._swarm(x, y, o); break;
        case 'sonar': this._sonar(x, y, o); break;
        case 'warp': this._warp(x, y, o); break;
        case 'frost': this._frost(o); break;
        case 'bloom': this._bloom(x, y, o); break;
        case 'rain': this._rain(o); break;
        case 'beam': this._beam(o); break;
        case 'implode': this._implode(x, y, o); break;
        default: return;
      }
      this._ensureRunning();
    }

    /**
     * Public particle emitter — the small, composable burst the input-box
     * typing layer builds on. Everything is optional but `x`/`y`.
     */
    emit(x, y, opts) {
      const o = opts || {};
      const n = o.n || 8;
      const colors = o.colors || ['#35f0a0', '#7effc4', '#ffffff'];
      for (let i = 0; i < n; i++) {
        const a = (o.angle != null) ? o.angle + rand(-(o.spread || 0.6), o.spread || 0.6) : rand(0, TAU);
        const sp = rand(o.speedMin || 0.6, o.speedMax || 3);
        this.particles.push({
          x: x + rand(-(o.jitter || 0), o.jitter || 0),
          y: y + rand(-(o.jitter || 0), o.jitter || 0),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(o.lifeMin || 260, o.lifeMax || 620),
          size: rand(o.sizeMin || 1, o.sizeMax || 2.4),
          color: pick(colors),
          grav: (o.grav != null) ? o.grav : 0.02,
          drag: o.drag || 0.98,
          shape: o.shape || 'dot',
          halo: o.halo,
          twinkle: o.twinkle,
          sway: o.sway, swayPhase: o.sway ? rand(0, TAU) : 0,
          len: o.len,
        });
      }
      this._ensureRunning();
    }

    // ---- point / particle effects ----

    // Four forms: an even radial burst, an upward fan, a crackling double-pop,
    // and a tight ring that snaps outward.
    _spark(x, y, o) {
      const cols = o.pal || ['#35f0a0', '#7effc4', '#ffffff', '#37b6ff'];
      const s = o.scale;
      const n = Math.round(64 * s);
      switch (variant(4)) {
        case 0: // even radial
          for (let i = 0; i < n; i++) {
            const a = rand(0, TAU), sp = rand(1.5, 7.5) * s;
            this._dot(x, y, a, sp, cols, { max: rand(420, 900), size: rand(1.5, 3.8) * s, grav: 0.04, drag: 0.99 });
          }
          break;
        case 1: // upward fan
          for (let i = 0; i < n; i++) {
            const a = -Math.PI / 2 + rand(-0.9, 0.9), sp = rand(2, 8) * s;
            this._dot(x, y, a, sp, cols, { max: rand(400, 820), size: rand(1.2, 3.4) * s, grav: 0.07, drag: 0.985 });
          }
          break;
        case 2: { // crackle: a core pop plus a delayed second crackle
          for (let i = 0; i < n * 0.6; i++) {
            const a = rand(0, TAU), sp = rand(0.6, 3.4) * s;
            this._dot(x, y, a, sp, cols, { max: rand(300, 640), size: rand(1, 2.6) * s, grav: 0.02, drag: 0.97, twinkle: true });
          }
          for (let i = 0; i < n * 0.5; i++) {
            const a = rand(0, TAU), sp = rand(3, 9) * s;
            this._dot(x, y, a, sp, cols, { max: rand(360, 700), size: rand(1.2, 3) * s, grav: 0.05, drag: 0.99, delay: rand(90, 220) });
          }
          break;
        }
        default: { // ring snap — all at one speed, so it reads as a shell
          const sp = rand(4, 6) * s;
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU + rand(-0.05, 0.05);
            this._dot(x, y, a, sp * rand(0.92, 1.08), cols, { max: rand(480, 760), size: rand(1.4, 2.8) * s, grav: 0.03, drag: 0.982 });
          }
        }
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 420, grow: 0.9 * s, color: _rgb(cols[0]), width: 2 });
    }

    // Small helper for the common "one glowing dot on a heading" push.
    _dot(x, y, a, sp, cols, extra) {
      const p = {
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: 600, size: 2, color: pick(cols),
        grav: 0.03, drag: 0.99, shape: 'dot', halo: 12,
      };
      if (extra) Object.assign(p, extra);
      this.particles.push(p);
    }

    // Three forms: the classic double shell, a willow that droops under gravity,
    // and a ring-with-heart.
    _firework(x, y, o) {
      const s = o.scale;
      const hue = o.pal ? pick(o.pal) : pick(PARTY);
      const hue2 = o.pal ? pick(o.pal) : pick(PARTY);
      const cols = o.pal || PARTY;
      const v = variant(3);

      if (v === 0) { // two nested shells + glitter
        for (const shell of [{ n: 170, sp: [2, 9], size: [1.5, 3.2], c: hue },
                             { n: 90, sp: [1, 4], size: [1, 2.2], c: hue2 }]) {
          for (let i = 0; i < shell.n * s; i++) {
            const a = rand(0, TAU), sp = rand(shell.sp[0], shell.sp[1]) * s;
            this._dot(x, y, a, sp, [shell.c], {
              max: rand(700, 1500), size: rand(shell.size[0], shell.size[1]) * s,
              color: chance(0.3) ? '#ffffff' : shell.c,
              grav: 0.06, drag: 0.985, twinkle: chance(0.4),
            });
          }
        }
      } else if (v === 1) { // willow — slow, heavy, drooping trails
        for (let i = 0; i < 200 * s; i++) {
          const a = rand(0, TAU), sp = rand(1.5, 6) * s;
          this._dot(x, y, a, sp, cols, {
            max: rand(1400, 2400), size: rand(1.4, 3) * s,
            grav: 0.14, drag: 0.988, twinkle: chance(0.6),
          });
        }
      } else { // ring + heart: a crisp outer shell around a dense core
        const sp0 = rand(6, 8) * s;
        for (let i = 0; i < 150 * s; i++) {
          const a = (i / (150 * s)) * TAU;
          this._dot(x, y, a, sp0 * rand(0.94, 1.06), [hue], {
            max: rand(900, 1400), size: rand(1.6, 2.8) * s, grav: 0.05, drag: 0.987,
          });
        }
        for (let i = 0; i < 90 * s; i++) {
          const a = rand(0, TAU), sp = rand(0.4, 2.4) * s;
          this._dot(x, y, a, sp, [hue2, '#ffffff'], {
            max: rand(600, 1100), size: rand(1, 2.2) * s, grav: 0.04, drag: 0.97, twinkle: true,
          });
        }
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 520, grow: 1.6 * s, color: '255,255,255', width: 2 });
    }

    // Three forms: rain from the top, a burst up from the caret, and a sweep in
    // from one side.
    _confetti(o) {
      const cols = o.pal || PARTY;
      const n = Math.round(420 * o.scale);
      const v = variant(3);
      for (let i = 0; i < n; i++) {
        const base = {
          life: 0, max: rand(1800, 3000), size: rand(4, 9) * o.scale,
          color: pick(cols), grav: 0.03, shape: 'rect', solid: true,
          rot: rand(0, TAU), vr: rand(-0.25, 0.25),
          sway: rand(0.01, 0.04), swayPhase: rand(0, TAU),
        };
        if (v === 0) {
          this.particles.push({ ...base, x: rand(0, this.w), y: rand(-260, -6), vx: rand(-1.6, 1.6), vy: rand(1.5, 4.5) });
        } else if (v === 1) { // cannon up from the bottom centre
          const a = -Math.PI / 2 + rand(-0.6, 0.6), sp = rand(9, 19);
          this.particles.push({ ...base, x: this.w / 2 + rand(-70, 70), y: this.h + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, grav: 0.16, drag: 0.995 });
        } else { // side sweep
          const left = chance(0.5);
          const a = (left ? 0 : Math.PI) + rand(-0.45, 0.45);
          const sp = rand(7, 15);
          this.particles.push({ ...base, x: left ? -20 : this.w + 20, y: rand(0, this.h * 0.5), vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2, grav: 0.11, drag: 0.996 });
        }
      }
    }

    // Three forms: concentric rings, one wide slow ring, and an off-centre pair.
    _ripple(x, y, o) {
      const c = o.pal ? _rgb(o.pal[0]) : '53,240,160';
      const s = o.scale;
      switch (variant(3)) {
        case 0:
          for (let k = 0; k < 5; k++) {
            this.rings.push({ x, y, r: 4 + k * 6, life: 0, max: 900 + k * 140, color: c, width: 2, grow: 0.6 * s, delay: k * 60 });
          }
          break;
        case 1:
          this.rings.push({ x, y, r: 4, life: 0, max: 1500, color: c, width: 3.5, grow: 0.35 * s });
          this.rings.push({ x, y, r: 4, life: 0, max: 1100, color: '255,255,255', width: 1, grow: 0.5 * s, delay: 120 });
          break;
        default:
          for (let k = 0; k < 3; k++) {
            const ox = rand(-26, 26), oy = rand(-10, 10);
            this.rings.push({ x: x + ox, y: y + oy, r: 3, life: 0, max: 800 + k * 200, color: k % 2 ? '55,182,255' : c, width: 2, grow: rand(0.5, 0.9) * s, delay: k * 110 });
          }
      }
    }

    // Falling katakana. Variants change the density and direction of the rain.
    _matrix(o) {
      const v = variant(3);
      const spacing = v === 1 ? 9 : 14;           // 1 = dense
      const cols = Math.floor(this.w / spacing);
      const drops = [];
      for (let i = 0; i < cols; i++) {
        drops.push({
          x: i * spacing + 4,
          y: rand(-this.h, 0),
          sp: (v === 2 ? rand(1.5, 5) : rand(4, 12)) * o.scale,  // 2 = slow drift
          len: 6 + ((Math.random() * 10) | 0),
        });
      }
      this.matrix = { drops, life: 0, max: v === 2 ? 3200 : 2200, color: o.pal ? _rgb(o.pal[0]) : '53,240,160' };
    }

    // A bolt from the top of the screen down to the caret, with branches,
    // an impact burst and a cold-white flash. Variants: single strike, forked
    // double strike, and a ground-up discharge.
    _lightning(x, y, o) {
      const v = variant(3);
      const strikes = v === 1 ? 2 : 1;
      for (let k = 0; k < strikes; k++) {
        const fromBelow = v === 2;
        const startX = x + rand(-140, 140) + k * rand(-90, 90);
        const startY = fromBelow ? this.h + 10 : -10;
        const segs = 16;
        const pts = [{ x: startX, y: startY }];
        for (let i = 1; i <= segs; i++) {
          const t = i / segs;
          pts.push({
            x: startX + (x - startX) * t + rand(-30, 30) * (1 - t * 0.7),
            y: startY + (y - startY) * t,
          });
        }
        pts[pts.length - 1] = { x, y };

        const branches = [];
        for (let b = 0; b < 3; b++) {
          const i = 3 + ((Math.random() * (segs - 5)) | 0);
          const bp = [pts[i]];
          let bx = pts[i].x, by = pts[i].y;
          for (let n = 0; n < 4; n++) { bx += rand(-34, 34); by += rand(12, 38) * (fromBelow ? -1 : 1); bp.push({ x: bx, y: by }); }
          branches.push(bp);
        }
        this.bolts.push({ pts, branches, life: 0, max: 420, delay: k * 110, color: o.pal ? _rgb(o.pal[0]) : null });
      }
      this._flash(o.pal ? `rgba(${_rgb(o.pal[0])},0.5)` : 'rgba(200,238,255,0.55)');
      const cols = o.pal || ICE;
      for (let i = 0; i < 50 * o.scale; i++) {
        const a = rand(-Math.PI, 0), sp = rand(1, 6) * o.scale;
        this._dot(x, y, a, sp, cols, { vy: Math.sin(a) * sp * 0.6, max: rand(300, 700), size: rand(1, 3) * o.scale, grav: 0.08, drag: 0.97 });
      }
    }

    // The big one: white core flash, expanding shockwave rings, huge radial
    // burst. Variants change the shell structure, not the scale of the moment.
    _nova(x, y, o) {
      const s = o.scale;
      const cols = o.pal || ['#35f0a0', '#7effc4', '#37b6ff'];
      this._flash(o.pal ? `rgba(${_rgb(o.pal[0])},0.55)` : 'rgba(255,255,255,0.6)');
      this.rings.push({ x, y, r: 6, life: 0, max: 850, grow: 5.5 * s, color: '255,255,255', width: 4 });
      this.rings.push({ x, y, r: 2, life: 0, max: 1050, grow: 3.6 * s, color: _rgb(cols[0]), width: 2, delay: 90 });
      this.rings.push({ x, y, r: 2, life: 0, max: 1200, grow: 2.4 * s, color: _rgb(cols[cols.length - 1]), width: 1.5, delay: 200 });

      const n = Math.round(520 * s);
      const v = variant(3);
      for (let i = 0; i < n; i++) {
        // v0 even sphere · v1 layered shells · v2 spiked star
        let a = rand(0, TAU);
        let sp = rand(2, 13);
        if (v === 1) sp = pick([3, 7, 11]) * rand(0.9, 1.1);
        if (v === 2) { const spikes = 9; a = Math.round(a / (TAU / spikes)) * (TAU / spikes) + rand(-0.09, 0.09); sp = rand(4, 15); }
        this._dot(x, y, a, sp * s, cols, {
          max: rand(600, 1500), size: rand(1.2, 3.6) * s,
          color: chance(0.45) ? '#ffffff' : pick(cols),
          grav: 0.02, drag: 0.972, halo: 14, twinkle: chance(0.3),
        });
      }
      this._shake();
    }

    // Shooting stars, drawn as tapered streaks. Variants: the classic diagonal
    // shower, a horizontal fly-by, and a single slow bright one.
    _meteor(o) {
      const cols = o.pal || ['#ffffff', '#dff3ff', '#7effc4', '#ffd27a'];
      const v = variant(3);
      const n = v === 2 ? 1 : Math.round((9 + ((Math.random() * 8) | 0)) * o.scale);
      for (let i = 0; i < n; i++) {
        const sp = (v === 2 ? rand(4, 6) : rand(9, 17)) * o.scale;
        const a = v === 1 ? rand(-0.05, 0.05) : rand(Math.PI * 0.14, Math.PI * 0.28);
        this.particles.push({
          x: v === 1 ? -80 : rand(-this.w * 0.25, this.w * 0.8),
          y: v === 1 ? rand(this.h * 0.1, this.h * 0.7) : rand(-140, this.h * 0.35),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(900, 1500) * (v === 2 ? 1.8 : 1), size: rand(1.6, 3) * o.scale,
          color: pick(cols),
          grav: 0, shape: 'streak', len: rand(40, 110) * (v === 2 ? 2 : 1) * o.scale, halo: 12,
          delay: i * rand(40, 220),
        });
      }
    }

    // Rising, flickering embers with a sideways wobble. Variants: a plume from
    // the caret, a wide hearth along the bottom, and a lazy updraft.
    _embers(x, y, o) {
      const cols = o.pal || FIRE;
      const s = o.scale;
      const v = variant(3);
      const n = Math.round(90 * s);
      for (let i = 0; i < n; i++) {
        const wide = v === 1;
        this.particles.push({
          x: wide ? rand(0, this.w) : x + rand(-30, 30) * s,
          y: wide ? this.h - rand(0, 24) : y + rand(-6, 14),
          vx: rand(-0.35, 0.35), vy: rand(-2.4, -0.7) * (v === 2 ? 0.5 : 1),
          life: 0, max: rand(1100, 2200) * (v === 2 ? 1.6 : 1), size: rand(1, 3) * s,
          color: pick(cols), grav: -0.008, drag: 0.995, shape: 'dot', halo: 12,
          sway: rand(0.015, 0.05), swayPhase: rand(0, TAU), twinkle: true,
        });
      }
    }

    // Particles swept in on a spiral, then flung back out.
    _vortex(x, y, o) {
      const cols = o.pal || ['#b47cff', '#37b6ff', '#7effc4', '#ffffff'];
      const s = o.scale;
      const dir = chance(0.5) ? -1 : 1;              // variant: spin direction
      const tight = chance(0.5);                     // variant: tight or wide
      const n = Math.round(220 * s);
      for (let i = 0; i < n; i++) {
        const ang = rand(0, TAU);
        const rad = tight ? rand(60, 150) * s : rand(90, 260) * s;
        this.particles.push({
          mode: 'polar', cx: x, cy: y, ang, rad,
          vang: rand(0.06, 0.13) * (tight ? 1.6 : 1) * dir,
          vrad: rand(-2.6, -1.3),
          x: x + Math.cos(ang) * rad, y: y + Math.sin(ang) * rad,
          life: 0, max: rand(700, 1150), size: rand(1.2, 3) * s,
          color: pick(cols), shape: 'dot', halo: 12,
        });
      }
      this.rings.push({ x, y, r: 240 * s, life: 0, max: 900, grow: -2.2, color: _rgb(cols[0]), width: 2 });
      // The collapse pays off with a burst at the centre.
      setTimeout(() => { this._spark(x, y, { scale: s, pal: cols }); this._flash(`rgba(${_rgb(cols[0])},0.4)`); this._ensureRunning(); }, 780);
    }

    // ---- new effects ----

    // Slow curtains of light drifting across the upper screen. Ambient and
    // quiet — the opposite end of the register from nova.
    _aurora(o) {
      const cols = o.pal || ['#35f0a0', '#37b6ff', '#b47cff'];
      const n = 3 + variant(3);   // 3-5 curtains
      for (let k = 0; k < n; k++) {
        this.sheets.push({
          y: rand(0.08, 0.52) * this.h,
          band: rand(90, 200) * o.scale,
          phase: rand(0, TAU),
          freq: rand(0.004, 0.011),
          amp: rand(18, 56) * o.scale,
          drift: rand(0.0006, 0.0022) * (chance(0.5) ? -1 : 1),
          color: _rgb(pick(cols)),
          life: 0, max: rand(2800, 4400), delay: k * 220,
        });
      }
    }

    // Dots that find each other: nearby points link with lines, so the picture
    // assembles itself. Reads as "connecting the pieces".
    _constellation(x, y, o) {
      const cols = o.pal || ['#7effc4', '#37b6ff', '#ffffff'];
      const n = Math.round(70 * o.scale);
      const spread = (chance(0.5) ? 190 : 320) * o.scale;   // variant: tight or wide
      const pts = [];
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), r = Math.sqrt(Math.random()) * spread;
        pts.push({
          x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
          vx: rand(-0.22, 0.22), vy: rand(-0.22, 0.22),
          size: rand(1.2, 2.6) * o.scale, color: pick(cols),
        });
      }
      this.links = { pts, life: 0, max: 3000, dist: 118 * o.scale, color: _rgb(cols[0]) };
    }

    // Glass breaking: opaque shards spin outward from a bright crack.
    _shatter(x, y, o) {
      const cols = o.pal || ['#dff3ff', '#8fd8ff', '#b8d8ff', '#ffffff'];
      const s = o.scale;
      const n = Math.round(90 * s);
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), sp = rand(2, 11) * s;
        this.particles.push({
          x: x + rand(-6, 6), y: y + rand(-6, 6),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - rand(0, 2),
          life: 0, max: rand(800, 1600), size: rand(4, 13) * s,
          color: pick(cols), grav: 0.19, drag: 0.997,
          shape: 'shard', solid: true,
          rot: rand(0, TAU), vr: rand(-0.4, 0.4),
          verts: 3 + ((Math.random() * 2) | 0),
        });
      }
      // The flash of the impact itself, plus glittering dust.
      for (let i = 0; i < 70 * s; i++) {
        const a = rand(0, TAU), sp = rand(1, 6) * s;
        this._dot(x, y, a, sp, cols, { max: rand(400, 900), size: rand(0.8, 2) * s, grav: 0.06, drag: 0.98, twinkle: true });
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 380, grow: 2.4 * s, color: '223,243,255', width: 2 });
      this._shake();
    }

    // Fireflies: they wander, they twinkle, they take their time. The one
    // effect that lingers — good for "lots of things happening at once".
    _swarm(x, y, o) {
      const cols = o.pal || ['#7effc4', '#35f0a0', '#ffd27a', '#ffffff'];
      const n = Math.round(120 * o.scale);
      const wide = chance(0.5);   // variant: around the caret, or across the screen
      for (let i = 0; i < n; i++) {
        this.particles.push({
          mode: 'wander',
          x: wide ? rand(0, this.w) : x + rand(-120, 120) * o.scale,
          y: wide ? rand(0, this.h) : y + rand(-70, 70) * o.scale,
          vx: rand(-0.4, 0.4), vy: rand(-0.4, 0.4),
          wphase: rand(0, TAU), wfreq: rand(0.0012, 0.004), wamp: rand(0.02, 0.07),
          life: 0, max: rand(1800, 3400), size: rand(1, 2.6) * o.scale,
          color: pick(cols), shape: 'dot', halo: 12, twinkle: true,
          delay: rand(0, 500),
        });
      }
    }

    // A radar sweep: expanding rings plus a rotating radius that trails an arc.
    _sonar(x, y, o) {
      const c = o.pal ? _rgb(o.pal[0]) : '53,240,160';
      const R = Math.max(this.w, this.h) * 0.62 * o.scale;
      this.sweeps.push({
        kind: 'sonar', x, y, r: R, color: c,
        from: rand(0, TAU), turns: chance(0.5) ? 1 : 2,   // variant: one or two passes
        dir: chance(0.5) ? -1 : 1,
        life: 0, max: 2200,
      });
      for (let k = 0; k < 3; k++) {
        this.rings.push({ x, y, r: 4, life: 0, max: 1600, grow: 1.1 * o.scale, color: c, width: 1.5, delay: k * 420 });
      }
    }

    // Hyperspace: a starfield rushing outward past the viewer.
    _warp(x, y, o) {
      const cols = o.pal || ['#ffffff', '#dff3ff', '#8fd8ff', '#b47cff'];
      const n = Math.round(260 * o.scale);
      const inward = chance(0.35);   // variant: occasionally we fly backwards
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU);
        const r0 = inward ? rand(this.w * 0.4, this.w * 0.7) : rand(10, 90);
        const sp = (inward ? -1 : 1) * rand(4, 16) * o.scale;
        this.particles.push({
          x: x + Math.cos(a) * r0, y: y + Math.sin(a) * r0,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          accel: inward ? 0.97 : 1.045,     // stars speed up as they pass you
          life: 0, max: rand(700, 1300), size: rand(1, 2.6) * o.scale,
          color: pick(cols), grav: 0, shape: 'streak', len: rand(12, 40), halo: 10,
          delay: rand(0, 260),
        });
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 700, grow: 3.2 * o.scale, color: '255,255,255', width: 1.5 });
    }

    // Ice creeping in from the edges of the screen, branch by branch.
    _frost(o) {
      const c = o.pal ? _rgb(o.pal[0]) : '143,216,255';
      const seeds = Math.round((10 + variant(8)) * o.scale);
      const crystals = [];
      for (let i = 0; i < seeds; i++) {
        // Start on a random edge, growing inward.
        const edge = (Math.random() * 4) | 0;
        let x, y, a;
        if (edge === 0) { x = rand(0, this.w); y = -4; a = Math.PI / 2; }
        else if (edge === 1) { x = rand(0, this.w); y = this.h + 4; a = -Math.PI / 2; }
        else if (edge === 2) { x = -4; y = rand(0, this.h); a = 0; }
        else { x = this.w + 4; y = rand(0, this.h); a = Math.PI; }
        crystals.push(...this._branch(x, y, a + rand(-0.4, 0.4), rand(40, 110) * o.scale, 4, 0));
      }
      this.frost = { segs: crystals, life: 0, max: 2800, color: c };
    }

    // Recursive ice branch: returns flat line segments, each tagged with the
    // fraction of the effect's life at which it should appear.
    _branch(x, y, a, len, depth, at) {
      if (depth <= 0 || at > 1) return [];
      const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
      const segs = [{ x1: x, y1: y, x2, y2, at, w: depth * 0.5 }];
      const next = at + rand(0.08, 0.18);
      const forks = depth > 2 ? 2 : 1;
      for (let i = 0; i < forks; i++) {
        segs.push(...this._branch(x2, y2, a + rand(-0.75, 0.75), len * rand(0.5, 0.78), depth - 1, next));
      }
      return segs;
    }

    // Petals unfurling along a rose curve — organic, unlike everything else here.
    _bloom(x, y, o) {
      const cols = o.pal || ['#ff5c7a', '#ffb3c4', '#ffd27a', '#7effc4'];
      // r = R·|cos(k·θ)| draws 2k lobes, so k=2..4 gives a 4-, 6- or 8-petalled
      // flower. More than that and the petals are too thin to read.
      const k = 2 + variant(3);
      const n = Math.round(440 * o.scale);
      const R = rand(130, 185) * o.scale;
      const spin = rand(-0.0004, 0.0004);
      for (let i = 0; i < n; i++) {
        const t = i / n;
        this.particles.push({
          mode: 'rose', cx: x, cy: y, ang: rand(0, TAU), k, R, spin,
          // Without this the particles all land exactly ON the curve and the
          // flower reads as a spoked starburst. Scattering them under it fills
          // the petals in; sqrt biases them outward, so the rim stays defined.
          rfrac: Math.sqrt(rand(0.04, 1)),
          x, y,
          life: 0, max: rand(1300, 2100), size: rand(1.2, 3) * o.scale,
          color: pick(cols), shape: 'dot', halo: 12, twinkle: chance(0.25),
          delay: t * 520,
        });
      }
      // A small centre only. A growing ring here reads as a shockwave from a
      // different effect entirely — the flower is the whole gesture.
      this.rings.push({ x, y, r: 2, life: 0, max: 700, grow: 0.25 * o.scale, color: _rgb(cols[0]), width: 1.5 });
    }

    // Steady falling streaks. Variants: vertical drizzle, wind-blown, downpour.
    _rain(o) {
      const cols = o.pal || ['#8fd8ff', '#dff3ff', '#5fa8d8'];
      const v = variant(3);
      const n = Math.round((v === 2 ? 460 : 300) * o.scale);
      const wind = v === 1 ? rand(-3.5, 3.5) : rand(-0.4, 0.4);
      for (let i = 0; i < n; i++) {
        const sp = rand(9, 20) * (v === 2 ? 1.3 : 1);
        this.particles.push({
          x: rand(-120, this.w + 120), y: rand(-this.h, -10),
          vx: wind, vy: sp,
          life: 0, max: rand(1200, 2200), size: rand(0.7, 1.7) * o.scale,
          color: pick(cols), grav: 0.02, shape: 'streak', len: rand(10, 26),
          delay: rand(0, 700),
        });
      }
    }

    // A scanline sweeping the screen — reads as reading, checking, going through.
    _beam(o) {
      const c = o.pal ? _rgb(o.pal[0]) : '53,240,160';
      const vertical = chance(0.4);   // variant: down the screen, or across it
      this.sweeps.push({
        kind: 'beam', vertical, color: c,
        band: rand(40, 90) * o.scale,
        back: chance(0.5),            // variant: which way it travels
        life: 0, max: rand(1100, 1700),
      });
    }

    // Everything rushes to a point and snaps out of existence. The mirror of
    // nova: converging rather than announcing.
    _implode(x, y, o) {
      const cols = o.pal || ['#b47cff', '#37b6ff', '#ffffff'];
      const s = o.scale;
      const n = Math.round(260 * s);
      const R = Math.max(this.w, this.h) * 0.5;
      for (let i = 0; i < n; i++) {
        const a = rand(0, TAU), r = rand(R * 0.35, R) * s;
        this.particles.push({
          mode: 'polar', cx: x, cy: y, ang: a, rad: r,
          vang: rand(-0.012, 0.012), vrad: -r / rand(46, 76),   // all land together
          x: x + Math.cos(a) * r, y: y + Math.sin(a) * r,
          life: 0, max: rand(800, 1100), size: rand(1.2, 3) * s,
          color: pick(cols), shape: 'dot', halo: 12,
        });
      }
      this.rings.push({ x, y, r: R * s, life: 0, max: 900, grow: -R / 70, color: _rgb(cols[0]), width: 2 });
      setTimeout(() => {
        this._flash(`rgba(${_rgb(cols[0])},0.5)`);
        this.rings.push({ x, y, r: 2, life: 0, max: 600, grow: 4.5 * s, color: '255,255,255', width: 3 });
        this._ensureRunning();
      }, 820);
    }

    // ---- full-screen (DOM-driven) effects ----
    _flash(color) {
      let el = document.getElementById('pulse-flash');
      if (!el) { el = document.createElement('div'); el.id = 'pulse-flash'; document.body.appendChild(el); }
      el.style.setProperty('--flash', color || 'rgba(53,240,160,0.35)');
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    }

    _pulse(o) {
      const c = (o && o.pal) ? `rgba(${_rgb(o.pal[0])},0.45)` : 'rgba(53,240,160,0.45)';
      this._flash(c);
    }

    _shake() {
      const app = document.getElementById('app');
      if (!app) return;
      app.classList.remove('shake'); void app.offsetWidth; app.classList.add('shake');
      setTimeout(() => app.classList.remove('shake'), 550);
    }

    _glitch() {
      const app = document.getElementById('app');
      if (!app) return;
      app.classList.remove('glitch'); void app.offsetWidth; app.classList.add('glitch');
      setTimeout(() => app.classList.remove('glitch'), 620);
    }

    // ---- animation loop ----
    _busy() {
      return this.particles.length || this.rings.length || this.bolts.length
        || this.sheets.length || this.sweeps.length || this.links || this.frost || this.matrix;
    }

    _ensureRunning() {
      if (this.particles.length > MAX_PARTICLES) {
        this.particles.splice(0, this.particles.length - MAX_PARTICLES);
      }
      if (this.running) return;
      this.running = true;
      let last = performance.now();
      const step = (now) => {
        const dt = Math.min(now - last, 40); last = now;
        this._update(dt); this._draw();
        if (this._busy()) {
          requestAnimationFrame(step);
        } else {
          this.running = false;
          this.ctx.clearRect(0, 0, this.w, this.h);
        }
      };
      requestAnimationFrame(step);
    }

    _update(dt) {
      const f = dt / 16.67;
      const keep = [];
      for (const p of this.particles) {
        p.life += dt;
        if (p.delay && p.life < p.delay) { keep.push(p); continue; }
        if (p.life >= p.max + (p.delay || 0)) continue;

        if (p.mode === 'polar') {
          p.ang += p.vang * f;
          p.rad = Math.max(0, p.rad + p.vrad * f);
          p.x = p.cx + Math.cos(p.ang) * p.rad;
          p.y = p.cy + Math.sin(p.ang) * p.rad;
        } else if (p.mode === 'rose') {
          // r = R·|cos(k·θ)| traces a 2k-petalled rose. Each particle keeps its
          // own θ and rides out along the petal it sits under as the bloom
          // opens; rfrac is how deep under the rim it sits.
          const t = (p.life - (p.delay || 0)) / p.max;
          const th = p.ang + p.spin * p.life;
          // Open fast, then hold. A particle's alpha is 1-t, so an `open` that
          // eases across the whole life means the flower only finishes forming
          // once it's already two-thirds faded — fully shaped and nearly
          // invisible at the same instant. Opening by t=0.3 lets it be a flower
          // while it can still be seen.
          const open = Math.sin(Math.min(1, t * 3.4) * Math.PI * 0.5);
          const r = p.R * Math.abs(Math.cos(p.k * th)) * p.rfrac * open;
          p.x = p.cx + Math.cos(th) * r;
          p.y = p.cy + Math.sin(th) * r;
        } else if (p.mode === 'wander') {
          // Cheap organic drift: two out-of-phase sines nudge the heading.
          p.vx += Math.sin(p.life * p.wfreq + p.wphase) * p.wamp * f;
          p.vy += Math.cos(p.life * p.wfreq * 1.3 + p.wphase) * p.wamp * f;
          p.vx *= 0.985; p.vy *= 0.985;
          p.x += p.vx * f; p.y += p.vy * f;
        } else {
          if (p.accel) { p.vx *= Math.pow(p.accel, f); p.vy *= Math.pow(p.accel, f); }
          p.vy += (p.grav || 0) * f;
          if (p.drag) { p.vx *= p.drag; p.vy *= p.drag; }
          if (p.sway) p.x += Math.sin((p.life * p.sway) + p.swayPhase) * 0.9 * f;
          p.x += p.vx * f; p.y += p.vy * f;
        }
        if (p.vr) p.rot += p.vr * f;
        keep.push(p);
      }
      this.particles = keep;

      const rk = [];
      for (const r of this.rings) {
        r.life += dt;
        if (r.delay && r.life < r.delay) { rk.push(r); continue; }
        if (r.life < r.max + (r.delay || 0)) {
          const g = (r.grow != null) ? r.grow : 0.6;
          r.r = Math.max(0, r.r + g * f + (g > 0 ? r.life * 0.02 : 0));
          rk.push(r);
        }
      }
      this.rings = rk;

      const bk = [];
      for (const b of this.bolts) { b.life += dt; if (b.life < b.max + (b.delay || 0)) bk.push(b); }
      this.bolts = bk;

      const sk = [];
      for (const s of this.sheets) { s.life += dt; if (s.life < s.max + (s.delay || 0)) sk.push(s); }
      this.sheets = sk;

      const wk = [];
      for (const s of this.sweeps) { s.life += dt; if (s.life < s.max) wk.push(s); }
      this.sweeps = wk;

      if (this.links) {
        this.links.life += dt;
        for (const p of this.links.pts) {
          p.x += p.vx * f; p.y += p.vy * f;
        }
        if (this.links.life >= this.links.max) this.links = null;
      }

      if (this.frost) {
        this.frost.life += dt;
        if (this.frost.life >= this.frost.max) this.frost = null;
      }

      if (this.matrix) {
        this.matrix.life += dt;
        for (const d of this.matrix.drops) { d.y += d.sp * f; if (d.y > this.h) d.y = rand(-40, 0); }
        if (this.matrix.life >= this.matrix.max) this.matrix = null;
      }
    }

    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      // Aurora sits furthest back — it's a backdrop, not a burst.
      if (this.sheets.length) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of this.sheets) {
          if (s.delay && s.life < s.delay) continue;
          const t = (s.life - (s.delay || 0)) / s.max;
          const a = Math.sin(Math.min(1, t) * Math.PI) * 0.5;   // fade in and out
          if (a <= 0) continue;
          const g = ctx.createLinearGradient(0, s.y - s.amp, 0, s.y + s.band);
          g.addColorStop(0, `rgba(${s.color},0)`);
          g.addColorStop(0.35, `rgba(${s.color},${a * 0.5})`);
          g.addColorStop(1, `rgba(${s.color},0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.moveTo(0, s.y);
          for (let x = 0; x <= this.w; x += 16) {
            ctx.lineTo(x, s.y + Math.sin(x * s.freq + s.phase + s.life * s.drift) * s.amp);
          }
          ctx.lineTo(this.w, s.y + s.band); ctx.lineTo(0, s.y + s.band);
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }

      if (this.matrix) {
        const fade = 1 - this.matrix.life / this.matrix.max;
        const c = this.matrix.color;
        ctx.font = '13px monospace';
        for (const d of this.matrix.drops) {
          ctx.fillStyle = `rgba(210,255,225,${0.95 * fade})`;
          ctx.fillText(String.fromCharCode(0x30a0 + (Math.random() * 96 | 0)), d.x, d.y);
          for (let k = 1; k < d.len; k++) {
            const ka = 0.4 - k * 0.035;
            if (ka <= 0) break;
            ctx.fillStyle = `rgba(${c},${ka * fade})`;
            ctx.fillText(String.fromCharCode(0x30a0 + (Math.random() * 96 | 0)), d.x, d.y - k * 14);
          }
        }
      }

      // Frost: reveal branch segments as the effect ages, then fade the lot.
      if (this.frost) {
        const t = this.frost.life / this.frost.max;
        const fade = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        for (const s of this.frost.segs) {
          if (s.at > t * 1.3) continue;
          ctx.strokeStyle = `rgba(${this.frost.color},${0.75 * fade})`;
          ctx.lineWidth = s.w;
          ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        }
        ctx.restore();
      }

      // Sweeps: sonar arcs and beam scanlines.
      for (const s of this.sweeps) {
        const t = s.life / s.max;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        if (s.kind === 'sonar') {
          const a = (1 - t) * 0.9;
          const ang = s.from + t * TAU * s.turns * s.dir;
          // The trailing arc: a wedge that fades away behind the sweep line.
          const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, s.r);
          g.addColorStop(0, `rgba(${s.color},${a * 0.30})`);
          g.addColorStop(1, `rgba(${s.color},0)`);
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.moveTo(s.x, s.y);
          ctx.arc(s.x, s.y, s.r, ang - 0.85 * s.dir, ang, s.dir < 0);
          ctx.closePath(); ctx.fill();
          ctx.strokeStyle = `rgba(255,255,255,${a * 0.8})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(s.x, s.y);
          ctx.lineTo(s.x + Math.cos(ang) * s.r, s.y + Math.sin(ang) * s.r); ctx.stroke();
        } else { // beam
          const a = Math.sin(Math.min(1, t) * Math.PI) * 0.85;
          const span = s.vertical ? this.w : this.h;
          const p = (s.back ? 1 - t : t) * (span + s.band * 2) - s.band;
          const g = s.vertical
            ? ctx.createLinearGradient(p - s.band, 0, p + s.band, 0)
            : ctx.createLinearGradient(0, p - s.band, 0, p + s.band);
          g.addColorStop(0, `rgba(${s.color},0)`);
          g.addColorStop(0.5, `rgba(${s.color},${a * 0.4})`);
          g.addColorStop(1, `rgba(${s.color},0)`);
          ctx.fillStyle = g;
          if (s.vertical) ctx.fillRect(p - s.band, 0, s.band * 2, this.h);
          else ctx.fillRect(0, p - s.band, this.w, s.band * 2);
          // A hard bright edge leading the soft band is what sells it as a scan.
          ctx.strokeStyle = `rgba(255,255,255,${a * 0.55})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          if (s.vertical) { ctx.moveTo(p, 0); ctx.lineTo(p, this.h); }
          else { ctx.moveTo(0, p); ctx.lineTo(this.w, p); }
          ctx.stroke();
        }
        ctx.restore();
      }

      // Constellation: link nearby points, then draw the points themselves.
      if (this.links) {
        const L = this.links;
        const t = L.life / L.max;
        const fade = t < 0.15 ? t / 0.15 : (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineWidth = 1;
        for (let i = 0; i < L.pts.length; i++) {
          for (let j = i + 1; j < L.pts.length; j++) {
            const dx = L.pts[i].x - L.pts[j].x, dy = L.pts[i].y - L.pts[j].y;
            const d = Math.hypot(dx, dy);
            if (d > L.dist) continue;
            ctx.strokeStyle = `rgba(${L.color},${(1 - d / L.dist) * 0.5 * fade})`;
            ctx.beginPath(); ctx.moveTo(L.pts[i].x, L.pts[i].y); ctx.lineTo(L.pts[j].x, L.pts[j].y); ctx.stroke();
          }
        }
        ctx.globalAlpha = fade;
        for (const p of L.pts) {
          const sprite = glowSprite(p.color);
          const d = p.size * 5;
          ctx.drawImage(sprite, p.x - d / 2, p.y - d / 2, d, d);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // Lightning: a wide soft pass under a bright core, flickering as it dies.
      for (const b of this.bolts) {
        if (b.delay && b.life < b.delay) continue;
        const t = (b.life - (b.delay || 0)) / b.max;
        const a = (1 - t) * (0.55 + Math.random() * 0.45);
        const c = b.color || '190,235,255';
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const pass of [{ w: 9, c: `rgba(${c},${a * 0.28})` }, { w: 3.5, c: `rgba(${c},${a * 0.7})` }, { w: 1.4, c: `rgba(255,255,255,${a})` }]) {
          ctx.strokeStyle = pass.c; ctx.lineWidth = pass.w;
          ctx.beginPath();
          b.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.stroke();
          ctx.lineWidth = pass.w * 0.5;
          for (const br of b.branches) {
            ctx.beginPath();
            br.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
            ctx.stroke();
          }
        }
        ctx.restore();
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const r of this.rings) {
        if (r.delay && r.life < r.delay) continue;
        const a = 1 - (r.life - (r.delay || 0)) / r.max;
        if (a <= 0) continue;
        ctx.strokeStyle = `rgba(${r.color},${a})`;
        ctx.lineWidth = (r.width || 2) * (0.4 + a * 0.6);
        ctx.shadowBlur = 14; ctx.shadowColor = `rgba(${r.color},${a * 0.8})`;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
      }
      ctx.restore();

      // One save/restore for the whole additive batch rather than per particle:
      // ctx state changes are the other half of the draw cost.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const p of this.particles) {
        if (p.solid || p.shape === 'rect' || p.shape === 'shard') continue;
        if (p.delay && p.life < p.delay) continue;
        let a = 1 - (p.life - (p.delay || 0)) / p.max;
        if (a <= 0) continue;
        if (p.twinkle) a *= 0.55 + Math.random() * 0.45;
        ctx.globalAlpha = Math.max(0, Math.min(1, a));

        if (p.shape === 'streak') {
          const m = Math.hypot(p.vx, p.vy) || 1;
          const tx = p.x - (p.vx / m) * p.len, ty = p.y - (p.vy / m) * p.len;
          const g = ctx.createLinearGradient(p.x, p.y, tx, ty);
          g.addColorStop(0, p.color); g.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = g; ctx.lineWidth = p.size; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke();
        }
        const sprite = glowSprite(p.color);
        const d = p.size * (p.halo ? 6 : 3);
        ctx.drawImage(sprite, p.x - d / 2, p.y - d / 2, d, d);
      }
      ctx.restore();

      // Opaque shapes (confetti, glass shards) paint normally, over the glow.
      for (const p of this.particles) {
        if (!(p.solid || p.shape === 'rect' || p.shape === 'shard')) continue;
        if (p.delay && p.life < p.delay) continue;
        const a = 1 - (p.life - (p.delay || 0)) / p.max;
        if (a <= 0) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
        if (p.shape === 'shard') {
          // An irregular sliver — glass, not a tile.
          ctx.beginPath();
          ctx.moveTo(0, -p.size / 2);
          for (let i = 1; i < p.verts; i++) {
            const th = (i / p.verts) * TAU;
            ctx.lineTo(Math.cos(th) * p.size * 0.5, Math.sin(th) * p.size * 0.34);
          }
          ctx.closePath(); ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        }
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  FlourishEffects.PALETTES = PALETTES;
  FlourishEffects.MAX_PARTICLES = MAX_PARTICLES;
  window.FlourishEffects = FlourishEffects;
})();
