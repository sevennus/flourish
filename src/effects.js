/*
 * effects.js — the canvas particle engine and full-screen effects.
 *
 * Classic browser script: attaches window.FlourishEffects. The renderer creates
 * one instance over the overlay canvas and calls fire(name, x, y) at the caret
 * position when the parser reports a point effect.
 *
 * Drawing model: most particles are drawn additively ('lighter') so overlapping
 * ones bloom into each other instead of muddying — that plus a shadowBlur halo
 * is what makes a burst read as light rather than as confetti dots. Opaque
 * shapes (confetti rects) opt out via `solid: true`.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;
  const PALETTE = ['#35f0a0', '#37b6ff', '#ffd27a', '#ff5c7a', '#b47cff', '#7effc4'];
  const FIRE = ['#fff3b0', '#ffd27a', '#ff9d3c', '#ff5c2a', '#ff3860'];
  const ICE = ['#ffffff', '#dff3ff', '#8fd8ff', '#37b6ff'];
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

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
  const MAX_PARTICLES = 1600;

  class FlourishEffects {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = window.devicePixelRatio || 1;
      this.particles = [];
      this.rings = [];
      this.bolts = [];
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

    fire(name, x, y) {
      x = (typeof x === 'number') ? x : this.w / 2;
      y = (typeof y === 'number') ? y : this.h / 2;
      switch (name) {
        case 'spark': this._spark(x, y); break;
        case 'confetti': this._confetti(); break;
        case 'fireworks': this._firework(x, y); break;
        case 'ripple': this._ripple(x, y); break;
        case 'matrix': this._matrix(); break;
        case 'pulse': this._pulse(); break;
        case 'shake': this._shake(); break;
        case 'lightning': this._lightning(x, y); break;
        case 'nova': this._nova(x, y); break;
        case 'meteor': this._meteor(); break;
        case 'embers': this._embers(x, y); break;
        case 'vortex': this._vortex(x, y); break;
        case 'glitch': this._glitch(); break;
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
          shape: 'dot',
        });
      }
      this._ensureRunning();
    }

    // ---- point / particle effects ----
    _spark(x, y) {
      for (let i = 0; i < 40; i++) {
        const a = rand(0, TAU), sp = rand(1.5, 7.5);
        this.particles.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(420, 900), size: rand(1.5, 3.8),
          color: pick(['#35f0a0', '#7effc4', '#ffffff', '#37b6ff']),
          grav: 0.04, drag: 0.99, shape: 'dot', halo: 10,
        });
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 420, grow: 0.9, color: '126,255,196', width: 2 });
    }

    _firework(x, y) {
      const hue = pick(PALETTE);
      const hue2 = pick(PALETTE);
      // Two nested shells + a lingering glitter tail reads far richer than one
      // flat ring of dots.
      for (const shell of [{ n: 90, sp: [2, 9], size: [1.5, 3.2], c: hue },
                           { n: 45, sp: [1, 4], size: [1, 2.2], c: hue2 }]) {
        for (let i = 0; i < shell.n; i++) {
          const a = rand(0, TAU), sp = rand(shell.sp[0], shell.sp[1]);
          this.particles.push({
            x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
            life: 0, max: rand(700, 1500), size: rand(shell.size[0], shell.size[1]),
            color: Math.random() < 0.3 ? '#ffffff' : shell.c,
            grav: 0.06, drag: 0.985, shape: 'dot', halo: 12,
            twinkle: Math.random() < 0.4,
          });
        }
      }
      this.rings.push({ x, y, r: 2, life: 0, max: 520, grow: 1.6, color: '255,255,255', width: 2 });
    }

    _confetti() {
      for (let i = 0; i < 160; i++) {
        this.particles.push({
          x: rand(0, this.w), y: rand(-60, -6),
          vx: rand(-1.6, 1.6), vy: rand(1.5, 4.5),
          life: 0, max: rand(1800, 3000), size: rand(4, 9),
          color: pick(PALETTE), grav: 0.03, shape: 'rect', solid: true,
          rot: rand(0, TAU), vr: rand(-0.25, 0.25),
          sway: rand(0.01, 0.04), swayPhase: rand(0, TAU),
        });
      }
    }

    _ripple(x, y) {
      for (let k = 0; k < 4; k++) {
        this.rings.push({
          x, y, r: 4 + k * 6, life: 0, max: 900 + k * 140,
          color: '53,240,160', width: 2, grow: 0.6, delay: k * 60,
        });
      }
    }

    _matrix() {
      const cols = Math.floor(this.w / 14);
      const drops = [];
      for (let i = 0; i < cols; i++) {
        drops.push({ x: i * 14 + 4, y: rand(-this.h, 0), sp: rand(4, 12), len: 6 + ((Math.random() * 10) | 0) });
      }
      this.matrix = { drops, life: 0, max: 2200 };
    }

    // A bolt from the top of the screen down to the caret, with branches,
    // an impact burst and a cold-white flash.
    _lightning(x, y) {
      const startX = x + rand(-140, 140);
      const segs = 16;
      const pts = [{ x: startX, y: -10 }];
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        pts.push({
          x: startX + (x - startX) * t + rand(-30, 30) * (1 - t * 0.7),
          y: -10 + (y + 10) * t,
        });
      }
      pts[pts.length - 1] = { x, y };

      const branches = [];
      for (let b = 0; b < 3; b++) {
        const i = 3 + ((Math.random() * (segs - 5)) | 0);
        const bp = [pts[i]];
        let bx = pts[i].x, by = pts[i].y;
        for (let k = 0; k < 4; k++) { bx += rand(-34, 34); by += rand(12, 38); bp.push({ x: bx, y: by }); }
        branches.push(bp);
      }

      this.bolts.push({ pts, branches, life: 0, max: 420 });
      this._flash('rgba(200,238,255,0.55)');
      for (let i = 0; i < 30; i++) {
        const a = rand(-Math.PI, 0), sp = rand(1, 6);
        this.particles.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.6,
          life: 0, max: rand(300, 700), size: rand(1, 3),
          color: pick(ICE), grav: 0.08, drag: 0.97, shape: 'dot', halo: 10,
        });
      }
    }

    // The big one: white core flash, two expanding shockwave rings, 180-particle
    // radial burst.
    _nova(x, y) {
      this._flash('rgba(255,255,255,0.6)');
      this.rings.push({ x, y, r: 6, life: 0, max: 850, grow: 5.5, color: '255,255,255', width: 4 });
      this.rings.push({ x, y, r: 2, life: 0, max: 1050, grow: 3.6, color: '53,240,160', width: 2, delay: 90 });
      this.rings.push({ x, y, r: 2, life: 0, max: 1200, grow: 2.4, color: '55,182,255', width: 1.5, delay: 200 });
      for (let i = 0; i < 180; i++) {
        const a = rand(0, TAU), sp = rand(2, 13);
        this.particles.push({
          x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(600, 1500), size: rand(1.2, 3.6),
          color: Math.random() < 0.45 ? '#ffffff' : pick(['#35f0a0', '#7effc4', '#37b6ff']),
          grav: 0.02, drag: 0.972, shape: 'dot', halo: 14, twinkle: Math.random() < 0.3,
        });
      }
      this._shake();
    }

    // Shooting stars across the screen, drawn as tapered streaks.
    _meteor() {
      const n = 5 + ((Math.random() * 4) | 0);
      for (let i = 0; i < n; i++) {
        const sp = rand(9, 17);
        const a = rand(Math.PI * 0.14, Math.PI * 0.28); // down-right
        this.particles.push({
          x: rand(-this.w * 0.25, this.w * 0.8), y: rand(-140, this.h * 0.35),
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: 0, max: rand(900, 1500), size: rand(1.6, 3),
          color: pick(['#ffffff', '#dff3ff', '#7effc4', '#ffd27a']),
          grav: 0, shape: 'streak', len: rand(40, 110), halo: 12,
          delay: i * rand(40, 220),
        });
      }
    }

    // Rising, flickering embers with a sideways wobble.
    _embers(x, y) {
      for (let i = 0; i < 46; i++) {
        this.particles.push({
          x: x + rand(-30, 30), y: y + rand(-6, 14),
          vx: rand(-0.35, 0.35), vy: rand(-2.4, -0.7),
          life: 0, max: rand(1100, 2200), size: rand(1, 3),
          color: pick(FIRE), grav: -0.008, drag: 0.995, shape: 'dot', halo: 12,
          sway: rand(0.015, 0.05), swayPhase: rand(0, TAU), twinkle: true,
        });
      }
    }

    // Particles swept in on a spiral, then flung back out.
    _vortex(x, y) {
      for (let i = 0; i < 110; i++) {
        const ang = rand(0, TAU);
        this.particles.push({
          mode: 'polar', cx: x, cy: y, ang, rad: rand(90, 230),
          vang: rand(0.06, 0.13) * (Math.random() < 0.5 ? -1 : 1),
          vrad: rand(-2.6, -1.3),
          x: x + Math.cos(ang) * 160, y: y + Math.sin(ang) * 160,
          life: 0, max: rand(700, 1150), size: rand(1.2, 3),
          color: pick(['#b47cff', '#37b6ff', '#7effc4', '#ffffff']),
          shape: 'dot', halo: 12,
        });
      }
      this.rings.push({ x, y, r: 240, life: 0, max: 900, grow: -2.2, color: '180,124,255', width: 2 });
      // The collapse pays off with a burst at the centre.
      setTimeout(() => { this._spark(x, y); this._flash('rgba(180,124,255,0.4)'); this._ensureRunning(); }, 780);
    }

    // ---- full-screen (DOM-driven) effects ----
    _flash(color) {
      let el = document.getElementById('pulse-flash');
      if (!el) { el = document.createElement('div'); el.id = 'pulse-flash'; document.body.appendChild(el); }
      el.style.setProperty('--flash', color || 'rgba(53,240,160,0.35)');
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
    }

    _pulse() { this._flash('rgba(53,240,160,0.45)'); }

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
        if (this.particles.length || this.rings.length || this.bolts.length || this.matrix) {
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
        } else {
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
      for (const b of this.bolts) { b.life += dt; if (b.life < b.max) bk.push(b); }
      this.bolts = bk;

      if (this.matrix) {
        this.matrix.life += dt;
        for (const d of this.matrix.drops) { d.y += d.sp * f; if (d.y > this.h) d.y = rand(-40, 0); }
        if (this.matrix.life >= this.matrix.max) this.matrix = null;
      }
    }

    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      if (this.matrix) {
        const fade = 1 - this.matrix.life / this.matrix.max;
        ctx.font = '13px monospace';
        for (const d of this.matrix.drops) {
          ctx.fillStyle = `rgba(210,255,225,${0.95 * fade})`;
          ctx.fillText(String.fromCharCode(0x30a0 + (Math.random() * 96 | 0)), d.x, d.y);
          for (let k = 1; k < d.len; k++) {
            ctx.fillStyle = `rgba(53,240,160,${(0.4 - k * 0.035) * fade})`;
            if (0.4 - k * 0.035 <= 0) break;
            ctx.fillText(String.fromCharCode(0x30a0 + (Math.random() * 96 | 0)), d.x, d.y - k * 14);
          }
        }
      }

      // Lightning: a wide soft pass under a bright core, flickering as it dies.
      for (const b of this.bolts) {
        const t = b.life / b.max;
        const a = (1 - t) * (0.55 + Math.random() * 0.45);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const pass of [{ w: 9, c: `rgba(120,200,255,${a * 0.28})` }, { w: 3.5, c: `rgba(190,235,255,${a * 0.7})` }, { w: 1.4, c: `rgba(255,255,255,${a})` }]) {
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
        if (p.solid || p.shape === 'rect') continue;
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

      // Opaque shapes (confetti) paint normally, over the glow.
      for (const p of this.particles) {
        if (!(p.solid || p.shape === 'rect')) continue;
        const a = 1 - p.life / p.max;
        if (a <= 0) continue;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.fillStyle = p.color;
        ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }

  window.FlourishEffects = FlourishEffects;
})();
