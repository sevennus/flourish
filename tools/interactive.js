/*
 * interactive.js — can you actually USE the box while the model is talking?
 *
 * WHY THIS EXISTS, IN JIM'S WORDS: "I STILL CANNOT TYPE IN THE BOX BETWEEN
 * PROMPTS FOR FUCKS SAKE" — reported three times, and twice I told him it was
 * fixed. It wasn't, because smoke.js asserts "input is re-enabled AFTER the
 * reply" and that passed the whole time. The complaint was never about after.
 * The input was disabled for the WHOLE reply (setBusy(true) on send), which
 * with real Claude Code running tools is minutes of a dead box. My test had
 * encoded the bug as the requirement and gone green on it.
 *
 * So this tests the interaction, not the render:
 *   1. the box is usable WHILE a reply streams  (the actual complaint)
 *   2. Enter mid-reply queues rather than swallows
 *   3. a queued prompt is sent when the reply finishes
 *   4. Esc interrupts, like the CLI
 *   5. two prompts back to back both work
 *
 * Every one of these fails on the old code. Run: npm run test:interactive
 *
 * NOT named *.test.js: `node --test` would discover it and run it as a plain node
 * test, where `require('electron')` fails and the suite goes red for no reason.
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const ROOT = path.join(__dirname, '..');

app.disableHardwareAcceleration();

// A hand-driven stream, so the test controls exactly when a reply is "still
// talking" — the window the whole bug lives in.
let sender = null;
const sent = [];         // every chat:send the renderer made
let aborted = [];

ipcMain.handle('config:get', () => ({ demoMode: true, cwd: '', bypass: true }));
ipcMain.handle('config:save', (_e, c) => c);
ipcMain.handle('session:reset', () => true);
ipcMain.handle('ssh:test', () => ({ ok: true, message: 'test' }));
ipcMain.handle('build:get', () => ({ sha: 'test', branch: 'test', dirty: false }));
ipcMain.on('chat:send', (e, p) => { sender = e.sender; sent.push(p); });
ipcMain.on('chat:abort', (_e, p) => aborted.push(p && p.requestId));

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} - ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    width: 1120, height: 720, show: true, backgroundColor: '#05070a',
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });
  const errs = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2 && !/Electron Security Warning/.test(message)) errs.push(message);
  });

  win.loadFile(path.join(ROOT, 'src', 'index.html'));
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await wait(400);   // let boot settle

  const js = (s) => win.webContents.executeJavaScript(s);
  const type = (text) => js(`
    document.getElementById('input').value = ${JSON.stringify(text)};
    document.getElementById('input-row').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    true;`);
  const state = () => js(`(() => {
    const i = document.getElementById('input');
    const b = document.getElementById('send-btn');
    return {
      disabled: i.disabled, btnDisabled: b.disabled, btn: b.textContent.trim(),
      queued: document.querySelectorAll('.line.user.queued').length,
      users: [...document.querySelectorAll('.line.user .body')].map(n => n.textContent.trim()),
      text: document.getElementById('transcript').innerText,
    };
  })()`);
  const key = (k) => js(`
    document.dispatchEvent(new KeyboardEvent('keydown',
      { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
    true;`);

  // ---- 1. the box while a reply is streaming -------------------------------
  await type('first prompt');
  await wait(200);
  const id1 = sent[0] && sent[0].requestId;
  sender.send('chat:delta', { requestId: id1, text: 'I am thinking about this' });
  await wait(400);

  let s = await state();
  check(s.disabled === false, 'THE BUG: the input is usable while the model is still talking');
  check(s.btnDisabled === false, 'the button is live while the model is talking');
  check(s.btn === 'stop', 'the send button becomes a stop button while talking');

  // ---- 2. typing mid-reply queues, doesn't vanish --------------------------
  await type('second prompt while busy');
  await wait(300);
  s = await state();
  check(s.users.some((u) => u.includes('second prompt while busy')),
    'a prompt typed mid-reply appears immediately instead of vanishing');
  check(s.queued === 1, 'it is shown as queued, not sent');
  check(sent.length === 1, 'it is NOT dispatched while the first reply is running');

  // ---- 3. the queued prompt goes when the reply finishes -------------------
  sender.send('chat:done', { requestId: id1 });
  await wait(1500);
  s = await state();
  check(sent.length === 2, 'the queued prompt is sent once the reply finishes');
  check(sent[1] && sent[1].text === 'second prompt while busy', 'it sends the right text');
  check(s.queued === 0, 'it stops being marked queued once sent');
  check(s.disabled === false, 'input still usable');

  // ---- 4. Esc interrupts, like the CLI ------------------------------------
  const id2 = sent[1].requestId;
  sender.send('chat:delta', { requestId: id2, text: 'starting a long answer' });
  await wait(400);
  await key('Escape');
  await wait(400);
  s = await state();
  check(aborted.includes(id2), 'Esc aborts the running request');
  check(/interrupted/.test(s.text), 'the transcript says it was interrupted');
  check(s.btn === 'send', 'the button goes back to send after an interrupt');
  check(s.disabled === false, 'the prompt is usable straight after an interrupt');

  // ---- 5. and you can just carry on ---------------------------------------
  await type('third prompt after interrupt');
  await wait(400);
  check(sent.length === 3, 'a new prompt sends immediately after an interrupt');
  check(sent[2] && sent[2].text === 'third prompt after interrupt', 'with the right text');

  check(errs.length === 0, 'no renderer errors' + (errs.length ? '\n       ' + errs.slice(0, 3).join('\n       ') : ''));

  console.log(`\n${failures.length ? `FAILED (${failures.length})` : 'PASSED'} — interactive\n`);
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
