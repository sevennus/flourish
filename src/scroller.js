/*
 * scroller.js — critically damped spring for following a moving scroll target.
 *
 * The transcript grows *while* we're scrolling to the bottom of it, so the
 * target moves every frame. That rules out a fixed-duration tween (it would
 * restart, and never settle) and rules out CSS `scroll-behavior: smooth` (the
 * browser owns the curve and re-targeting mid-flight fights itself).
 *
 * A critically damped spring is the right model: it accelerates toward the
 * target, decelerates into it, never overshoots, and re-targeting is just
 * changing a number. Integration is implicit (semi-implicit Euler would blow up
 * at the stiffnesses we want), which is unconditionally stable at any dt — so a
 * frame hitch or a background-throttled rAF can't launch the viewport.
 *
 * Pure + UMD so `node --test` can pin the invariants without a DOM.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Scroller = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Angular frequency (rad/s). Higher = tauter. Picked by measuring both ends of
  // the trade-off (tools/scroll-curve.js plots it):
  //
  //   omega |  1 line   paragraph   big dump | lag @250px/s  @700px/s
  //      14 |   700ms      917ms     1033ms  |       36px      100px
  //      26 |   450ms      567ms      633ms  |       19px       54px
  //      40 |   333ms      417ms      467ms  |       13px       35px
  //
  // 26 keeps the steady-state lag while streaming (19px) under one line height,
  // so the caret still reads as pinned to the bottom during normal typing, while
  // leaving a multi-line jump ~600ms of visible ease. Trailing a *ramp* by
  // 2*v/omega is inherent to a damped spring, not a bug — it's why omega can't
  // just be lowered for a prettier curve.
  const OMEGA = 26;

  // Below this, the spring has arrived: snap and stop. Sub-pixel scrollTop is
  // meaningless and would keep rAF alive forever chasing a rounding error.
  const EPS = 0.4;

  // A frame this long means we were throttled (hidden window, GC pause). The
  // spring stays stable regardless, but a 2s dt would teleport us — so clamp and
  // let the next frame carry on.
  const MAX_DT = 0.05;

  /**
   * Advance one critically damped spring step.
   *
   * Implicit integration of  a = omega^2 * (target - x) - 2*omega*v,  solved for
   * the *new* position and velocity simultaneously rather than stepping forward
   * from the old ones. That's what buys unconditional stability.
   *
   * @returns {{pos:number, vel:number}}
   */
  function step(pos, vel, target, dt, omega) {
    const w = omega || OMEGA;
    const h = Math.min(Math.max(dt, 0), MAX_DT);
    if (h <= 0) return { pos: pos, vel: vel };
    const f = 1 + 2 * h * w;
    const oo = w * w;
    const hoo = h * oo;
    const hhoo = h * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * pos + h * vel + hhoo * target;
    const detV = vel + hoo * (target - pos);
    return { pos: detX * detInv, vel: detV * detInv };
  }

  /** Has the spring arrived? Both near the target and nearly stopped. */
  function settled(pos, vel, target) {
    return Math.abs(target - pos) < EPS && Math.abs(vel) < EPS;
  }

  /*
   * follower — binds the spring to a scrollable element.
   *
   * Stickiness: auto-follow only while the reader is already at the bottom. The
   * moment they scroll up to re-read something, we stop yanking them back down;
   * returning to the bottom re-arms it. Without this, a long reply makes the
   * transcript unreadable while it streams.
   */
  function follower(el, opts) {
    const o = opts || {};
    const omega = o.omega || OMEGA;
    // How close to the bottom still counts as "at the bottom". One line of slack
    // isn't enough — a reader who nudges the wheel one notch still wants to be
    // carried along.
    const stickPx = o.stickPx == null ? 96 : o.stickPx;

    let pos = el.scrollTop;
    let vel = 0;
    let raf = 0;
    let last = 0;
    let following = true;
    // Set while *we* write scrollTop, so our own writes don't read as the user
    // grabbing the scrollbar in the scroll handler below.
    let selfScrolling = false;

    const maxScroll = () => Math.max(0, el.scrollHeight - el.clientHeight);
    const atBottom = () => maxScroll() - el.scrollTop <= stickPx;

    function frame(now) {
      raf = 0;
      const dt = last ? (now - last) / 1000 : 1 / 60;
      last = now;
      const target = maxScroll();

      const s = step(pos, vel, target, dt, omega);
      pos = s.pos; vel = s.vel;

      if (settled(pos, vel, target)) {
        pos = target; vel = 0;
        selfScrolling = true; el.scrollTop = pos; selfScrolling = false;
        last = 0;
        return; // arrived — stop burning rAF until something moves again
      }
      selfScrolling = true; el.scrollTop = pos; selfScrolling = false;
      raf = requestAnimationFrame(frame);
    }

    function kick() {
      if (!following || raf) return;
      // Re-seat from the DOM: the user may have dragged since we last ran, and
      // springing from a stale `pos` would jump.
      pos = el.scrollTop;
      last = 0;
      raf = requestAnimationFrame(frame);
    }

    // The reader taking over wins, always.
    el.addEventListener('scroll', () => {
      if (selfScrolling) return;
      const bottom = atBottom();
      if (!bottom && following) {
        following = false;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        vel = 0;
      } else if (bottom && !following) {
        following = true;
      }
    }, { passive: true });

    return {
      /** Content changed — chase the new bottom. */
      follow: kick,
      /** Jump with no animation (first paint, transcript reset). */
      jump() {
        following = true;
        if (raf) { cancelAnimationFrame(raf); raf = 0; }
        pos = maxScroll(); vel = 0;
        selfScrolling = true; el.scrollTop = pos; selfScrolling = false;
      },
      get following() { return following; },
    };
  }

  return { step, settled, follower, OMEGA, EPS, MAX_DT };
});
