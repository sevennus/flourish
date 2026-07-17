/*
 * effects.js â the canvas particle engine and full-screen effects.
 *
 * Classic browser script: attaches window.FlourishEffects. The renderer creates
 * one instance over the overlay canvas and calls fire(name, x, y, opts) at the
 * caret position when the parser reports a point effect.
 *
 * Drawing model: most particles are drawn additively ('lighter') so overlapping
 * ones bloom into each other instead of muddying â that plus a cached glow
 * sprite is what makes a burst read as light rather than as confetti dots.
 * Opaque shapes (confetti rects, glass shards) opt out via `solid: true`.
 *
 * Variety comes from three places, in increasing cost:
 *   1. VARIANTS â most effects pick one of several structural forms at random,
 *      so the same directive never paints the same picture twice. Free.
 *   2. ARGS â `{{fx:spark gold lg}}` recolours and resizes. The renderer parses
 *      these (Flourish.parseArgs) and passes {palette, scale}.
 *   3. New effect names, which cost system-prompt tokens on every request and
 *      so are added deliberately rather than freely.
 */
(function () {
  'use strict';

  const TAU = Math.PI * 2;

  // Geometry rules for apophenia's anchors live in the parser module â pure, so
  // `node --test` can reach them. Falling back to the old "fewer than 3 points"
  // test if it isn't loaded keeps this file standalone rather than throwing.
  const anchorsFlat = (window.Flourish && window.Flourish.anchorsFlat)
    || ((pts) => !pts || pts.length < 3);
  const planApopheniaPairs = window.Flourish && window.Flourish.planApopheniaPairs;

  // Lightning's geometry lives there too, and for the same reason.
  const _boltPath = window.Flourish && window.Flourish.boltPath;
  const _measure = window.Flourish && window.Flourish.measurePath;
  const _forks = window.Flourish && window.Flourish.forkPaths;
  const _leader = window.Flourish && window.Flourish.leaderStair;
  const _revealAt = window.Flourish && window.Flourish.revealAt;

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
  // rasterizes canvas2d shadows on the CPU, per draw call â with 180 glowing
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

  // Glyph alphabets for matrix / cascade.
  //
  // Half-width katakana is the classic look, but plenty of monospace fonts
  // don't carry it â this VM's doesn't, and `matrix` rendered as a screen of
  // notdef boxes for two releases because a tofu box at 13px in a dark terminal
  // reads as "some glyph" until you actually look. Windows finds a fallback
  // font and is fine; a bare Linux box is not. So: detect once, and use an
  // alphabet the font can actually draw.
  const KATAKANA = 'ï½±ï½²ï½³ï½´ï½µï½¶ï½·ï½¸ï½¹ï½ºï½»ï½¼ï½½ï½¾ï½¿ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾ï¾';
  const ASCII_GLYPHS = '01<>[]{}/\\=+*^?#%&@$Â§Â±Â¤Â¦â±â²â³âââ';
  let _kana = null;
  function kanaOK() {
    if (_kana !== null) return _kana;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      const draw = (ch) => {
        g.clearRect(0, 0, 24, 24);
        g.fillStyle = '#fff'; g.font = '16px monospace'; g.textBaseline = 'top';
        g.fillText(ch, 2, 2);
        return g.getImageData(0, 0, 24, 24).data.join(',');
      };
      // U+FFFE is a permanent noncharacter â it can never have a real glyph, so
      // whatever it draws IS this font stack's notdef box. If katakana draws the
      // same pixels, we're looking at tofu.
      _kana = draw('ï½±') !== draw('ï¿¾');
    } catch (e) {
      _kana = false;   // no canvas readback? assume the safe alphabet.
    }
    return _kana;
  }
  const glyphAlphabet = () => (kanaOK() ? KATAKANA : ASCII_GLYPHS);

  // ---- ASCII scenes ----
  //
  // Content comes from the parser module, where it's pure and a test can call
  // it with a fixed seed. Everything below is the drawing only. If a planner
  // is missing the scene must not paint at all â see _scene.
  const A = window.Flourish || {};
  const ASCII_EFFECTS = A.ASCII_EFFECTS || new Set();
  const ASCII_PLAN = {
    wardial: A.planWardial, sniffer: A.planSniffer, trace: A.planTrace,
    daemon: A.planDaemon, portscan: A.planPortscan, overflow: A.planOverflow,
    crack: A.planCrack, gibson: A.planGibson,
    skull: A.planSkull, wireframe: A.planWireframe, plasma: A.planPlasma,
    tunnel: A.planTunnel, firewall: A.planFirewall, cat: A.planCat,
  };

  // The terminal's own stack, so a scene sits in the same face as the prose
  // behind it. Never assume the advance width of this â measure it. The stack
  // resolves differently per platform and a hard-coded cell width shears every
  // scene a little further right on each column.
  const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

  // What a cell spins through before it locks. Deliberately not glyphAlphabet():
  // these scenes are ASCII pretending to be a machine, and katakana in a
  // hexdump reads as a different effect leaking in.
  const CRACK_CHARSET = (A.CRACK_CHARSET) || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';

  // Hard cap: a runaway effect (or an over-caffeinated typist) must never be
  // able to grind the frame rate down. Oldest particles are shed first.
  const MAX_PARTICLES = 16000;

  class FlourishEffects {
    // `underCanvas` is optional and sits BEHIND the text (z-index 0 vs the
    // overlay's 50). Only apophenia uses it: its web is drawn between real
    // words, so on the overlay it paints on top of the very prose it's linking
    // and reads as a strikethrough. Behind the text it reads as a web. Every
    // other effect stays on the overlay, where being on top is the point.
    constructor(canvas, underCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.underCanvas = underCanvas || null;
      this.under = underCanvas ? underCanvas.getContext('2d') : null;
      this.dpr = window.devicePixelRatio || 1;
      this.particles = [];
      this.rings = [];
      this.bolts = [];
      this.sheets = [];   // aurora curtains
      this.sweeps = [];   // sonar arcs + beam scanlines
      this.links = null;  // constellation
      this.webs = null;   // apophenia
      this.frost = null;  // creeping ice
      this.matrix = null;
      // Every ASCII scene, in one array rather than ten fields. A `this.<name>`
      // per effect has to be remembered in four places â _busy, _update, _draw
      // and fx-shots' reset â and the README records what forgetting the fourth
      // costs: the effect quietly stacks up across every later shot. Ten new
      // fields would be ten chances to pay that. This is one.
      this.ascii = [];
      this.running = false;
      this._resize = this._resize.bind(this);
      this._resize();
      window.addEventListener('resize', this._resize);
    }

    _resize() {
      this.dpr = window.devicePixelRatio || 1;
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      for (const c of [this.canvas, this.underCanvas]) {
        if (!c) continue;
        c.width = Math.floor(this.w * this.dpr);
        c.height = Math.floor(this.h * this.dpr);
        c.style.width = this.w + 'px';
        c.style.height = this.h + 'px';
      }
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.under) this.under.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }

    /**
     * Fire a named point effect at (x, y).
     * `opts` is {palette, scale} as parsed from the directive's args by
     * Flourish.parseArgs â both optional.
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
        case 'apophenia': this._apophenia(x, y, o); break;
        case 'shatter': this._shatter(x, y, o); break;
        case 'swarm': this._swarm(x, y, o); break;
        case 'sonar': this._sonar(x, y, o); break;
        case 'warp': this._warp(x, y, o); break;
        case 'frost': this._frost(o); break;
        case 'bloom': this._bloom(x, y, o); break;
        case 'rain': this._rain(o); break;
        case 'beam': this._beam(o); break;
        case 'implode': this._implode(x, y, o); break;
        case 'scanlines': this._scanlines(o); break;
        case 'static': this._static(o); break;
        case 'vhs': this._vhs(); break;
        case 'grid': this._grid(o); break;
        case 'circuit': this._circuit(o); break;
        case 'tracer': this._tracer(x, y, o); break;
        default:
          // The ASCII register dispatches off one set rather than ten cases, so
          // an eleventh scene costs no line here. Anything else still falls
          // through to painting nothing, which is what `default: return` always
          // meant â a typo costs the effect, never a wrong one.
          if (ASCII_EFFECTS.has(name) && typeof this['_' + name] === 'function') {
            this['_' + name](x, y, o);
            break;
          }
          return;
      }
      this._ensureRunning();
    }

    /**
     * Public particle emitter â the small, composable burst the input-box
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

    /**
     * Drop a single character down the screen as a Matrix glyph â the primitive
     * `cascade` uses to pull a line of text apart. It starts as the real
     * character and degrades into junk as it falls, so you can watch a word
     * stop being a word.
     */
    glyphFall(x, y, ch) {
      this.particles.push({
        x, y, vx: rand(-0.5, 0.5), vy: rand(1.2, 3.4),
        life: 0, max: rand(1100, 2000), size: 13,
        color: chance(0.25) ? '#d2ffe1' : '#35f0a0',
        grav: 0.055, drag: 1, shape: 'glyph',
        ch: ch, glyphs: glyphAlphabet(), decay: rand(0.25, 0.6),
      });
      this._ensureRunning();
    }

    /**
     * Fly one character across the window and land it on a target â the
     * primitive `salvage` uses to assemble a line out of letters it took from
     * text already on screen. The mirror of glyphFall: that one hands a
     * character from the DOM to the canvas and drops it, this one carries a
     * character over the canvas and hands it back.
     *
     * Two things it deliberately does not do. It never degrades the glyph the
     * way glyphFall does â a salvaged letter has to arrive as itself, because
     * the whole claim is that this exact letter was already up there. And it
     * doesn't fade out at the end of its life: it lands at full strength and
     * `onLand` reveals the real character underneath it on the same frame, so
     * the handover is invisible. A flier that faded on approach would read as
     * the letter failing to arrive.
     *
     * The arc is a quadratic bezier with the control point kicked perpendicular
     * to the flight path, so letters coming from the same place don't travel in
     * a bundle of parallel lines. `font` comes from the caller because the
     * engine can't read the DOM â a flier in the wrong face stops looking like
     * the letter it's about to become.
     */
    glyphFly(x0, y0, x1, y1, ch, o) {
      o = o || {};
      const dx = x1 - x0, dy = y1 - y0;
      const dist = Math.hypot(dx, dy) || 1;
      // Perpendicular kick, scaled to the trip and signed at random: a short
      // hop barely bends, a cross-window haul sweeps.
      const bow = Math.min(150, dist * 0.28) * (chance(0.5) ? 1 : -1);
      this.particles.push({
        mode: 'fly', shape: 'flyglyph',
        x: x0, y: y0,
        x0, y0, x1, y1,
        cx: (x0 + x1) / 2 + (-dy / dist) * bow,
        cy: (y0 + y1) / 2 + (dx / dist) * bow,
        life: 0, delay: o.delay || 0,
        max: o.dur || (420 + Math.min(620, dist * 0.55)),
        ch, font: o.font || '13px monospace',
        color: o.color || '#7effc4',
        onLand: o.onLand,
        // Both endpoints are viewport coordinates of text that keeps scrolling
        // under the flier. `drift` hands back one number â how far the
        // transcript has scrolled â and the whole path rides it, so the letter
        // stays aimed at the character rather than at the hole it left. The
        // engine still never touches the DOM: this is a closure that returns a
        // number, the same deal as onLand.
        drift: o.drift,
        drift0: o.drift ? o.drift() : 0,
      });
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
        default: { // ring snap â all at one speed, so it reads as a shell
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
      } else if (v === 1) { // willow â slow, heavy, drooping trails
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
      this.matrix = {
        drops, life: 0, max: v === 2 ? 3200 : 2200,
        color: o.pal ? _rgb(o.pal[0]) : '53,240,160',
        glyphs: glyphAlphabet(),
      };
    }

    // A bolt from the top of the screen down to the caret, with branches,
    // an impact burst and a cold-white flash. Variants: single strike, forked
    // double strike, and a ground-up discharge.
    /*
     * Lightning: a stepped leader, then a return stroke.
     *
     * The old one interpolated a straight line from origin to target and
     * jittered the points. Noise on a line is a noisy line â it can't be
     * anything but a stick, because the structure it needs isn't in there at
     * any scale. Real channels are self-similar, so the path is built by
     * MIDPOINT DISPLACEMENT instead: take a segment, push its midpoint along
     * the perpendicular, halve the push, recurse. Every level adds detail that
     * looks like the level above it, which is the whole difference between
     * lightning and a twig.
     *
     * Forks are the other half of the stick problem. The old branches were
     * four-point random walks stapled on at random indices â so they read as
     * separate debris rather than as the channel splitting. These leave a real
     * point on the trunk, inherit the trunk's local heading, and are built by
     * the same displacement at lower detail, so a fork is just a smaller bolt.
     *
     * And it GROWS, which the old one could not: nothing in it tracked a tip,
     * so the draw loop painted the whole path from the first frame and only
     * faded the alpha. Growth here is a STAIRCASE, not a ramp. A real leader
     * advances in discrete jumps with dark pauses between them, and a smooth
     * reveal reads as a wipe â the jumps are the erratic part, and the erratic
     * part is what sells it. When the tip lands, the return stroke lights the
     * whole channel at once. That flash IS the strike, and it's the instant the
     * word underneath catches fire.
     */
    _lightning(x, y, o) {
      const cols = o.pal || ICE;
      const c = o.pal ? _rgb(o.pal[0]) : null;

      // Strike real words, several per screen. The renderer hands their rects
      // in via o.anchors â the same channel apophenia used, and the reason its
      // geometry outlived it. With nothing on screen to hit, strike the caret,
      // which is where every effect fires by default anyway.
      // EVERY anchor the renderer hands over, which is now one per line of text
      // on screen. This used to slice(0, 2 + rand(0..2)) — a third cap stacked
      // under two others, taking 2-4 off the FRONT of a list that arrives
      // sorted top-to-bottom. Between the three of them a "screen full of
      // lightning" was three bolts inside a 90px band, and the probe printed
      // `anchors: 4 / bolts: 3` for weeks without anyone reading it as a bug.
      const targets = (o.anchors && o.anchors.length) ? o.anchors : [{ x, y }];

      // The stagger has to fit a fixed window rather than accumulate per bolt.
      // At the old 3 bolts, k * rand(60,190) was a ~400ms storm; at one bolt
      // per line it would deal the last bolt of a 30-line screen a 4-second
      // delay, by which point every early bolt has expired — a slow drizzle
      // down the page instead of a strike, and each one alone on screen.
      const spread = 380 / Math.max(1, targets.length - 1);

      targets.forEach((t, k) => {
        // Origins spread across the top so parallel bolts don't read as one
        // fork, and the leader wanders more the further it has to travel.
        const ox = t.x + rand(-200, 200);
        const main = _measure(_boltPath(ox, -12, t.x, t.y, 0.30, 6));
        const grow = rand(110, 210);          // fast: a leader is not a wipe
        this.bolts.push({
          main,
          forks: _forks(main, 3 + ((Math.random() * 3) | 0), o.scale),
          stair: _leader(7 + ((Math.random() * 6) | 0)),
          target: t, index: t.index,
          onStrike: o.onStrike || null,
          struck: false,
          grow, delay: k * spread * rand(0.6, 1.4),
          life: 0, max: grow + 520,
          color: c,
        });
      });

      // The sky lighting before anything has landed. The strike's own flash is
      // fired per bolt, on impact, in _tick.
      this._flash(c ? `rgba(${c},0.22)` : 'rgba(200,238,255,0.24)');
      this._ensureRunning();
      this._boltCols = cols;
    }

    /*
     * Stroke `path` up to `reveal` of its arc length, interpolating the partial
     * segment at the tip.
     *
     * Advancing by DISTANCE rather than by point index is what keeps the growth
     * even: midpoint displacement leaves segments of wildly different lengths,
     * so revealing a fixed number of points per frame would crawl through the
     * detailed stretches and leap the smooth ones.
     */
    _strokeTo(ctx, path, reveal) {
      const pts = path.pts, cum = path.cum;
      const end = reveal * path.total;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        if (cum[i] <= end) { ctx.lineTo(pts[i].x, pts[i].y); continue; }
        const seg = cum[i] - cum[i - 1] || 1;
        const k = (end - cum[i - 1]) / seg;
        ctx.lineTo(pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k,
                   pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k);
        break;
      }
      ctx.stroke();
    }

    // Sparks thrown off the point of impact. Fired on the return stroke rather
    // than at t=0, so the debris belongs to the strike instead of preceding it.
    _strikeBurst(x, y, o) {
      const cols = this._boltCols || ICE;
      const s = (o && o.scale) || 1;
      for (let i = 0; i < 46 * s; i++) {
        const a = rand(-Math.PI, 0), sp = rand(1, 7) * s;
        this._dot(x, y, a, sp, cols, {
          vy: Math.sin(a) * sp * 0.6, max: rand(300, 700),
          size: rand(1, 3) * s, grav: 0.08, drag: 0.97,
        });
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
        // v0 even sphere Â· v1 layered shells Â· v2 spiked star
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
    // quiet â the opposite end of the register from nova.
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

    /*
     * Constellation's evil twin: the same beautiful linking animation, drawing
     * lines between things that have nothing to do with each other.
     *
     * Every difference from _constellation is the joke:
     *
     *  - Constellation links by DISTANCE, which is a real relationship â nearby
     *    dots belong together, and the picture it assembles is true. Apophenia
     *    links by nothing at all. Pairs are drawn at random and the length of
     *    the line is not evidence of anything.
     *  - Constellation's dots are scattered. Apophenia's land on real WORDS
     *    (the renderer passes their rects in via o.anchors â the engine still
     *    never reads the DOM), so it looks like it has found something in the
     *    text rather than in the void.
     *  - Constellation fades its links in together. Apophenia draws them one at
     *    a time, deliberately, like a proof going up on a board.
     *
     * Confident, elegant, wrong. Point it at a conclusion about to be reached
     * badly.
     */
    _apophenia(x, y, o) {
      const cols = o.pal || ['#b98cff', '#7effc4', '#ffffff'];
      let pts = (o.anchors || []).slice();
      // Nothing on screen to hang it off, or everything we got shares one
      // baseline (a short reply, one line of transcript) â fall back to
      // inventing some, which is thematically exactly right. Never draw the
      // flat set: a rule through the prose is worse than no effect at all.
      if (anchorsFlat(pts)) {
        pts = [];
        for (let i = 0; i < 8; i++) {
          const a = rand(0, TAU), r = Math.sqrt(Math.random()) * 260 * o.scale;
          pts.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r });
        }
      }
      pts = pts.map((p) => ({ x: p.x, y: p.y, size: rand(1.6, 3.0) * o.scale, color: pick(cols) }));

      // Random pairs across lines, distance ignored on purpose. No pair twice â
      // the effect is a confident argument, and a confident argument doesn't
      // repeat itself. The rule lives in flourish.js so it can be tested.
      const pairs = planApopheniaPairs(pts);
      this.webs = {
        pts, pairs, life: 0,
        max: (pairs.length * 210) + 2600,
        color: _rgb(cols[0]),
      };
      this._ensureRunning();
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
    // effect that lingers â good for "lots of things happening at once".
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

    // Petals unfurling along a rose curve â organic, unlike everything else here.
    _bloom(x, y, o) {
      const cols = o.pal || ['#ff5c7a', '#ffb3c4', '#ffd27a', '#7effc4'];
      // r = RÂ·|cos(kÂ·Î¸)| draws 2k lobes, so k=2..4 gives a 4-, 6- or 8-petalled
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
      // different effect entirely â the flower is the whole gesture.
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

    // A scanline sweeping the screen â reads as reading, checking, going through.
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

    // ---- cyberpunk ----

    // CRT scanlines, with the slow vertical roll of a set that needs its hold
    // adjusting. DOM rather than canvas: it's a repeating gradient, and CSS
    // animates it for free.
    _scanlines(o) {
      const app = document.getElementById('app');
      if (!app) return;
      let el = document.getElementById('fx-scanlines');
      if (!el) { el = document.createElement('div'); el.id = 'fx-scanlines'; document.body.appendChild(el); }
      el.style.setProperty('--scan-color', o.pal ? `rgba(${_rgb(o.pal[0])},0.5)` : 'rgba(53,240,160,0.35)');
      el.classList.remove('go'); void el.offsetWidth; el.classList.add('go');
      clearTimeout(this._scanT);
      this._scanT = setTimeout(() => el.classList.remove('go'), 3400);
    }

    // TV static. Noise is generated into a small offscreen buffer and blown up
    // to full screen â 160x100 random pixels a frame is nothing, whereas
    // per-pixel noise at 1120x720 is 800k writes and would drop the frame.
    _static(o) {
      if (!this._noiseBuf) {
        this._noiseBuf = document.createElement('canvas');
        this._noiseBuf.width = 160; this._noiseBuf.height = 100;
      }
      // Peak alpha is deliberately restrained. At 0.5 this covers the whole
      // screen and the reader loses the sentence for half a second â "signal
      // lost" is the meaning, not an instruction to actually blind them.
      this.noise = { life: 0, max: rand(500, 900), alpha: Math.min(0.5, 0.3 * o.scale) };
    }

    // Tracking error: bands of the picture shifted sideways, snapping between
    // offsets rather than sliding.
    _vhs() {
      const app = document.getElementById('app');
      if (!app) return;
      app.classList.remove('vhs'); void app.offsetWidth; app.classList.add('vhs');
      setTimeout(() => app.classList.remove('vhs'), 900);
    }

    // Synthwave perspective grid rushing toward the viewer.
    _grid(o) {
      this.grid = {
        life: 0, max: rand(2600, 3600),
        color: o.pal ? _rgb(o.pal[0]) : '183,76,255',
        speed: rand(0.0016, 0.0032) * o.scale,
        rows: 22,
      };
    }

    // PCB traces: Manhattan-routed paths that light up from the edges inward,
    // with a pad at each end. Right angles are the whole point â it's the
    // orthogonal cousin of frost's organic branching.
    _circuit(o) {
      const c = o.pal ? _rgb(o.pal[0]) : '53,240,160';
      const n = Math.round((7 + variant(6)) * o.scale);
      const segs = [], pads = [];
      for (let i = 0; i < n; i++) {
        const horiz = chance(0.5);
        let x = horiz ? (chance(0.5) ? -6 : this.w + 6) : rand(0, this.w);
        let y = horiz ? rand(0, this.h) : (chance(0.5) ? -6 : this.h + 6);
        let dx = horiz ? (x < 0 ? 1 : -1) : 0;
        let dy = horiz ? 0 : (y < 0 ? 1 : -1);
        let at = 0;
        const legs = 3 + ((Math.random() * 4) | 0);
        for (let k = 0; k < legs; k++) {
          const len = rand(50, 190);
          const nx = x + dx * len, ny = y + dy * len;
          segs.push({ x1: x, y1: y, x2: nx, y2: ny, at, w: rand(1, 2.2) });
          at += rand(0.05, 0.13);
          x = nx; y = ny;
          // Turn 90Â°: swap which axis we travel on.
          if (dx) { dy = chance(0.5) ? 1 : -1; dx = 0; } else { dx = chance(0.5) ? 1 : -1; dy = 0; }
        }
        pads.push({ x, y, at, r: rand(2.5, 5) });
      }
      this.traces = { segs, pads, life: 0, max: 2800, color: c };
    }

    // Light cycles: heads that run, turn at right angles, and leave a glowing
    // trail that fades from the tail.
    _tracer(x, y, o) {
      const cols = o.pal || ['#35f0a0', '#37b6ff', '#ff2d6f', '#ffd27a'];
      const n = 3 + variant(4);
      const heads = [];
      for (let i = 0; i < n; i++) {
        const horiz = chance(0.5);
        heads.push({
          x: x + rand(-40, 40), y: y + rand(-30, 30),
          dx: horiz ? (chance(0.5) ? 1 : -1) : 0,
          dy: horiz ? 0 : (chance(0.5) ? 1 : -1),
          sp: rand(4, 9) * o.scale,
          trail: [], maxTrail: 90 + ((Math.random() * 70) | 0),
          nextTurn: rand(140, 420), since: 0,
          color: pick(cols),
        });
      }
      this.tracers = { heads, life: 0, max: rand(2200, 3200) };
    }

    // ---- ASCII scenes ----
    //
    // Ten effects, one array, one draw pass. Each is a machine talking to
    // itself in monospace: the register `matrix` and `hexdump` gesture at, done
    // literally. The content is planned in flourish.js (pure, seeded, tested);
    // what lives here is geometry and paint.

    // ---- the grid register: helpers ----
    //
    // Grid scenes draw in the transcript's OWN face and cells (o.grid, measured
    // by the renderer), so their glyphs land exactly on top of the DOM's. Two
    // coordinate rules keep the registration honest:
    //
    //   * A REAL character is painted at its measured position (cell.x/cell.y)
    //     — never at where the uniform grid thinks its row should be, because
    //     the 10px paragraph margins make those drift apart down the page.
    //   * The vertical offset from a run's rect-top to its canvas BASELINE is
    //     computed once per font, from the measured rect height — not guessed
    //     from the px size, which is how a canvas glyph ends up sitting 2px
    //     proud of the DOM glyph it claims to replace.

    _gridFont(G) { return G.px + 'px ' + G.font; }

    // rect-top -> alphabetic-baseline offset for the grid's font. The DOM
    // centres the font box in the line box (half-leading above and below), so
    // the baseline sits at half the spare height plus the font's ascent.
    _vOff(G) {
      const key = G.px + '|' + G.font + '|' + (G.rh || 0);
      this._voffs = this._voffs || new Map();
      let v = this._voffs.get(key);
      if (v == null) {
        const ctx = this.ctx;
        ctx.save();
        ctx.font = this._gridFont(G);
        const m = ctx.measureText('Mg');
        const asc = (m.fontBoundingBoxAscent != null) ? m.fontBoundingBoxAscent : G.px * 0.8;
        const desc = (m.fontBoundingBoxDescent != null) ? m.fontBoundingBoxDescent : G.px * 0.25;
        ctx.restore();
        v = Math.max(0, ((G.rh || G.lineH) - (asc + desc)) / 2) + asc;
        this._voffs.set(key, v);
      }
      return v;
    }

    // The page background as "r,g,b", for veils and knockouts. G.bg arrives as
    // a computed "rgb(...)" string; anything unparseable gets the terminal's
    // own near-black rather than a crash.
    _bgRgb(G) {
      const m = /(\d+)\D+(\d+)\D+(\d+)/.exec((G && G.bg) || '');
      return m ? (m[1] + ',' + m[2] + ',' + m[3]) : '5,7,10';
    }

    // The shared fields every grid scene carries: its snapshot, its baseline
    // offset, and how far the text has scrolled since it was measured.
    _gridExtra(o) {
      return {
        grid: o.grid,
        vOff: this._vOff(o.grid),
        scrollY: o.scrollY || null,
        scroll0: o.scrollY ? o.scrollY() : 0,
      };
    }

    // Cell metrics for a monospace grid at `px`. Measured, never assumed.
    _cell(px) {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = px + 'px ' + MONO;
      const w = ctx.measureText('M').width;
      ctx.restore();
      return { w: w || px * 0.6, h: Math.round(px * 1.42), px };
    }

    /**
     * Build a scene and push it.
     *
     * Returns null â and pushes nothing â if the planner that feeds it is
     * missing. That's the one branch here that matters: this repo's signature
     * bug is an effect quietly running its fallback and photographing well, so
     * a scene with no content paints NOTHING rather than an empty pane with a
     * nice glow on it. A missing scene is visible. A plausible one isn't.
     */
    _scene(kind, o, extra) {
      if (Object.prototype.hasOwnProperty.call(ASCII_PLAN, kind) && !ASCII_PLAN[kind]) return null;
      const s = Object.assign({
        kind, life: 0, max: 3000,
        color: o.pal ? _rgb(o.pal[0]) : '53,240,160',
        accent: o.pal ? _rgb(o.pal[o.pal.length - 1]) : '255,45,111',
        dim: '90,120,110',
        scale: o.scale,
      }, extra);
      this.ascii.push(s);
      return s;
    }

    // Place a pane of `cols`x`rows` cells near the caret without letting it
    // hang off an edge. Panes are content, not decoration â half a hexdump is
    // just noise.
    _pane(x, y, cols, rows, cell) {
      const w = cols * cell.w, h = rows * cell.h;
      return {
        x: Math.max(14, Math.min(this.w - w - 14, x - w * 0.5)),
        y: Math.max(14, Math.min(this.h - h - 14, y - h * 0.5)),
        w, h,
      };
    }

    _fillText(ctx, str, x, y, rgb, alpha, cell) {
      ctx.fillStyle = 'rgba(' + rgb + ',' + alpha + ')';
      ctx.fillText(str, x, y);
      void cell;
    }

    // A line-reveal pane: wardial, sniffer, trace, daemon, overflow all share
    // this shape â lines arriving one at a time, scrolling once they overflow.
    // Snap a pane's origin onto the text's rows and columns, so its output
    // sits IN the terminal's grid rather than floating over it at its own
    // size. The pane keeps working bare — these are pre-dating effects with a
    // real no-grid path — but with a grid it wears the page's own face.
    _snapPane(box, G) {
      box.x = G.left + Math.round((box.x - G.left) / G.cellW) * G.cellW;
      box.y = G.top + Math.round((box.y - G.top) / G.lineH) * G.lineH;
      return box;
    }

    _paneExtra(o) {
      return o.grid
        ? Object.assign(this._gridExtra(o), { font: o.grid.font })
        : {};
    }

    _linePane(kind, x, y, o, lines, opts) {
      if (!lines || !lines.length) return null;
      const G = o.grid;
      const cell = G ? { w: G.cellW, h: G.lineH, px: G.px }
        : this._cell(Math.round(13 * o.scale));
      const cols = lines.reduce((m, l) => Math.max(m, l.text.length), 0);
      const rows = Math.min(opts.rows || 16, lines.length);
      const box = this._pane(x, y, cols + 2, rows + 2, cell);
      if (G) this._snapPane(box, G);
      return this._scene(kind, o, Object.assign(this._paneExtra(o), {
        lines, cell, box, rows,
        per: opts.per || 110,
        title: opts.title || '',
        max: opts.max || (lines.length * (opts.per || 110) + 1500),
      }));
    }

    // The Gibson. A wireframe city pulled toward the viewer, its towers built
    // out of block glyphs rather than lines â the movie's one image everybody
    // remembers, and the reason this whole family exists.
    _gibson(x, y, o) {
      const towers = ASCII_PLAN.gibson && ASCII_PLAN.gibson();
      if (!towers) return;
      this._scene('gibson', o, {
        towers,
        cell: this._cell(13),
        max: rand(3400, 4400),
        speed: rand(0.0042, 0.0072) * o.scale,
      });
      void x; void y;
    }

    _wardial(x, y, o) {
      this._linePane('wardial', x, y, o, ASCII_PLAN.wardial && ASCII_PLAN.wardial(), {
        per: 95, rows: 15, title: 'AUTODIAL',
      });
    }

    _sniffer(x, y, o) {
      this._linePane('sniffer', x, y, o, ASCII_PLAN.sniffer && ASCII_PLAN.sniffer(), {
        per: 150, rows: 10, title: 'tcpdump -X -i eth0',
      });
    }

    _trace(x, y, o) {
      this._linePane('trace', x, y, o, ASCII_PLAN.trace && ASCII_PLAN.trace(), {
        per: 230, rows: 12, title: 'traceroute gibson.ellingson.com',
      });
    }

    _daemon(x, y, o) {
      this._linePane('daemon', x, y, o, ASCII_PLAN.daemon && ASCII_PLAN.daemon(), {
        per: 130, rows: 18, title: 'pstree',
      });
    }

    // The smash. The frame is drawn whole and then flooded from the buffer up,
    // one row at a time, until the saved return address is 0x41414141 â the
    // one moment in this set where the picture and the point are the same
    // thing.
    _overflow(x, y, o) {
      const plan = ASCII_PLAN.overflow && ASCII_PLAN.overflow();
      if (!plan) return;
      const G = o.grid;
      const cell = G ? { w: G.cellW, h: G.lineH, px: G.px }
        : this._cell(Math.round(13 * o.scale));
      const box = this._pane(x, y, 40, plan.rows.length + 5, cell);
      if (G) this._snapPane(box, G);
      this._scene('overflow', o, Object.assign(this._paneExtra(o), {
        plan, cell, box, per: 260,
        max: plan.rows.length * 260 + 2200,
      }));
    }

    _portscan(x, y, o) {
      const ports = ASCII_PLAN.portscan && ASCII_PLAN.portscan();
      if (!ports) return;
      const G = o.grid;
      const cell = G ? { w: G.cellW, h: G.lineH, px: G.px }
        : this._cell(Math.round(12 * o.scale));
      const perRow = G ? Math.max(1, Math.min(4, ((G.cols - 2) / 21) | 0)) : 4;
      const rows = Math.ceil(ports.length / perRow);
      const box = this._pane(x, y, perRow * 21, rows + 2, cell);
      if (G) this._snapPane(box, G);
      this._scene('portscan', o, Object.assign(this._paneExtra(o), {
        ports, cell, box, perRow, per: 70,
        max: ports.length * 70 + 2000,
      }));
    }

    _crack(x, y, o) {
      const plan = ASCII_PLAN.crack && ASCII_PLAN.crack();
      if (!plan) return;
      this._scene('crack', o, {
        plan, cell: this._cell(Math.round(30 * o.scale)),
        cx: this.w / 2, cy: y,
        max: plan.doneAt + 1400,
      });
      void x;
    }

    // Big block letters. `bannerRows` rasterises the phrase; each ink cell
    // lights on its own schedule so the words assemble left to right.
    //
    // With a grid, the banner is laid INTO the text's cells: each ink cell is
    // a solid block exactly one character wide and one line tall, and wherever
    // a block lands on a real character, that character is knocked out of it
    // in page-black — the prose shows through the letters as letterforms. A
    // phrase too wide for the screen's columns keeps the floating path.
    _banner(x, y, o) {
      if (!A.bannerRows || !A.BANNER_WORDS) return;
      const text = pick(A.BANNER_WORDS);
      const rows = A.bannerRows(text);
      if (!rows || !rows.length) return;
      const G = o.grid;
      if (G && rows[0].length <= G.cols - 2) {
        const c0 = Math.round((G.cols - rows[0].length) / 2);
        const r0 = Math.round(Math.min(Math.max((y - G.top) / G.lineH - rows.length / 2, 0.5),
          G.rows - rows.length - 1));
        const ink = [];
        for (let r = 0; r < rows.length; r++) {
          for (let c = 0; c < rows[r].length; c++) {
            if (rows[r][c] !== '#') continue;
            ink.push({ r, c, src: G.cells.get((r0 + r) * 4096 + (c0 + c)) || null });
          }
        }
        const max = rand(2900, 3500);
        this._scene('banner', o, Object.assign(this._gridExtra(o), {
          ink, rows, text, c0, r0,
          per: (max * 0.32) / rows[0].length,
          max,
        }));
        return;
      }
      // Cell height is the font size here, not the 1.42 line-height _cell()
      // gives text: a banner's rows have to ABUT. At normal leading the blocks
      // sit in stripes with the background showing through and the letters read
      // as a dot grid rather than as strokes.
      const px = Math.max(7, Math.round(this.w / (rows[0].length * 1.15)));
      const cell = this._cell(px);
      cell.h = px;
      const max = rand(2900, 3500);
      this._scene('banner', o, {
        rows, text, cell,
        x0: (this.w - rows[0].length * cell.w) / 2,
        y0: y - (rows.length * cell.h) / 2,
        // Derived from the lifetime, not a constant. At a fixed 22ms per column
        // a long phrase reveals for as long as it lives: HACK THE PLANET was 90
        // columns, so it finished assembling at ~68% of its life and started
        // fading almost immediately — the bloom lesson, which this file already
        // records and which I walked straight into anyway. A short phrase and a
        // long one now both finish at a third of the way through and hold.
        per: (max * 0.32) / rows[0].length,
        max,
      });
      void x;
    }

    // The skull, ON the grid. It rezzes scattered, not in reading order (an
    // image that assembles left-to-right reads as text) — and each cell rezzes
    // out of whatever the page already says there: the real character under it
    // lights up first, then locks into the art. Then the jaw talks.
    //
    // No grid, no skull. The old floating version at its own font size is
    // exactly the "line art hanging in the window" this register replaced, and
    // a silent fallback to it would photograph well — the one failure shape
    // this repo cannot afford twice.
    _skull(x, y, o) {
      const G = o.grid;
      if (!G || !ASCII_PLAN.skull) return;
      const plan = ASCII_PLAN.skull();
      if (!plan) return;
      const c0 = Math.round(Math.min(Math.max((x - G.left) / G.cellW - plan.w / 2, 1),
        G.cols - plan.w - 1));
      const r0 = Math.round(Math.min(Math.max((y - G.top) / G.lineH - plan.h / 2, 0.5),
        G.rows - plan.h - 2.5));
      // Marry each art cell to the character really under it, once, now —
      // offsets into a scrolling transcript go stale, measured pixels don't.
      for (const cell of plan.cells) {
        cell.src = G.cells.get((r0 + cell.r) * 4096 + (c0 + cell.c)) || null;
      }
      this._scene('skull', o, Object.assign(this._gridExtra(o), {
        plan, c0, r0, lastDrop: 0,
        max: 3600,
      }));
    }

    // A wireframe solid — sphere, prism or cube — tumbling through the prose,
    // rasterised into the text's cells. Its strokes are slope glyphs where the
    // page is empty; where an edge crosses a real character, that character
    // lights up instead. The rotation is what sells it: letters catch the
    // wireframe and let it go as it turns.
    _wireframe(x, y, o) {
      const G = o.grid;
      if (!G || !ASCII_PLAN.wireframe) return;
      const shape = (o.words || []).filter(
        (w) => (A.WIREFRAME_SHAPES || []).indexOf(w) !== -1)[0] || null;
      const plan = ASCII_PLAN.wireframe(shape);
      if (!plan) return;
      const R = Math.min(G.h, G.w) * 0.30 * Math.min(o.scale, 1.4);
      this._scene('wireframe', o, Object.assign(this._gridExtra(o), {
        plan, R,
        cx: Math.min(Math.max(x, G.left + R + 30), G.left + G.w - R - 30),
        cy: Math.min(Math.max(y, G.top + R + 30), G.top + G.h - R - 30),
        max: rand(3800, 4600),
      }));
    }

    // Plasma: the demo-scene colour field, with the transcript as its raster.
    // Every word on screen becomes pixels of it — repainted in place, in the
    // page's own font, in the field's colour — and the empty cells between
    // get a faint glyph ramp so the shapes read even in the margins.
    _plasma(x, y, o) {
      const G = o.grid;
      if (!G || !ASCII_PLAN.plasma) return;
      const plan = ASCII_PLAN.plasma();
      if (!plan || !G.runs.length) return;
      // Chunk long runs so colour can vary along a line — per-word colour is
      // the cost compromise: one fillText per chunk instead of per character
      // keeps a full screen of prose near gibson's measured frame budget.
      const chunks = [];
      for (const run of G.runs) {
        for (let i = 0; i < run.text.length; i += 7) {
          chunks.push({ x: run.x + i * G.cellW, y: run.y, text: run.text.slice(i, i + 7) });
        }
      }
      const dots = [];
      const cstep = Math.max(3, Math.ceil((G.rows * G.cols) / 4200));
      for (let r = 0; r < G.rows; r++) {
        for (let c = (r % 2) * (cstep >> 1); c < G.cols; c += cstep) {
          if (!G.cells.has(r * 4096 + c)) dots.push({ c, r });
        }
      }
      this._scene('plasma', o, Object.assign(this._gridExtra(o), {
        plan, chunks, dots, palArr: o.pal,
        max: 3600,
      }));
      void x; void y;
    }

    // Concentric rings of slope glyphs rushing outward from the caret — a
    // tunnel bored through the page. Rings recolour the characters they pass
    // over; the grid is the tunnel wall.
    _tunnel(x, y, o) {
      const G = o.grid;
      if (!G || !ASCII_PLAN.tunnel) return;
      const plan = ASCII_PLAN.tunnel();
      if (!plan) return;
      const cx = Math.min(Math.max(x, G.left + 60), G.left + G.w - 60);
      const cy = Math.min(Math.max(y, G.top + 60), G.top + G.h - 60);
      const dx = Math.max(cx - G.left, G.left + G.w - cx);
      const dyc = Math.max(cy - G.top, G.top + G.h - cy);
      this._scene('tunnel', o, Object.assign(this._gridExtra(o), {
        plan, cx, cy, palArr: o.pal,
        maxR: Math.sqrt(dx * dx + dyc * dyc),
        max: 3400,
      }));
    }

    // Doom fire, built of characters, climbing from the bottom edge: the
    // firewall, literally. The heat field is the classic cellular automaton
    // (stepFirewall, pure and tested); the draw maps heat to a glyph ramp and
    // an ember gradient. Prose standing in the fire is painted as its own
    // characters gone hot — fuel, not casualty: the DOM text underneath is
    // untouched and walks out unburnt when the scene fades.
    _firewall(x, y, o) {
      const G = o.grid;
      if (!G || !ASCII_PLAN.firewall) return;
      const plan = ASCII_PLAN.firewall();
      if (!plan) return;
      const cols = Math.min(G.cols + 2, 220);
      this._scene('firewall', o, {
        // Deliberately NOT _gridExtra: the firewall is pinned to the viewport
        // bottom, not to the text — a wall doesn't scroll away with the prose.
        grid: G, vOff: this._vOff(G),
        heat: new Array(cols * plan.rows).fill(0),
        cols, frows: plan.rows, acc: 0, stepMs: plan.stepMs,
        palArr: o.pal,
        max: 3200,
      });
      void x; void y;
    }

    // The cat. Pops out of the prose near the caret, walks the lines of text
    // like ledges, drops to lower lines, sits, blinks, wanders off. Platforms
    // are the renderer's measured line segments; o.platforms is a closure so
    // the cat can re-measure as the transcript grows under it.
    _cat(x, y, o) {
      if (!o.platforms || !ASCII_PLAN.cat || !A.CAT_FRAMES) return;
      const G = o.grid;
      if (!G) return;
      const plan = ASCII_PLAN.cat();
      const plats = o.platforms();
      const minW = A.CAT_W * G.cellW * 1.6;
      let best = null, bd = Infinity;
      for (const p of plats) {
        if (p.x1 - p.x0 < minW) continue;
        const d = Math.abs(p.y - y) + Math.abs((p.x0 + p.x1) / 2 - x) * 0.1;
        if (d < bd) { bd = d; best = p; }
      }
      if (!best) return;
      const w = A.CAT_FRAMES.walkA[0].length * G.cellW;
      const cx = Math.min(Math.max(x - w / 2, best.x0), best.x1 - w);
      const mirror = {};
      for (const k in A.CAT_FRAMES) mirror[k] = A.mirrorCatFrame(A.CAT_FRAMES[k]);
      const pal = o.pal || PALETTES.gold;   // a cat is a tabby unless told otherwise
      const S = this._scene('cat', o, Object.assign(this._gridExtra(o), {
        plan, plats, getPlats: o.platforms, plat: best,
        x: cx, y: best.y, vy: 0,
        st: 'pop', stT: 0, dir: plan.dir,
        frames: A.CAT_FRAMES, mirrorFrames: mirror,
        refresh: 700,
        pal,
        color: _rgb(pal[1] || pal[0]),
        accent: _rgb(pal[3] || pal[0]),
        max: plan.life,
      }));
      // It pops OUT of the text: a puff of dust where it surfaces.
      if (S) this.emit(cx + w / 2, best.y, { n: 10, colors: S.pal, spread: 2.4 });
    }

    // The cat's whole day: a small platformer AI, run from _update so it gets
    // real dt. States: pop -> walk <-> sit -> fall -> land -> walk, and every
    // transition is driven by the measured geometry of the prose.
    _updateCat(S, dt) {
      S.stT += dt;
      S.refresh -= dt;
      const drift = S.scrollY ? (S.scrollY() - S.scroll0) : 0;
      const G = S.grid;
      const w = S.frames.walkA[0].length * G.cellW;
      const feet = () => S.x + w / 2;
      if (S.refresh <= 0 && S.getPlats) {
        S.refresh = 700;
        // Re-measured platforms arrive in NOW-coordinates; the cat lives in
        // snapshot coordinates (the draw shifts everything by the scroll
        // delta), so shift them back into its frame.
        S.plats = S.getPlats().map((p) => ({ x0: p.x0, x1: p.x1, y: p.y + drift }));
        let again = null, ad = 8;
        for (const p of S.plats) {
          const d = Math.abs(p.y - S.y);
          if (d < ad && feet() >= p.x0 - 6 && feet() <= p.x1 + 6) { ad = d; again = p; }
        }
        if (again) S.plat = again;
      }
      const below = () => {
        for (const p of S.plats) {
          if (p.y > S.y + 4 && p.y < S.y + G.lineH * 14
            && feet() >= p.x0 - 4 && feet() <= p.x1 + 4) return p;
        }
        return null;
      };
      if (S.st === 'pop') {
        if (S.stT > 340) { S.st = 'walk'; S.stT = 0; }
      } else if (S.st === 'walk') {
        S.x += S.dir * S.plan.speed * dt;
        if (Math.random() < S.plan.sitP * dt) { S.st = 'sit'; S.stT = 0; S.sitFor = 900 + rand(0, 1300); }
        const past = S.dir < 0 ? feet() < S.plat.x0 : feet() > S.plat.x1;
        if (past) {
          if (below()) { S.st = 'fall'; S.stT = 0; S.vy = 0; }
          else if (feet() < G.left - 30 || feet() > G.left + G.w + 30) { S.life = S.max; }
          else { S.dir = -S.dir; }   // no ground below: think better of it
        }
      } else if (S.st === 'sit') {
        if (S.stT > S.sitFor) {
          if (Math.random() < S.plan.turnP) S.dir = -S.dir;
          S.st = 'walk'; S.stT = 0;
        }
      } else if (S.st === 'fall') {
        S.vy += 0.0035 * dt;
        const ny = S.y + S.vy * dt;
        let hit = null;
        for (const p of S.plats) {
          if (p.y >= S.y - 1 && p.y <= ny && feet() >= p.x0 - 4 && feet() <= p.x1 + 4) {
            if (!hit || p.y < hit.y) hit = p;
          }
        }
        if (hit) {
          S.y = hit.y; S.plat = hit; S.vy = 0; S.st = 'land'; S.stT = 0;
          this.emit(feet(), S.y - drift, { n: 6, colors: S.pal, spread: 1.6 });
        } else {
          S.y = ny;
          if (S.y - drift > G.top + G.h + G.lineH * 2) S.life = S.max;
        }
      } else if (S.st === 'land') {
        if (S.stT > 220) { S.st = 'walk'; S.stT = 0; }
      }
    }

    _drawAscii(ctx, S) {
      const t = S.life / S.max;
      // Hold, then go. An effect that eases across its whole lifetime finishes
      // forming once it's already two-thirds faded â the bloom lesson.
      const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1;
      if (fade <= 0) return;
      ctx.save();
      ctx.textBaseline = 'top';
      // Scenes that live on the text ride WITH the text. Their coordinates are
      // viewport coordinates from snapshot time; the transcript has kept
      // scrolling since (same aliasing salvage pays for), so shift the whole
      // scene by how far it moved. Scenes without scrollY — the viewport-pinned
      // ones — get zero.
      if (S.scrollY) ctx.translate(0, S.scroll0 - S.scrollY());

      if (S.kind === 'gibson') {
        // A plain pinhole projection: screen = focal * ground / z. The horizon
        // is where z = infinity, so it's just cy, and the ground plane falls
        // away below it as z shrinks.
        //
        // The first version divided the ground offset by a constant as well as
        // by z, which collapsed 26 units of depth into about 100px of screen â
        // every tower landed in one thin band on the horizon and the city read
        // as a smear of specks. It painted, on-screen, in its own glyphs, and
        // the probe called it green. Only looking at it found this.
        const cx = this.w / 2, cy = this.h * 0.42;
        const FOCAL = this.w * 0.42;
        const CAM_H = 2.0;     // ground units the eye rides above the plane
        const STOREY = 0.55;   // ground units per floor
        const CELLW = 0.38;    // ground units per window column
        // Far towers first: the near ones have to occlude them.
        const order = S.towers.slice().sort((a, b) => b.z - a.z);
        for (const tw of order) {
          if (tw.z <= 0.6) continue;
          const k = FOCAL / tw.z;
          const px = cx + tw.gx * k;
          const cw = CELLW * k, chh = STOREY * k;
          if (px < -this.w || px > this.w * 2) continue;
          const base = cy + CAM_H * k;
          const top = base - tw.rows * chh;
          if (base < 0 || top > this.h) continue;
          // Atmospheric falloff. Tuned so the mid-distance is still a city
          // rather than a rumour: at 1.6/z the whole middle of the plane sat
          // under 20% alpha and only the two nearest towers read.
          const depth = Math.max(0.1, Math.min(1, 5 / tw.z));
          const a = fade * depth;
          // The wireframe: the Gibson was drawn in lines before it was ever
          // drawn in blocks.
          ctx.strokeStyle = 'rgba(' + (tw.lit ? S.accent : S.color) + ',' + a * 0.7 + ')';
          ctx.lineWidth = Math.max(0.5, k * 0.006);
          ctx.strokeRect(px, top, cw * tw.cols, base - top);
          ctx.font = Math.max(3, chh * 0.92) + 'px ' + MONO;
          for (let r = 0; r < tw.rows; r++) {
            for (let c = 0; c < tw.cols; c++) {
              const gx = px + c * cw, gy = base - (r + 1) * chh;
              // Cull per glyph, not just per tower. A near tower is mostly
              // off-screen by design â you're flying through the city, not
              // looking at a postcard of it â but the storeys above the top
              // edge still cost a fillText each. The probe measured 1883 of
              // these landing outside the viewport in a 1.4s sample, against a
              // documented frame knee this engine is already close to.
              if (gx < -cw || gx > this.w || gy < -chh || gy > this.h) continue;
              const lit = tw.lit && ((r * 7 + c * 3 + (tw.rows | 0)) % 3 === 0);
              this._fillText(ctx, lit ? '#' : '=', gx, gy,
                lit ? S.accent : S.color, a * (lit ? 0.95 : 0.4));
            }
          }
        }
      } else if (S.kind === 'crack') {
        const P = S.plan, C = S.cell;
        const w = P.cells.length * C.w;
        const x0 = S.cx - w / 2;
        ctx.font = C.px + 'px ' + MONO;
        this._fillText(ctx, 'BRUTE FORCE', x0, S.cy - C.h * 1.5, S.dim, fade * 0.6);
        for (let i = 0; i < P.cells.length; i++) {
          const cell = P.cells[i];
          const locked = S.life >= cell.lockAt;
          const ch = locked ? cell.ch : CRACK_CHARSET[(Math.random() * CRACK_CHARSET.length) | 0];
          const a = fade * (locked ? 1 : 0.45);
          this._fillText(ctx, ch, x0 + i * C.w, S.cy, locked ? S.color : S.dim, a);
          if (locked) {
            const sprite = glowSprite('rgb(' + S.color + ')');
            const d = C.px * 1.6;
            ctx.globalAlpha = fade * 0.5;
            ctx.drawImage(sprite, x0 + i * C.w - d * 0.2, S.cy + C.px * 0.4 - d / 2, d, d);
            ctx.globalAlpha = 1;
          }
        }
        if (S.life >= P.doneAt) {
          this._fillText(ctx, '** ACCESS GRANTED **', x0, S.cy + C.h * 1.4, S.accent, fade);
        }
      } else if (S.kind === 'banner' && S.ink) {
        // On the grid: each ink cell is a solid block one character wide, one
        // line tall — and where a block landed on a real character, that
        // character is knocked out of it in page-black, so the prose shows
        // through the letters.
        const G = S.grid;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const bg = this._bgRgb(G);
        for (const cell of S.ink) {
          if (S.life < cell.c * S.per) continue;
          const pop = Math.min(1, (S.life - cell.c * S.per) / 180);
          const col = cell.r < 2 ? S.accent : S.color;
          ctx.fillStyle = 'rgba(' + col + ',' + fade * (0.30 + pop * 0.58) + ')';
          ctx.fillRect(G.left + (S.c0 + cell.c) * G.cellW,
            G.top + (S.r0 + cell.r) * G.lineH, G.cellW + 0.5, G.lineH + 0.5);
          if (cell.src) {
            this._fillText(ctx, cell.src.ch, cell.src.x, cell.src.y + S.vOff,
              bg, fade * 0.92);
          }
        }
      } else if (S.kind === 'banner') {
        const C = S.cell;
        ctx.font = C.px + 'px ' + MONO;
        for (let r = 0; r < S.rows.length; r++) {
          for (let c = 0; c < S.rows[r].length; c++) {
            if (S.rows[r][c] !== '#') continue;
            if (S.life < c * S.per) continue;
            const age = S.life - c * S.per;
            const pop = Math.min(1, age / 180);
            this._fillText(ctx, '█', S.x0 + c * C.w, S.y0 + r * C.h,
              r < 2 ? S.accent : S.color, fade * (0.35 + pop * 0.65));
          }
        }
      } else if (S.kind === 'skull') {
        const G = S.grid, P = S.plan;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const drop = A.jawDropAt ? A.jawDropAt(S.life, P.chomps) : 0;
        // The veil: make room on the page without erasing it. It fades with
        // the scene, and the prose underneath walks out untouched.
        const bg = this._bgRgb(G);
        const pad = G.cellW * 2;
        ctx.fillStyle = 'rgba(' + bg + ',' + fade * 0.82 + ')';
        ctx.beginPath();
        ctx.roundRect(G.left + S.c0 * G.cellW - pad, G.top + S.r0 * G.lineH - pad * 0.6,
          P.w * G.cellW + pad * 2, (P.h + P.drop) * G.lineH + pad * 1.2, 10);
        ctx.fill();
        for (const cell of P.cells) {
          if (S.life < cell.at) continue;
          const gx = G.left + (S.c0 + cell.c) * G.cellW;
          const gy = G.top + (S.r0 + cell.r) * G.lineH
            + (cell.jaw ? drop * G.lineH : 0) + S.vOff;
          if (S.life < cell.lockAt) {
            // Rezzing: the character that was REALLY there lights up in place
            // — the skull assembles out of the page — and bare ground spins
            // junk until it locks.
            if (cell.src) {
              this._fillText(ctx, cell.src.ch, cell.src.x, cell.src.y + S.vOff,
                S.accent, fade * 0.9);
            } else {
              this._fillText(ctx, CRACK_CHARSET[(Math.random() * CRACK_CHARSET.length) | 0],
                gx, gy, S.dim, fade * 0.55);
            }
          } else {
            const pop = Math.min(1, (S.life - cell.lockAt) / 180);
            let a = fade * (0.45 + 0.55 * pop);
            let col = S.color;
            if (cell.eye) { col = S.accent; a *= 0.72 + 0.28 * Math.sin(S.life / 130); }
            this._fillText(ctx, cell.ch, gx, gy, col, a);
          }
        }
      } else if (S.kind === 'portscan') {
        const C = S.cell;
        const yo = S.font ? S.vOff : 0;
        if (S.font) ctx.textBaseline = 'alphabetic';
        ctx.font = C.px + 'px ' + (S.font || MONO);
        this._fillText(ctx, 'PORT     STATE     SERVICE', S.box.x, S.box.y - C.h + yo, S.dim, fade * 0.7);
        for (let i = 0; i < S.ports.length; i++) {
          if (S.life < i * S.per) continue;
          const p = S.ports[i];
          const col = i % S.perRow, row = (i / S.perRow) | 0;
          const open = p.state === 'open';
          const txt = (p.port + '/tcp').padEnd(11) + p.state.padEnd(9) + p.svc;
          this._fillText(ctx, txt, S.box.x + col * C.w * 21, S.box.y + row * C.h + yo,
            open ? S.color : S.dim, fade * (open ? 1 : 0.42));
        }
      } else if (S.kind === 'overflow') {
        const C = S.cell, P = S.plan;
        const yo = S.font ? S.vOff : 0;
        if (S.font) ctx.textBaseline = 'alphabetic';
        ctx.font = C.px + 'px ' + (S.font || MONO);
        const filled = Math.min(P.flood, Math.floor(S.life / S.per));
        const bar = '+' + '-'.repeat(34) + '+';
        this._fillText(ctx, bar, S.box.x, S.box.y + yo, S.dim, fade * 0.7);
        for (let i = 0; i < P.rows.length; i++) {
          const r = P.rows[i];
          // Filled bottom-up: the last row in the list floods first.
          const smashed = filled > (P.rows.length - 1 - i);
          const val = smashed ? P.smashed : r.val;
          const txt = '| ' + r.label + ' ' + ('0x' + (r.addr >>> 0).toString(16)) + '  ' + val + ' |';
          const isRet = r.kind === 'ret';
          this._fillText(ctx, txt, S.box.x, S.box.y + (i + 1) * C.h + yo,
            smashed ? (isRet ? S.accent : S.color) : S.dim,
            fade * (smashed ? 1 : 0.5));
        }
        this._fillText(ctx, bar, S.box.x, S.box.y + (P.rows.length + 1) * C.h + yo, S.dim, fade * 0.7);
        if (filled >= P.flood) {
          this._fillText(ctx, 'eip = ' + P.smashed + '  -> ' + 'AAAA'.repeat(2),
            S.box.x, S.box.y + (P.rows.length + 2.4) * C.h + yo, S.accent, fade);
        }
      } else if (S.kind === 'wireframe') {
        const G = S.grid, P = S.plan;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const ramp = Math.min(1, S.life / 260);
        // Three rotations, unrolled: tilt about z (fixed, from the plan), then
        // the two live tumbles about y and x. Projection is a plain pinhole —
        // the same one gibson uses — with +z toward the viewer.
        const a1 = S.life * P.rateA, a2 = S.life * P.rateB;
        const cT = Math.cos(P.tilt), sT = Math.sin(P.tilt);
        const cA = Math.cos(a1), sA = Math.sin(a1);
        const cB = Math.cos(a2), sB = Math.sin(a2);
        const F = 3;
        const pts = P.verts.map((v) => {
          const x1 = v[0] * cT - v[1] * sT, y1 = v[0] * sT + v[1] * cT, z1 = v[2];
          const x2 = x1 * cA + z1 * sA, z2 = -x1 * sA + z1 * cA;
          const y3 = y1 * cB - z2 * sB, z3 = y1 * sB + z2 * cB;
          const k = F / (F - z3);
          return { x: S.cx + x2 * S.R * k, y: S.cy + y3 * S.R * k, z: z3 };
        });
        const seen = new Set();
        for (const e of P.edges) {
          const p0 = pts[e[0]], p1 = pts[e[1]];
          const glyph = A.slopeGlyph(p1.x - p0.x, p1.y - p0.y);
          const aa = fade * ramp * (0.30 + 0.55 * ((p0.z + p1.z) / 2 + 1) / 2);
          const cells = A.rasterCells(
            (p0.x - G.left) / G.cellW, (p0.y - G.top) / G.lineH,
            (p1.x - G.left) / G.cellW, (p1.y - G.top) / G.lineH);
          for (const cc of cells) {
            if (cc.c < 0 || cc.r < 0 || cc.c >= G.cols || cc.r >= G.rows) continue;
            const key = cc.r * 4096 + cc.c;
            if (seen.has(key)) continue;
            seen.add(key);
            const real = G.cells.get(key);
            // The incorporation rule: a stroke crossing a real character
            // lights THAT character up — the prose catches the wireframe and
            // lets it go as it turns.
            if (real) {
              this._fillText(ctx, real.ch, real.x, real.y + S.vOff,
                S.accent, Math.min(1, aa + 0.25));
            } else {
              this._fillText(ctx, glyph, G.left + cc.c * G.cellW,
                G.top + cc.r * G.lineH + S.vOff, S.color, aa);
            }
          }
        }
        // Joints, bright — but only on solids with corners. A sphere's rings
        // are smooth; dotting their sample points reads as measles.
        if (P.kind !== 'sphere') {
          for (const p of pts) {
            const cc = Math.round((p.x - G.left) / G.cellW);
            const rr = Math.round((p.y - G.top) / G.lineH);
            if (cc < 0 || rr < 0 || cc >= G.cols || rr >= G.rows) continue;
            this._fillText(ctx, 'o', G.left + cc * G.cellW,
              G.top + rr * G.lineH + S.vOff,
              S.accent, fade * ramp * (0.5 + 0.5 * (p.z + 1) / 2));
          }
        }
      } else if (S.kind === 'plasma') {
        const G = S.grid, P = S.plan;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const inout = Math.min(1, S.life / 380, Math.max(0, (S.max - S.life) / 420));
        if (inout <= 0) { ctx.restore(); return; }
        const tt = S.life * P.speed;
        const bg = this._bgRgb(G);
        const rh = G.rh || G.lineH;
        // The prose is the raster: every chunk of it repainted in place, in
        // the field's colour, over a knockout of the page background so the
        // recolour replaces the character instead of doubling it.
        for (const chk of S.chunks) {
          const v = A.plasmaField(chk.x, chk.y, tt, P);
          ctx.fillStyle = 'rgba(' + bg + ',' + inout * 0.9 + ')';
          ctx.fillRect(chk.x - 1, chk.y, chk.text.length * G.cellW + 2, rh);
          ctx.fillStyle = S.palArr
            ? 'rgba(' + _rgb(S.palArr[Math.min(S.palArr.length - 1,
              (((v + 1) / 2) * S.palArr.length) | 0)]) + ',' + inout + ')'
            : 'hsla(' + (P.hue0 + v * 110 + S.life * 0.05) % 360 + ',95%,64%,' + inout + ')';
          ctx.fillText(chk.text, chk.x, chk.y + S.vOff);
        }
        // Faint ramp glyphs in the empty cells, so the field has a body where
        // the page has margins.
        const RAMP = ' ·:+*#';
        for (const d of S.dots) {
          const gx = G.left + d.c * G.cellW, gy = G.top + d.r * G.lineH;
          const v = A.plasmaField(gx, gy, tt, P);
          const k = (v + 1) / 2;
          if (k < 0.45) continue;
          const g = RAMP[Math.min(RAMP.length - 1, (((k - 0.45) / 0.55) * RAMP.length) | 0)];
          if (g === ' ') continue;
          ctx.fillStyle = S.palArr
            ? 'rgba(' + _rgb(S.palArr[Math.min(S.palArr.length - 1, (k * S.palArr.length) | 0)]) + ',' + inout * 0.2 + ')'
            : 'hsla(' + (P.hue0 + v * 110 + S.life * 0.05) % 360 + ',95%,60%,' + inout * 0.2 + ')';
          ctx.fillText(g, gx, gy + S.vOff);
        }
      } else if (S.kind === 'tunnel') {
        const G = S.grid, P = S.plan;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const inout = Math.min(1, S.life / 300, Math.max(0, (S.max - S.life) / 380));
        if (inout <= 0) { ctx.restore(); return; }
        const phase = (S.life * P.speed) % P.spacing;
        const seen = new Set();
        for (let rr = phase; rr < S.maxR; rr += P.spacing) {
          if (rr < 10) continue;
          const kk = rr / S.maxR;
          const aa = inout * (kk < 0.15 ? kk / 0.15 : 1 - kk * 0.6);
          if (aa <= 0.03) continue;
          const hue = (P.hue0 + rr * 0.45 + S.life * P.hueRate) % 360;
          // Sample the circle at roughly one cell per step; big rings get a
          // coarser step so the outermost ring can't outspend the rest of the
          // scene put together.
          const step = Math.max(G.cellW * 1.2, rr * 0.045);
          const na = Math.max(10, (Math.PI * 2 * rr / step) | 0);
          for (let i = 0; i < na; i++) {
            const ang = i / na * TAU;
            const px = S.cx + Math.cos(ang) * rr, py = S.cy + Math.sin(ang) * rr;
            const cc = Math.round((px - G.left) / G.cellW);
            const r2 = Math.round((py - G.top) / G.lineH);
            if (cc < 0 || r2 < 0 || cc >= G.cols || r2 >= G.rows) continue;
            const key = r2 * 4096 + cc;
            if (seen.has(key)) continue;
            seen.add(key);
            const real = G.cells.get(key);
            const head = S.palArr
              ? 'rgba(' + _rgb(S.palArr[((rr / P.spacing) | 0) % S.palArr.length]) + ','
              : 'hsla(' + hue + ',92%,' + (real ? 70 : 58) + '%,';
            ctx.fillStyle = head + aa * (real ? 1 : 0.85) + ')';
            // Rings are drawn in tangent glyphs; prose the ring crosses is
            // recoloured in place instead.
            if (real) ctx.fillText(real.ch, real.x, real.y + S.vOff);
            else ctx.fillText(A.slopeGlyph(-Math.sin(ang), Math.cos(ang)),
              G.left + cc * G.cellW, G.top + r2 * G.lineH + S.vOff);
          }
        }
        // The mouth of it. Hue quantised so glowSprite's cache stays finite.
        const spr = glowSprite(S.palArr ? S.palArr[0]
          : 'hsl(' + Math.round(((P.hue0 + S.life * P.hueRate) % 360) / 30) * 30 + ',92%,60%)');
        ctx.globalAlpha = inout * 0.5;
        ctx.drawImage(spr, S.cx - 45, S.cy - 45, 90, 90);
        ctx.globalAlpha = 1;
      } else if (S.kind === 'firewall') {
        const G = S.grid;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const RAMP = A.FIREWALL_RAMP || ' .:;+*x%#@';
        const MAXH = A.FIREWALL_MAX_HEAT || 36;
        for (let r2 = 0; r2 < S.frows; r2++) {
          const gy = G.top + G.h - (S.frows - r2) * G.lineH;
          const rowIdx = Math.round((gy - G.top) / G.lineH);
          for (let c2 = 0; c2 < S.cols; c2++) {
            const h2 = S.heat[r2 * S.cols + c2];
            if (h2 < 4) continue;
            const k = h2 / MAXH;
            const real = G.cells.get(rowIdx * 4096 + (c2 - 1));
            const hot = real && k > 0.3;
            const glyph = hot ? real.ch
              : RAMP[Math.min(RAMP.length - 1, (k * RAMP.length) | 0)];
            if (glyph === ' ') continue;
            ctx.fillStyle = (S.palArr
              ? 'rgba(' + _rgb(S.palArr[Math.min(S.palArr.length - 1, ((1 - k) * S.palArr.length) | 0)]) + ','
              : 'hsla(' + (4 + k * 44) + ',96%,' + (28 + k * 44 + (k > 0.9 ? 18 : 0)) + '%,')
              + fade * Math.min(1, k * 1.6) * 0.92 + ')';
            // Prose standing in the fire is painted as itself, gone hot —
            // fuel, not casualty. The DOM text is untouched underneath.
            if (hot) ctx.fillText(glyph, real.x, real.y + S.vOff);
            else ctx.fillText(glyph, G.left + (c2 - 1) * G.cellW, gy + S.vOff);
          }
        }
      } else if (S.kind === 'cat') {
        const G = S.grid;
        ctx.font = this._gridFont(G);
        ctx.textBaseline = 'alphabetic';
        const F = S.dir < 0 ? S.mirrorFrames : S.frames;
        let frame;
        if (S.st === 'pop') frame = F.sit;
        else if (S.st === 'sit') frame = (S.life % 1400) < 220 ? F.blink : F.sit;
        else if (S.st === 'fall') frame = F.fall;
        else if (S.st === 'land') frame = F.land;
        else {
          frame = ((S.stT / S.plan.stepMs) | 0) % 2 ? F.walkB : F.walkA;
          if ((S.life % S.plan.blinkEvery) < 150) frame = F.blink;
        }
        const bob = S.st === 'walk' ? Math.sin(S.life / 130) * 1.2 : 0;
        const out = Math.min(1, Math.max(0, (S.max - S.life) / 260));
        // A soft knockout behind the sprite, so the cat reads IN FRONT of the
        // prose rather than tangled in its letters. The text underneath is
        // untouched and walks back out the moment the cat does.
        ctx.fillStyle = 'rgba(' + this._bgRgb(G) + ',' + fade * out * 0.72 + ')';
        ctx.fillRect(S.x - 2, S.y - frame.length * G.lineH + bob - 2,
          frame[0].length * G.cellW + 4, frame.length * G.lineH + 4);
        for (let r2 = 0; r2 < frame.length; r2++) {
          // Popping out of the line: face first, ears a beat later.
          if (S.st === 'pop' && S.stT < 170 && r2 === 0) continue;
          const gy = S.y - (frame.length - r2) * G.lineH + bob + S.vOff;
          for (let k = 0; k < frame[r2].length; k++) {
            const ch = frame[r2][k];
            if (ch === ' ') continue;
            const face = r2 === 1 && k > 1 && k < frame[r2].length - 2
              && 'oO^-.<>'.indexOf(ch) !== -1;
            this._fillText(ctx, ch, S.x + k * G.cellW, gy,
              face ? S.accent : S.color, fade * out);
          }
        }
      } else {
        // The line panes: wardial, sniffer, trace, daemon.
        const C = S.cell;
        const yo = S.font ? S.vOff : 0;
        if (S.font) ctx.textBaseline = 'alphabetic';
        ctx.font = C.px + 'px ' + (S.font || MONO);
        const shown = Math.min(S.lines.length, Math.floor(S.life / S.per) + 1);
        const first = Math.max(0, shown - S.rows);
        if (S.title) this._fillText(ctx, '$ ' + S.title, S.box.x, S.box.y - C.h + yo, S.dim, fade * 0.75);
        for (let i = first; i < shown; i++) {
          const L = S.lines[i];
          const y = S.box.y + (i - first) * C.h;
          const fresh = S.life - i * S.per < 160;
          this._fillText(ctx, L.text, S.box.x, y + yo,
            L.hit ? S.accent : S.color,
            fade * (L.hit ? 1 : fresh ? 0.95 : 0.55));
        }
      }
      ctx.restore();
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
        || this.sheets.length || this.sweeps.length || this.links || this.webs
        || this.frost || this.matrix || this.ascii.length
        || this.noise || this.grid || this.traces || this.tracers;
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
          if (this.under) this.under.clearRect(0, 0, this.w, this.h);
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
        if (p.life >= p.max + (p.delay || 0)) {
          // Last chance to hand a flier's character back to the DOM. It has to
          // happen here rather than at t>=1 in the fly branch below, because a
          // particle is dropped on the frame its life runs out and never gets
          // that update â a flier would vanish one frame short of its target
          // and the character it was carrying would never be revealed.
          if (p.onLand && !p.landed) { p.landed = true; p.onLand(); }
          continue;
        }

        if (p.mode === 'fly') {
          // Quadratic bezier, eased both ends: it leaves reluctantly and
          // settles rather than slamming. Position is computed from t rather
          // than integrated, so the landing is exact â a velocity-driven flier
          // misses its target by whatever the last frame's dt happened to be,
          // and "exactly on the character" is the entire illusion.
          const t = Math.min(1, (p.life - (p.delay || 0)) / p.max);
          const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
          const u = 1 - e;
          p.x = u * u * p.x0 + 2 * u * e * p.cx + e * e * p.x1;
          p.y = u * u * p.y0 + 2 * u * e * p.cy + e * e * p.y1;
          if (p.drift) p.y += p.drift0 - p.drift();
        } else if (p.mode === 'polar') {
          p.ang += p.vang * f;
          p.rad = Math.max(0, p.rad + p.vrad * f);
          p.x = p.cx + Math.cos(p.ang) * p.rad;
          p.y = p.cy + Math.sin(p.ang) * p.rad;
        } else if (p.mode === 'rose') {
          // r = RÂ·|cos(kÂ·Î¸)| traces a 2k-petalled rose. Each particle keeps its
          // own Î¸ and rides out along the petal it sits under as the bloom
          // opens; rfrac is how deep under the rim it sits.
          const t = (p.life - (p.delay || 0)) / p.max;
          const th = p.ang + p.spin * p.life;
          // Open fast, then hold. A particle's alpha is 1-t, so an `open` that
          // eases across the whole life means the flower only finishes forming
          // once it's already two-thirds faded â fully shaped and nearly
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
      for (const b of this.bolts) {
        b.life += dt;
        // The return stroke: the tip has reached the word. Everything the
        // strike does â the flash, the sparks, the fire â hangs off this one
        // moment rather than off the directive firing, because the directive
        // fires while the leader is still somewhere up in the dark.
        if (!b.struck && b.life - (b.delay || 0) >= b.grow) {
          b.struck = true;
          this._flash(b.color ? `rgba(${b.color},0.5)` : 'rgba(220,244,255,0.58)');
          this._strikeBurst(b.target.x, b.target.y, { scale: 1 });
          if (b.onStrike) { try { b.onStrike(b.index); } catch (e) { /* a burn that won't start must not take the frame loop with it */ } }
        }
        if (b.life < b.max + (b.delay || 0)) bk.push(b);
      }
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

      // Apophenia's points don't drift: they're pinned to words that are really
      // there. It's only the lines between them that are invented.
      if (this.webs) {
        this.webs.life += dt;
        if (this.webs.life >= this.webs.max) this.webs = null;
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

      // Every ASCII scene ages the same way and reaps itself. Splicing from the
      // back so a scene expiring can't skip the one behind it.
      for (let i = this.ascii.length - 1; i >= 0; i--) {
        const S = this.ascii[i];
        S.life += dt;
        // The only scene with motion in it: the city is flown through, the
        // rest are typed. Towers recycle to the back rather than dying, so a
        // long gibson can't quietly run out of city and hold on an empty
        // ground plane â the same reason tracer wraps instead of expiring.
        if (S.kind === 'gibson') {
          for (const tw of S.towers) {
            tw.z -= S.speed * dt;
            if (tw.z <= 0.5) { tw.z += 26; tw.gx = rand(-9, 9); }
          }
        }
        // The grid register's moving parts. Fire steps its automaton on a
        // fixed clock (heat spread at rAF rate would burn twice as fast on a
        // 120Hz panel); the cat runs its little platformer brain; the skull's
        // jaw clacks sparks on the way shut.
        if (S.kind === 'firewall' && A.stepFirewall) {
          S.acc += dt;
          while (S.acc >= S.stepMs) {
            A.stepFirewall(S.heat, S.cols, S.frows, Math.random);
            S.acc -= S.stepMs;
          }
        }
        if (S.kind === 'cat') this._updateCat(S, dt);
        if (S.kind === 'skull' && A.jawDropAt) {
          const drop = A.jawDropAt(S.life, S.plan.chomps);
          if (S.lastDrop - drop > 0.5) {
            const G = S.grid;
            const drift = S.scrollY ? (S.scrollY() - S.scroll0) : 0;
            this.emit(G.left + (S.c0 + S.plan.w / 2) * G.cellW,
              G.top + (S.r0 + S.plan.jawTop) * G.lineH - drift,
              { n: 12, colors: ['#ffffff', '#dff3ff'], speedMax: 4.2, lifeMax: 420 });
          }
          S.lastDrop = drop;
        }
        if (S.life >= S.max) this.ascii.splice(i, 1);
      }

      if (this.noise) { this.noise.life += dt; if (this.noise.life >= this.noise.max) this.noise = null; }
      if (this.grid) { this.grid.life += dt; if (this.grid.life >= this.grid.max) this.grid = null; }
      if (this.traces) { this.traces.life += dt; if (this.traces.life >= this.traces.max) this.traces = null; }

      if (this.tracers) {
        this.tracers.life += dt;
        for (const h of this.tracers.heads) {
          h.since += dt;
          if (h.since >= h.nextTurn) {
            h.since = 0; h.nextTurn = rand(140, 420);
            if (h.dx) { h.dy = chance(0.5) ? 1 : -1; h.dx = 0; } else { h.dx = chance(0.5) ? 1 : -1; h.dy = 0; }
          }
          h.x += h.dx * h.sp * f; h.y += h.dy * h.sp * f;
          // Wrap rather than die, so a cycle can't quietly leave the screen and
          // strand the effect with nothing to draw.
          if (h.x < -20) h.x = this.w + 20; else if (h.x > this.w + 20) h.x = -20;
          if (h.y < -20) h.y = this.h + 20; else if (h.y > this.h + 20) h.y = -20;
          h.trail.push({ x: h.x, y: h.y });
          if (h.trail.length > h.maxTrail) h.trail.shift();
        }
        if (this.tracers.life >= this.tracers.max) this.tracers = null;
      }
    }

    _draw() {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (this.under) this.under.clearRect(0, 0, this.w, this.h);

      // Aurora sits furthest back â it's a backdrop, not a burst.
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

      // Synthwave grid â behind everything, like the aurora.
      if (this.grid) {
        const G = this.grid;
        const t = G.life / G.max;
        const a = Math.sin(Math.min(1, t) * Math.PI) * 0.8;
        const hz = this.h * 0.52;          // horizon
        const cx = this.w / 2;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = `rgba(${G.color},${a * 0.5})`;
        ctx.lineWidth = 1;
        // Verticals all converge on the vanishing point.
        for (let i = -14; i <= 14; i++) {
          ctx.beginPath(); ctx.moveTo(cx, hz);
          ctx.lineTo(cx + i * 150, this.h); ctx.stroke();
        }
        // Horizontals: squaring the row fraction is what gives the ground its
        // perspective â rows bunch at the horizon and stretch toward you.
        const scroll = (G.life * G.speed) % 1;
        for (let k = 0; k < G.rows; k++) {
          const p = ((k + scroll) / G.rows);
          const y = hz + (this.h - hz) * p * p;
          ctx.strokeStyle = `rgba(${G.color},${a * (0.15 + p * 0.6)})`;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.w, y); ctx.stroke();
        }
        // A hot line on the horizon itself sells the sunset.
        ctx.strokeStyle = `rgba(255,255,255,${a * 0.5})`;
        ctx.beginPath(); ctx.moveTo(0, hz); ctx.lineTo(this.w, hz); ctx.stroke();
        ctx.restore();
      }

      // Circuit traces reveal from the edges inward, then fade.
      if (this.traces) {
        const T = this.traces;
        const t = T.life / T.max;
        const fade = t > 0.72 ? 1 - (t - 0.72) / 0.28 : 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
        for (const s of T.segs) {
          if (s.at > t * 1.5) continue;
          ctx.strokeStyle = `rgba(${T.color},${0.7 * fade})`;
          ctx.lineWidth = s.w;
          ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke();
        }
        for (const p of T.pads) {
          if (p.at > t * 1.5) continue;
          ctx.fillStyle = `rgba(${T.color},${0.85 * fade})`;
          ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.fill();
        }
        ctx.restore();
      }

      // Light-cycle trails: bright at the head, fading to the tail.
      if (this.tracers) {
        const t = this.tracers.life / this.tracers.max;
        const fade = t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const h of this.tracers.heads) {
          if (h.trail.length < 2) continue;
          const rgb = _rgb(h.color);
          for (const pass of [{ w: 7, a: 0.16 }, { w: 2.4, a: 0.55 }, { w: 1, a: 1 }]) {
            ctx.strokeStyle = `rgba(${rgb},${pass.a * fade})`;
            ctx.lineWidth = pass.w;
            ctx.beginPath();
            // A wrap teleports the head across the screen; starting a new
            // subpath on the jump stops it drawing a line back through
            // everything.
            let started = false;
            for (let i = 0; i < h.trail.length; i++) {
              const p = h.trail[i], q = h.trail[i - 1];
              if (!started || (q && Math.hypot(p.x - q.x, p.y - q.y) > 60)) { ctx.moveTo(p.x, p.y); started = true; }
              else ctx.lineTo(p.x, p.y);
            }
            ctx.stroke();
          }
          const sprite = glowSprite(h.color);
          ctx.drawImage(sprite, h.x - 9, h.y - 9, 18, 18);
        }
        ctx.restore();
      }

      if (this.matrix) {
        const fade = 1 - this.matrix.life / this.matrix.max;
        const c = this.matrix.color;
        const G = this.matrix.glyphs;
        const rg = () => G[(Math.random() * G.length) | 0];
        ctx.font = '13px monospace';
        for (const d of this.matrix.drops) {
          ctx.fillStyle = `rgba(210,255,225,${0.95 * fade})`;
          ctx.fillText(rg(), d.x, d.y);
          for (let k = 1; k < d.len; k++) {
            const ka = 0.4 - k * 0.035;
            if (ka <= 0) break;
            ctx.fillStyle = `rgba(${c},${ka * fade})`;
            ctx.fillText(rg(), d.x, d.y - k * 14);
          }
        }
      }

      // The ASCII register. After matrix (which is a backdrop) and before the
      // particles, which stay on top of everything: a scene is something the
      // machine is saying, and a spark thrown over it still reads as a spark.
      for (const S of this.ascii) this._drawAscii(ctx, S);

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

      // Apophenia: the same glowing web, argued rather than observed. Each line
      // draws itself in over its own 260ms once its turn comes, so the figure
      // accumulates like someone talking you through it.
      if (this.webs) {
        const W = this.webs;
        const t = W.life / W.max;
        const fade = t > 0.78 ? 1 - (t - 0.78) / 0.22 : 1;
        // Behind the text where there's a canvas for it: these lines run
        // between real words, and on top they strike them through.
        const wc = this.under || ctx;
        wc.save();
        wc.globalCompositeOperation = 'lighter';
        wc.lineWidth = 1.1;
        for (const pr of W.pairs) {
          const age = W.life - pr.at;
          if (age <= 0) continue;
          const a = W.pts[pr.i], b = W.pts[pr.j];
          const grow = Math.min(1, age / 260);
          // Distance is not evidence here, so unlike constellation the alpha
          // doesn't fall off with length â a line across the whole screen is
          // asserted exactly as confidently as one between neighbours.
          wc.strokeStyle = `rgba(${W.color},${(0.5 * fade).toFixed(3)})`;
          wc.beginPath();
          wc.moveTo(a.x, a.y);
          wc.lineTo(a.x + (b.x - a.x) * grow, a.y + (b.y - a.y) * grow);
          wc.stroke();
        }
        wc.globalAlpha = fade;
        for (const p of W.pts) {
          const sprite = glowSprite(p.color);
          const d = p.size * 5;
          wc.drawImage(sprite, p.x - d / 2, p.y - d / 2, d, d);
        }
        wc.restore();
        wc.globalAlpha = 1;
      }

      // Lightning: a wide soft pass under a bright core, flickering as it dies.
      for (const b of this.bolts) {
        if (b.delay && b.life < b.delay) continue;
        const age = b.life - (b.delay || 0);
        const c = b.color || '190,235,255';

        // Two acts. Growing: the leader is dim, flickery and partial â it's
        // feeling its way down and hasn't connected to anything. Struck: the
        // return stroke lights the finished channel hard and lets it decay.
        const growing = age < b.grow;
        const reveal = growing ? _revealAt(b.stair, age / b.grow) : 1;
        if (reveal <= 0) continue;

        let a, wide;
        if (growing) {
          a = 0.30 + Math.random() * 0.22;   // per-frame flicker: unsteady, unfinished
          wide = 0.55;
        } else {
          const decay = (age - b.grow) / (b.max - b.grow);
          a = Math.max(0, 1 - decay) * (0.82 + Math.random() * 0.18);
          wide = 1;
        }

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const passes = [
          { w: 9 * wide, c: `rgba(${c},${a * 0.26})` },
          { w: 3.5 * wide, c: `rgba(${c},${a * 0.7})` },
          { w: 1.4 * wide, c: `rgba(255,255,255,${a})` },
        ];
        for (const pass of passes) {
          ctx.strokeStyle = pass.c;
          ctx.lineWidth = pass.w;
          this._strokeTo(ctx, b.main, reveal);
          // A fork stays dark until the tip has actually passed the point it
          // leaves from, and then runs on its own clock â so the channel opens
          // out as it descends instead of arriving pre-branched.
          for (const fk of b.forks) {
            if (reveal < fk.at) continue;
            const fr = growing ? Math.min(1, (reveal - fk.at) / 0.18) : 1;
            if (fr <= 0) continue;
            ctx.lineWidth = pass.w * fk.w;
            this._strokeTo(ctx, fk, fr);
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

        if (p.shape === 'flyglyph') {
          // Drawn before the alpha gate below on purpose: that gate fades a
          // particle out across its life, and a salvaged letter has to be at
          // full strength on the frame it lands. This one only fades UP, off
          // its source, over the first fifth of the trip.
          //
          // Its own save/restore, against the batch's one-for-all: it needs
          // centred alignment to sit on the target character, and leaking that
          // into the shared context would shift every glyph and streak drawn
          // after it by half a character.
          const t = (p.life - (p.delay || 0)) / p.max;
          ctx.save();
          ctx.globalAlpha = Math.max(0, Math.min(1, t * 5));
          ctx.font = p.font;
          ctx.fillStyle = p.color;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.shadowBlur = 10;
          ctx.shadowColor = p.color;
          ctx.fillText(p.ch, p.x, p.y);
          ctx.restore();
          continue;
        }

        let a = 1 - (p.life - (p.delay || 0)) / p.max;
        if (a <= 0) continue;
        if (p.twinkle) a *= 0.55 + Math.random() * 0.45;
        ctx.globalAlpha = Math.max(0, Math.min(1, a));

        if (p.shape === 'glyph') {
          // Falling text: the real character degrades into junk as it drops, so
          // a word visibly stops being a word on the way down.
          const t = p.life / p.max;
          const junk = t > p.decay && chance(0.35);
          if (junk) p.ch = p.glyphs[(Math.random() * p.glyphs.length) | 0];
          ctx.font = p.size + 'px monospace';
          ctx.fillStyle = p.color;
          ctx.fillText(p.ch, p.x - p.size * 0.3, p.y);
          continue;
        }

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

      // TV static goes over everything â it's interference, not a light source.
      if (this.noise) {
        const N = this.noise;
        const a = Math.sin(Math.min(1, N.life / N.max) * Math.PI) * N.alpha;
        const buf = this._noiseBuf;
        const g = buf.getContext('2d');
        const img = g.createImageData(buf.width, buf.height);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          const v = (Math.random() * 255) | 0;
          d[i] = d[i + 1] = d[i + 2] = v;
          // Punch holes so it reads as noise rather than fog â and so the text
          // underneath stays partly legible through the gaps.
          d[i + 3] = v > 140 ? 255 : 0;
        }
        g.putImageData(img, 0, 0);
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, a));
        ctx.imageSmoothingEnabled = false;   // blocky, like a real dropout
        ctx.drawImage(buf, 0, 0, this.w, this.h);
        ctx.restore();
      }

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
          // An irregular sliver â glass, not a tile.
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
