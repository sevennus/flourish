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

  const { FlourishParser, PER_CHAR_SPANS, parseArgs } = window.Flourish;
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
  function plainLine(cls, text) { addLine(cls).textContent = text; scrollToEnd(); }
  function scrollToEnd() { screen.scrollTop = screen.scrollHeight; }

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
    target().appendChild(span); activeLine.stack.push(span);
  }
  function closeStyle(name) {
    while (activeLine.stack.length > 1) { const top = activeLine.stack.pop(); if (top.dataset && top.dataset.fx === name) break; }
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

  // Put a run of text into a node — one <i> per character if we're inside a
  // per-char span, otherwise a single text node.
  function appendInto(tgt, str) {
    const fx = perCharFx();
    if (!fx) { tgt.appendChild(document.createTextNode(str)); return; }
    for (const ch of str) {
      const i = document.createElement('i');
      i.textContent = ch;
      if (fx === 'wave' || fx === 'bounce' || fx === 'stamp' || fx === 'corrupt' || fx === 'sparkle') {
        i.style.animationDelay = ((activeLine.waveN++ % 24) * 0.05).toFixed(2) + 's';
      } else if (fx === 'scramble') {
        scrambleIn(i, ch);
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
  function setBusy(b) { input.disabled = b; sendBtn.disabled = b; if (!b) input.focus(); }

  function sendMessage(text) {
    const t = text.trim();
    if (!t || activeLine) return;
    plainLine('user', t);
    const reqId = 'r' + (++reqCounter);
    setBusy(true); startAssistant(reqId);
    api.send({ requestId: reqId, text: t });
    idle.kick();
  }

  input.addEventListener('input', () => idle.kick());

  inputRow.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    // Spend the typing heat while the caret is still where you left it.
    if (v.trim() && !activeLine) inputFX.launch();
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
  });

  api.onAuto((d) => { plainLine('user', d.userText || ''); setBusy(true); startAssistant(d.requestId); });

  // ---------- status ----------
  function setStatus(state, detail) {
    const dot = el('status-dot'), text = el('status-text');
    const target = cfg.username && cfg.host ? `${cfg.username}@${cfg.host}` : 'not configured';
    if (cfg.demoMode) { dot.className = 'dot demo'; text.textContent = 'demo mode'; return; }
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
    cfg = await api.saveConfig(formValues());
    setStatus('idle'); closeSettings();
  });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettings(); });

  // ---------- boot ----------
  (async function boot() {
    cfg = await api.getConfig();
    setStatus('idle');
    const configured = cfg.demoMode || (cfg.host && cfg.username);
    plainLine('system', '✦ Flourish ready. ' + (configured
      ? (cfg.demoMode ? 'Demo mode is on — say hello and watch the effects.'
        : 'Type a message to run it through Claude Code on ' + cfg.host + '.')
      : 'Open settings (⚙) to point it at Claude Code on your VM, or turn on Demo mode.'));
    input.focus();
    idle.kick();
  })();
})();
