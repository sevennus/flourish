/*
 * renderer.js — the terminal UI.
 *
 * Streams Claude Code's output (relayed from the SSH bridge in main) into a
 * dark terminal, revealing it with a typewriter and painting the flourishes the
 * model embeds. Text deltas and tool events share one ordered queue so tool
 * activity lands between the right pieces of text. Session context lives on the
 * VM (Claude Code --resume), so we only ever send the latest message.
 *
 * Classic browser script — everything it needs is on window.
 */
(function () {
  'use strict';

  const { FlourishParser, PER_CHAR_SPANS, CONSUMING_SPANS, parseArgs } = window.Flourish;
  const { AutoStyler } = window.AutoFX;
  const api = window.flourishAPI;
  const el = (id) => document.getElementById(id);

  // Which effect a tool call paints. Every tool used to fire the same spark,
  // which wasted the one signal the app gets for free — reading is not writing
  // is not searching, and they shouldn't look alike. Kept small (`sm`) because
  // these fire constantly and are punctuation, not announcements.
  const TOOL_FX = {
    Read: ['beam', 'ice'], NotebookRead: ['beam', 'ice'],
    Glob: ['beam', 'mint'], Grep: ['beam', 'mint'], LS: ['beam', 'mint'],
    Bash: ['matrix', 'mint'], BashOutput: ['matrix', 'mint'],
    Edit: ['spark', 'gold'], MultiEdit: ['spark', 'gold'],
    Write: ['spark', 'ember'], NotebookEdit: ['spark', 'gold'],
    WebSearch: ['meteor', 'ice'], WebFetch: ['meteor', 'violet'],
    Task: ['swarm', 'violet'], Agent: ['swarm', 'violet'], Workflow: ['swarm', 'violet'],
    TodoWrite: ['ripple', 'mint'], TaskCreate: ['ripple', 'mint'], TaskUpdate: ['ripple', 'mint'],
    Skill: ['bloom', 'rose'],
  };
  const DEFAULT_TOOL_FX = ['spark', 'mint'];

  const transcript = el('transcript');
  const screen = el('screen');
  const input = el('input');
  const sendBtn = el('send-btn');
  const inputRow = el('input-row');
  const effects = new window.FlourishEffects(el('fx-canvas'));
  const inputFX = new window.FlourishInputFX(input, effects, inputRow);
  const textFX = new window.FlourishTextFX(effects);

  let activeLine = null;
  let reqCounter = 0;
  let cfg = {};

  // ---------- DOM helpers ----------
  function addLine(cls, who) {
    const line = document.createElement('div');
    line.className = 'line ' + cls;
    if (who) { const w = document.createElement('div'); w.className = 'who'; w.textContent = who; line.appendChild(w); }
    const body = document.createElement('div');
    body.className = 'body'; line.appendChild(body);
    transcript.appendChild(line); scrollToEnd();
    return body;
  }
  function plainLine(cls, text) { const n = addLine(cls); n.textContent = text; scrollToEnd(); return n; }

  // The transcript is followed by a critically damped spring rather than pinned
  // with `scrollTop = scrollHeight`. The target moves while we chase it (text is
  // still arriving), so this is a "follow", not a "scroll to" — see scroller.js.
  // Call sites are unchanged: scrollToEnd() just means "content grew" now.
  const follower = window.Scroller.follower(screen);
  function scrollToEnd() { follower.follow(); }

  function caretPos(t) {
    const m = document.createElement('span'); m.textContent = '​'; t.appendChild(m);
    const r = m.getBoundingClientRect(); t.removeChild(m);
    if (r.width === 0 && r.height === 0) { const rb = t.getBoundingClientRect(); return { x: rb.right, y: rb.top + rb.height / 2 }; }
    return { x: r.left, y: r.top + r.height / 2 };
  }


  // ---------- assistant line lifecycle ----------
  function newAssistantBody(withLabel) {
    const body = addLine('assistant', withLabel ? 'claude' : null);
    const caret = document.createElement('span'); caret.className = 'caret'; body.appendChild(caret);
    return { body, caret };
  }

  function startAssistant(reqId) {
    const seg = newAssistantBody(true);
    activeLine = {
      id: reqId, body: seg.body, caret: seg.caret,
      parser: new FlourishParser(), reveal: '', queue: [],
      stack: [seg.body], streamDone: false, waveN: 0, tools: new Map(),
      auto: new AutoStyler(), autoCls: null, autoNode: null,
    };
    ensureTyping();
  }

  function target() { return activeLine.stack[activeLine.stack.length - 1]; }

  function openStyle(name, args) {
    flushAuto();   // the model's markup wins; land any buffered auto text first
    const span = document.createElement('span'); span.dataset.fx = name;
    if (name === 'color') { const h = (args || '').trim(); if (/^#[0-9a-fA-F]{3,8}$/.test(h)) span.style.color = h; }
    else span.className = 'fx-' + name;
    if (args) span.dataset.fxArgs = args;
    target().appendChild(span); activeLine.stack.push(span);
  }
  function closeStyle(name) {
    while (activeLine.stack.length > 1) {
      const top = activeLine.stack.pop();
      if (top.dataset && top.dataset.fx === name) {
        // A consuming span can only run once all its characters exist, which is
        // exactly now: the closing directive has arrived, so the span is
        // complete. (Igniting as characters streamed in would set fire to a
        // word that hadn't finished being typed.)
        if (CONSUMING_SPANS.has(name)) textFX.play(name, top, top.dataset.fxArgs || '');
        break;
      }
    }
  }
  // Some spans animate per character, so text inside them is split into <i>
  // elements instead of one text node. The innermost such span wins.
  function perCharFx() {
    const st = activeLine.stack;
    for (let i = st.length - 1; i >= 0; i--) {
      const n = st[i];
      if (n.dataset && PER_CHAR_SPANS.has(n.dataset.fx)) return n.dataset.fx;
    }
    return null;
  }

  const SCRAMBLE_GLYPHS = '!<>-_\\/[]{}=+*^?#%&@$0123456789';
  const HEX_GLYPHS = '0123456789abcdef';

  // Decode-in: flicker a character through junk glyphs before it settles.
  function scrambleIn(node, ch) {
    if (!ch.trim()) return;            // spaces/newlines stay themselves
    let left = 2 + ((Math.random() * 6) | 0);
    const tick = () => {
      if (left-- <= 0) { node.textContent = ch; node.classList.add('settled'); return; }
      node.textContent = SCRAMBLE_GLYPHS[(Math.random() * SCRAMBLE_GLYPHS.length) | 0];
      setTimeout(tick, 45);
    };
    tick();
  }

  // Like scramble, but the junk is hex — it reads as looking at the bytes
  // underneath the text rather than at a cipher.
  function hexIn(node, ch) {
    if (!ch.trim()) return;
    let left = 3 + ((Math.random() * 7) | 0);
    const tick = () => {
      if (left-- <= 0) { node.textContent = ch; node.classList.add('settled'); return; }
      node.textContent = HEX_GLYPHS[(Math.random() * 16) | 0];
      setTimeout(tick, 38);
    };
    tick();
  }

  // Spans whose per-character animation is pure CSS and just needs staggering.
  // burn and cascade are absent on purpose: textfx.js drives those from JS once
  // the span closes, and a CSS animation would fight it.
  const CSS_STAGGERED = new Set(['wave', 'bounce', 'stamp', 'corrupt', 'sparkle']);

  // ---------- soft character reveal ----------
  // Characters ease up into place instead of popping. Three constraints shape
  // this:
  //
  //  1. Copy/paste. A permanent <i> per character would wreck it (the same
  //     reason the model is told not to wrap code/numbers in spans), so a char
  //     flattens back into the preceding text node the moment its animation
  //     ends. A settled paragraph is one text node again, exactly as before —
  //     only the ~16 chars still in flight are elements.
  //  2. Perception. Past ~3 chars/frame you can't see an individual character
  //     arrive, so there's nothing to animate; this is why it keys off the
  //     typewriter's adaptive rate rather than running always. Falling behind
  //     turns it off by itself.
  //  3. Layout. The <i> is inline-block and only *transformed*, so it occupies
  //     its final box from birth — the line never reflows mid-animation.
  //
  // Whitespace is passed through as plain text: a newline inside an inline-block
  // would break *inside* the box under `white-space: pre-wrap`, and animating a
  // space is invisible work.
  const SOFT_MAX_N = 3;
  const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  let softReveal = false;

  // Append text, merging into the trailing text node so a run stays one node.
  // Named apart from appendText() below: both live in this scope, so a shared
  // name means the later declaration silently wins and every call lands in the
  // wrong function.
  function appendRaw(tgt, s) {
    const last = tgt.lastChild;
    if (last && last.nodeType === 3) last.appendData(s);
    else tgt.appendChild(document.createTextNode(s));
  }

  // Animation done — dissolve the element back into the text before it. Chars
  // settle in the order they were born, so each one finds the merged text node
  // its predecessor left behind and the run collapses to a single node.
  function onCharSettled(e) {
    const i = e.currentTarget;
    if (!i.parentNode) return;
    const prev = i.previousSibling;
    const txt = i.textContent;
    if (prev && prev.nodeType === 3) { prev.appendData(txt); i.remove(); }
    else i.replaceWith(document.createTextNode(txt));
  }

  function softInto(tgt, str) {
    for (const ch of str) {
      if (ch === '\n' || ch === ' ' || ch === '\t') { appendRaw(tgt, ch); continue; }
      const i = document.createElement('i');
      i.className = 'ch';
      i.textContent = ch;
      i.addEventListener('animationend', onCharSettled, { once: true });
      tgt.appendChild(i);
    }
  }

  // A char is born at opacity 0 and only becomes visible by animating, so a
  // stalled compositor would strand it: invisible text, permanently, with no
  // animationend to flatten it. Hiding the window is the way to stall one. Don't
  // gamble that it resumes cleanly — settle everything in flight on the way out.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    for (const i of transcript.querySelectorAll('i.ch')) {
      i.removeEventListener('animationend', onCharSettled);
      onCharSettled({ currentTarget: i });
    }
  });

  // Put a run of text into a node — one <i> per character if we're inside a
  // per-char span, otherwise a single text node.
  function appendInto(tgt, str) {
    const fx = perCharFx();
    if (!fx) {
      if (softReveal && !reduceMotion) softInto(tgt, str);
      else appendRaw(tgt, str);
      return;
    }
    for (const ch of str) {
      const i = document.createElement('i');
      i.textContent = ch;
      if (CSS_STAGGERED.has(fx)) {
        i.style.animationDelay = ((activeLine.waveN++ % 24) * 0.05).toFixed(2) + 's';
      } else if (fx === 'scramble') {
        scrambleIn(i, ch);
      } else if (fx === 'hexdump') {
        hexIn(i, ch);
      }
      tgt.appendChild(i);
    }
  }

  // An auto-highlight span stays open across feeds so a long `code` run is one
  // bordered box, not one per typewriter chunk.
  function openAuto(cls) {
    const s = document.createElement('span'); s.className = cls;
    target().appendChild(s);
    activeLine.autoNode = s; activeLine.autoCls = cls;
  }
  function closeAuto() {
    if (!activeLine) return;
    activeLine.autoNode = null; activeLine.autoCls = null;
  }
  function emitRuns(runs) {
    for (const r of runs) {
      if (r.cls !== activeLine.autoCls) { closeAuto(); if (r.cls) openAuto(r.cls); }
      appendInto(activeLine.autoNode || target(), r.text);
    }
  }
  function flushAuto() {
    if (!activeLine) return;
    emitRuns(activeLine.auto.flush());
    closeAuto();
  }

  // Tiny sparks off the model's own punctuation — free flourishes that cost the
  // model nothing to author. Throttled, because otherwise an excited reply
  // turns into a strobe.
  let lastMicro = 0;
  function microFx(str) {
    if (str.indexOf('!') === -1 && str.indexOf('?') === -1) return;
    const now = performance.now();
    if (now - lastMicro < 450) return;
    lastMicro = now;
    const p = caretPos(target());
    if (str.indexOf('?') !== -1) effects.fire('ripple', p.x, p.y, { scale: 0.55, palette: 'ice' });
    else effects.fire('spark', p.x, p.y, { scale: 0.5, palette: 'gold' });
  }

  function appendText(str) {
    microFx(str);
    // Inside an explicit {{fx:}} span the model's markup wins outright — the
    // auto layer would only fight it for colour.
    if (activeLine.stack.length > 1) { closeAuto(); appendInto(target(), str); return; }
    emitRuns(activeLine.auto.feed(str));
  }

  function applyEvents(events) {
    for (const ev of events) {
      if (ev.t === 'text') appendText(ev.value);
      else if (ev.t === 'effect') { const p = caretPos(target()); effects.fire(ev.name, p.x, p.y, parseArgs(ev.args)); }
      else if (ev.t === 'style-start') openStyle(ev.name, ev.args);
      else if (ev.t === 'style-end') closeStyle(ev.name);
    }
  }

  // A tool call interrupts the text: close the current assistant segment,
  // drop a dim tool line, and continue text in a fresh segment.
  function handleTool(item) {
    const line = activeLine;
    if (item.phase === 'start') {
      applyEvents(line.parser.flush());              // close any dangling directive
      flushAuto();                                   // land any buffered auto text
      while (line.stack.length > 1) line.stack.pop(); // close open style spans
      if (line.caret && line.caret.parentNode) line.caret.remove();
      const hadText = line.body.textContent.trim().length > 0;

      const toolBody = addLine('tool');
      toolBody.textContent = '⚙ ' + item.name;
      line.tools.set(item.name, toolBody);
      const p = caretPos(toolBody);
      const [fx, pal] = TOOL_FX[item.name] || DEFAULT_TOOL_FX;
      effects.fire(fx, p.x, p.y, { scale: 0.55, palette: pal });

      const seg = newAssistantBody(false);           // continue text below the tool line
      line.body = seg.body; line.caret = seg.caret; line.stack = [seg.body];
      line.auto = new AutoStyler(); closeAuto();     // formatting doesn't cross a tool line
      if (!hadText) { /* first segment was empty; that's fine */ }
    } else { // end
      const t = line.tools.get(item.name);
      if (t) {
        t.textContent = '✓ ' + item.name; t.classList.add('done');
        line.tools.delete(item.name);
        // A tool finishing used to paint nothing at all. A small green puff off
        // the line is the cheapest possible "that worked".
        const p = caretPos(t);
        effects.emit(p.x, p.y, {
          n: 10, colors: ['#35f0a0', '#7effc4', '#ffffff'],
          angle: -Math.PI / 2, spread: 1.1,
          speedMin: 0.4, speedMax: 2.1, sizeMin: 0.8, sizeMax: 1.8,
          lifeMin: 260, lifeMax: 620, grav: 0.02, jitter: 2, halo: 8,
        });
      }
    }
  }

  function finalizeAssistant() {
    if (!activeLine) return;
    flushAuto();
    if (activeLine.caret && activeLine.caret.parentNode) activeLine.caret.remove();
    if (!activeLine.body.textContent.trim() && activeLine.body.parentNode) activeLine.body.parentNode.remove();
    activeLine = null; setBusy(false); scrollToEnd();
    idle.kick();
    drainPending();   // anything typed while that reply ran goes now, in order
  }

  // ---------- typewriter over the unified queue ----------
  let typing = false;
  function ensureTyping() {
    if (typing || !activeLine) return;
    typing = true;
    const step = () => {
      if (!activeLine) { typing = false; return; }
      const line = activeLine;
      if (line.caret && line.caret.parentNode) line.caret.remove();

      // Pull every pending text chunk into the reveal buffer up front, stopping
      // at a tool event (which has to stay ordered with the text around it).
      // Draining only one chunk per frame — and only once reveal ran dry — used
      // to pin reveal.length at ~6, so the adaptive rate below was always 1
      // char/frame (~50 chars/s) no matter how fast the model streamed.
      while (line.queue.length && line.queue[0].k === 't') line.reveal += line.queue.shift().s;

      if (line.reveal.length) {
        // Leisurely when caught up, faster the further behind we are.
        const n = Math.min(14, 1 + Math.floor(line.reveal.length / 90));
        // Only ease characters in while they're arriving slowly enough to see
        // one land. This rate already tracks exactly that, so reuse it.
        softReveal = n <= SOFT_MAX_N;
        const chunk = line.reveal.slice(0, n); line.reveal = line.reveal.slice(n);
        applyEvents(line.parser.feed(chunk));
      } else if (line.queue.length) {
        handleTool(line.queue.shift()); // only tool events can be left here
      } else if (line.streamDone) {
        applyEvents(line.parser.flush()); finalizeAssistant(); typing = false; return;
      } else { typing = false; return; } // idle until more arrives

      if (line.caret) line.body.appendChild(line.caret);
      scrollToEnd();
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ---------- ambient ----------
  // Sitting idle, the screen is dead still. After a long enough pause, paint
  // something slow and quiet — never a burst, never while the model is talking,
  // and never while the window is hidden (a background window throttles rAF, so
  // the particles would just pile up unrendered and all play at once on return).
  const idle = (function () {
    const AMBIENT = [
      ['aurora', 'mint'], ['aurora', 'violet'], ['aurora', 'ice'],
      ['swarm', 'gold'], ['constellation', 'ice'], ['rain', 'ice'],
    ];
    let timer = null;
    const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(go, ms); };
    function go() {
      if (activeLine || document.hidden) { schedule(30000); return; }
      const [fx, pal] = AMBIENT[(Math.random() * AMBIENT.length) | 0];
      effects.fire(fx, window.innerWidth / 2, window.innerHeight * 0.4, { scale: 0.8, palette: pal });
      schedule(50000 + Math.random() * 40000);
    }
    return { kick: () => schedule(45000 + Math.random() * 30000) };
  })();

  // ---------- send / receive ----------
  //
  // THE INPUT IS NEVER DISABLED. It used to be locked for the whole reply, and
  // with real Claude Code running tools that's minutes of a dead box — you
  // couldn't queue a follow-up or take back a bad prompt, which is exactly what
  // the CLI lets you do. Worse, every way the stream could break (an exception
  // in the rAF loop, a done event that never came) left it locked forever with
  // no way out. Never disabling it means there is no state in which the app can
  // strand you.
  let busy = false;
  const pending = [];   // typed while a reply was streaming; sent in order after

  function setBusy(b) {
    busy = b;
    sendBtn.textContent = b ? 'stop' : 'send';
    sendBtn.classList.toggle('stop', b);
    sendBtn.title = b ? 'Interrupt (Esc)' : 'Send (Enter)';
    if (!b) input.focus();
  }

  function dispatch(t, queuedNode) {
    if (queuedNode) queuedNode.classList.remove('queued');
    else plainLine('user', t);
    const reqId = 'r' + (++reqCounter);
    setBusy(true);
    startAssistant(reqId);
    api.send({ requestId: reqId, text: t });
    idle.kick();
  }

  function sendMessage(text) {
    const t = text.trim();
    if (!t) return;
    // Mid-reply: queue it rather than swallow it. Showing the line immediately
    // (dimmed) is the point — a keystroke that vanishes reads as a broken box,
    // which is how this whole mess started.
    if (activeLine) {
      // plainLine hands back the .body; the marker styles the whole .line.
      const node = plainLine('user', t).closest('.line');
      node.classList.add('queued');
      pending.push({ t, node });
      return;
    }
    dispatch(t, null);
  }

  function drainPending() {
    if (activeLine || !pending.length) return;
    const next = pending.shift();
    dispatch(next.t, next.node);
  }

  // Esc = interrupt, like the CLI. Stops the run where it is, keeps what
  // arrived, and hands the prompt straight back without waiting for the server
  // to acknowledge — a stop that needs a round-trip doesn't feel like a stop.
  function interrupt() {
    if (!activeLine) return false;
    try { api.abort(activeLine.id); } catch (e) { console.error('abort failed', e); }
    applyEvents(activeLine.parser.flush());
    flushAuto();
    if (activeLine.caret && activeLine.caret.parentNode) activeLine.caret.remove();
    if (!activeLine.body.textContent.trim() && activeLine.body.parentNode) activeLine.body.parentNode.remove();
    activeLine = null;
    setBusy(false);
    plainLine('system', '⎋ interrupted');
    effects.fire('glitch', undefined, undefined, { scale: 0.4 });
    idle.kick();
    drainPending();
    return true;
  }

  function clearPending() {
    if (!pending.length) return false;
    for (const p of pending) if (p.node && p.node.parentNode) p.node.parentNode.remove();
    pending.length = 0;
    plainLine('system', '⎋ queued prompts cleared');
    return true;
  }

  input.addEventListener('input', () => idle.kick());

  // Esc anywhere: stop the run, or clear the queue if nothing is running.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (interrupt() || clearPending()) e.preventDefault();
  });

  // While busy the button is a stop button. Handled on click (not submit) so it
  // can cancel the form submission that a <button type="submit"> would fire.
  sendBtn.addEventListener('click', (e) => {
    if (busy) { e.preventDefault(); interrupt(); }
  });

  inputRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    // Spend the typing heat while the caret is still where you left it.
    if (v.trim()) inputFX.launch();
    input.value = '';
    sendMessage(v);
  });

  api.onDelta((d) => { if (activeLine && d.requestId === activeLine.id) { activeLine.queue.push({ k: 't', s: d.text }); ensureTyping(); } });
  api.onTool((d) => { if (activeLine && d.requestId === activeLine.id) { activeLine.queue.push({ k: 'x', phase: d.phase, name: d.name }); ensureTyping(); } });
  api.onDone((d) => {
    if (activeLine && d.requestId === activeLine.id) {
      activeLine.streamDone = true;
      if (typeof d.cost === 'number' && d.cost > 0) activeLine._cost = d.cost;
      ensureTyping();
    }
  });
  api.onError((d) => {
    if (activeLine && d.requestId === activeLine.id) {
      applyEvents(activeLine.parser.flush());
      flushAuto();
      if (activeLine.caret && activeLine.caret.parentNode) activeLine.caret.remove();
      if (!activeLine.body.textContent.trim() && activeLine.body.parentNode) activeLine.body.parentNode.remove();
      activeLine = null; setBusy(false);
    }
    plainLine('error', '⚠ ' + (d.message || 'Something went wrong.'));
    // A failure earns more than a shake: tear the channels too.
    effects.fire('glitch');
    effects.fire('shake');
    idle.kick();
    drainPending();
  });

  api.onAuto((d) => { plainLine('user', d.userText || ''); setBusy(true); startAssistant(d.requestId); });

  // ---------- status ----------
  function setStatus(state, detail) {
    const dot = el('status-dot'), text = el('status-text');
    const target = cfg.username && cfg.host ? `${cfg.username}@${cfg.host}` : 'not configured';
    if (cfg.demoMode) { dot.className = 'dot demo'; text.textContent = 'demo mode'; return; }
    // Web mode has no connection to report — the server IS the VM. It's ready or
    // the page wouldn't have loaded, so say that instead of "not configured".
    if (isWeb) { dot.className = 'dot live'; text.textContent = 'claude on this VM'; return; }
    if (state === 'connecting') { dot.className = 'dot demo'; text.textContent = 'connecting… ' + (detail || target); }
    else if (state === 'connected') { dot.className = 'dot live'; text.textContent = detail || target; }
    else if (state === 'error') { dot.className = 'dot err'; text.textContent = 'error: ' + String(detail || '').slice(0, 60); }
    else if (state === 'closed') { dot.className = 'dot'; text.textContent = 'disconnected · ' + target; }
    else { dot.className = 'dot'; text.textContent = target; } // idle
  }
  // The connection itself is worth painting — it's the one thing on screen the
  // model can't narrate, because when it matters the model isn't reachable.
  let lastState = null;
  api.onStatus((s) => {
    setStatus(s.state, s.target || s.message);
    if (s.state === lastState) return;
    const dot = el('status-dot');
    const r = dot ? dot.getBoundingClientRect() : null;
    const x = r ? r.left + r.width / 2 : undefined;
    const y = r ? r.top + r.height / 2 : undefined;
    if (s.state === 'connected') effects.fire('ripple', x, y, { palette: 'mint' });
    else if (s.state === 'error') effects.fire('glitch');
    else if (s.state === 'closed' && lastState === 'connected') effects.fire('frost', x, y, { scale: 0.7, palette: 'ice' });
    lastState = s.state;
  });

  // ---------- settings ----------
  const overlay = el('settings-overlay');
  function syncAuthBlocks() {
    const m = el('cfg-auth').value;
    el('auth-key').classList.toggle('hidden', m !== 'key');
    el('auth-password').classList.toggle('hidden', m !== 'password');
  }
  function openSettings() {
    el('cfg-host').value = cfg.host || '';
    el('cfg-port').value = cfg.port || 22;
    el('cfg-user').value = cfg.username || '';
    el('cfg-auth').value = cfg.authMethod || 'key';
    el('cfg-keypath').value = cfg.privateKeyPath || '';
    el('cfg-passphrase').value = cfg.passphrase || '';
    el('cfg-password').value = cfg.password || '';
    el('cfg-cwd').value = cfg.cwd || '';
    el('cfg-model').value = cfg.model || '';
    el('cfg-bypass').checked = cfg.bypass !== false;
    el('cfg-demo').checked = !!cfg.demoMode;
    el('cfg-devurl').value = cfg.devUrl || '';
    el('test-result').textContent = '';
    syncAuthBlocks();
    overlay.classList.remove('hidden');
  }
  function closeSettings() { overlay.classList.add('hidden'); }
  function formValues() {
    return {
      host: el('cfg-host').value.trim(),
      port: parseInt(el('cfg-port').value, 10) || 22,
      username: el('cfg-user').value.trim(),
      authMethod: el('cfg-auth').value,
      privateKeyPath: el('cfg-keypath').value.trim(),
      passphrase: el('cfg-passphrase').value,
      password: el('cfg-password').value,
      cwd: el('cfg-cwd').value.trim(),
      model: el('cfg-model').value.trim(),
      bypass: el('cfg-bypass').checked,
      demoMode: el('cfg-demo').checked,
      devUrl: el('cfg-devurl').value.trim(),
    };
  }

  el('settings-btn').addEventListener('click', openSettings);
  el('cfg-auth').addEventListener('change', syncAuthBlocks);
  el('settings-cancel').addEventListener('click', closeSettings);
  el('settings-test').addEventListener('click', async () => {
    const r = el('test-result'); r.textContent = 'Testing…'; r.className = 'test-result';
    const res = await api.sshTest(formValues());
    r.textContent = (res.ok ? '✓ ' : '✗ ') + res.message;
    r.className = 'test-result ' + (res.ok ? 'ok' : 'bad');
  });
  el('settings-save').addEventListener('click', async () => {
    const before = cfg.devUrl || '';
    cfg = await api.saveConfig(formValues());
    setStatus('idle'); closeSettings();
    // Which document is loaded is decided at window-create time, so this one
    // setting can't apply itself. Saying so beats Jim changing it, seeing no
    // difference, and concluding the feature is broken.
    if ((cfg.devUrl || '') !== before) {
      plainLine('system', cfg.devUrl
        ? '✦ Live UI set to ' + cfg.devUrl + ' — restart Flourish to load it. After that, Ctrl-R picks up changes.'
        : '✦ Live UI turned off — restart Flourish to go back to the UI packaged in this build.');
    }
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });

  // ---------- build stamp ----------
  // Two builds shipped broken and nobody could say which code was in them; a
  // session once "verified" 40 effects against a .exe whose prompt.js predated
  // the other 10. So name the code on screen. When the UI is served live off
  // the VM these are genuinely two different commits — ui is what you're
  // looking at, app is the shell that owns the SSH bridge — and showing only
  // one would recreate the exact confusion this is here to end.
  let isWeb = false;   // served by server.js in a browser, rather than the .exe

  async function showBuild() {
    const ui = window.FLOURISH_BUILD || { sha: 'unstamped', dirty: true };
    let app = null;
    try { app = await api.getBuild(); } catch { /* older shell, no build:get */ }
    isWeb = !!(app && app.web);
    const tag = (b) => b ? b.sha + (b.dirty ? '+' : '') : '?';
    const node = el('build-stamp');
    if (!node) return;
    const live = app && app.live;
    // In web mode the UI and the server are the same working tree by
    // construction, so two SHAs would be noise pretending to be information.
    node.textContent = isWeb ? `${tag(ui)} · web` : (live ? `ui ${tag(ui)} · app ${tag(app)} · live` : tag(ui));
    node.classList.toggle('live', !!live);
    node.title = isWeb
      ? `${tag(ui)}${ui.branch ? ' (' + ui.branch + ')' : ''} — web mode: UI and server are the same working tree, so they can't drift.\n` +
        '+ means uncommitted changes were in the tree when it was stamped.'
      : [
        `UI:  ${tag(ui)}${ui.branch ? ' (' + ui.branch + ')' : ''}${live ? ' — served live from the VM' : ' — packaged in this build'}`,
        app ? `App: ${tag(app)}${app.branch ? ' (' + app.branch + ')' : ''} — the packaged shell (SSH bridge, system prompt)` : '',
        '+ means uncommitted changes were in the tree when it was stamped.',
      ].filter(Boolean).join('\n');

    // There is no SSH in web mode: claude runs on the box serving this page.
    // Leaving a "Private key path" box on screen would invite Jim to paste a
    // key somewhere nothing reads it.
    if (isWeb) {
      const hide = (id) => { const n = el(id); if (n) n.classList.add('hidden'); };
      hide('ssh-only');
      hide('cfg-devurl-field');
      const t = el('settings-title'), l = document.querySelector('.settings-lede');
      if (t) t.textContent = 'Claude Code on this VM';
      if (l) l.innerHTML = 'This page is served by the VM, and <code>claude</code> runs there directly — ' +
        'no SSH, no key, nothing installed on Windows. Rendering still happens here, on your GPU. ' +
        'Claude Code uses whatever auth it already has on the VM.';
      const tb = el('settings-test'); if (tb) tb.textContent = 'Check server';
    }
  }

  // ---------- boot ----------
  (async function boot() {
    // Boot awaits the network, but it must never gate the input: type during
    // boot and the message queues like any other. Nothing here touches busy.
    try {
      cfg = await api.getConfig();
      await showBuild();        // sets isWeb, which the lines below read
    } catch (e) {
      console.error('boot failed', e);
      plainLine('error', '⚠ Could not reach the server: ' + ((e && e.message) || e));
      cfg = cfg || {};
    }
    setStatus('idle');
    const configured = cfg.demoMode || isWeb || (cfg.host && cfg.username);
    plainLine('system', '✦ Flourish ready. ' + (configured
      ? (cfg.demoMode ? 'Demo mode is on — say hello and watch the effects.'
        : isWeb ? 'Type a message to run it through Claude Code on this VM.'
          : 'Type a message to run it through Claude Code on ' + cfg.host + '.')
      : 'Open settings (⚙) to point it at Claude Code on your VM, or turn on Demo mode.'));
    input.focus();
    idle.kick();
  })();
})();
