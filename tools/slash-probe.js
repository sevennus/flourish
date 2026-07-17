/*
 * slash-probe.js — do /model and /effort actually work, on the path Jim takes?
 *
 * npm test covers pure modules and cannot see a menu. smoke:web streams a demo
 * reply and never types a slash. Both were green while this feature did not
 * exist at all — which is the whole reason this file exists rather than a
 * screenshot: a picker is a claim about the DOM and about what gets SAVED, and
 * both can be checked instead of admired.
 *
 * The load-bearing assertion is the last one. A picker that opens beautifully
 * and writes nothing to the config is exactly the shape of bug this repo keeps
 * shipping (see writeups/: apophenia's fallback, salvage's identical-looking
 * fallback). So: drive the real renderer over the real preload, and capture
 * every config:save the renderer actually makes.
 *
 *   xvfb-run -a ./node_modules/.bin/electron tools/slash-probe.js --no-sandbox
 */
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

const ROOT = path.join(__dirname, '..');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('enable-unsafe-swiftshader');

// The renderer's config, mutated by saves the way the real server would.
let CFG = { demoMode: true, cwd: '', bypass: true, model: '', effort: '' };
const saves = [];        // every config:save payload the renderer sent
const sent = [];         // every chat:send — a slash command must send NONE

ipcMain.handle('config:get', () => CFG);
ipcMain.handle('config:save', (_e, c) => { saves.push(c); CFG = c; return c; });
ipcMain.handle('session:reset', () => true);
ipcMain.handle('ssh:test', () => ({ ok: true, message: 'probe' }));
ipcMain.handle('build:get', () => ({ sha: 'probe', branch: 'probe', dirty: false, live: false }));
ipcMain.on('chat:send', (_e, p) => sent.push(p));
ipcMain.on('chat:abort', () => {});

const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); console.log(`${ok ? 'ok  ' : 'FAIL'} - ${msg}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const win = new BrowserWindow({
    // show: true is mandatory — a hidden window throttles rAF and the
    // typewriter never runs (see smoke.js's header).
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
  await wait(400);

  const js = (s) => win.webContents.executeJavaScript(s);
  const submit = (text) => js(`
    document.getElementById('input').value = ${JSON.stringify(text)};
    document.getElementById('input-row').dispatchEvent(
      new Event('submit', { cancelable: true, bubbles: true }));
    true;`);
  // Real KeyboardEvents on the real input — the menu's nav is bound there in
  // the capture phase, so a synthetic .dispatchEvent on document would miss it.
  const key = (k) => js(`
    document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }));
    true;`);
  const menu = () => js(`(() => {
    const m = document.getElementById('slash-menu');
    return {
      open: !m.classList.contains('hidden'),
      opts: [...m.querySelectorAll('.slash-opt .slash-name')].map(n => n.textContent),
      on: (m.querySelector('.slash-opt.on .slash-name') || {}).textContent || null,
      current: (m.querySelector('.slash-opt.current .slash-name') || {}).textContent || null,
    };
  })()`);
  const lastSystemLine = () => js(
    `(([...ls]) => ls.length ? ls[ls.length-1].textContent : null)` +
    `(document.querySelectorAll('#transcript .line.system .body'))`);

  console.log('=== /model opens a picker ===');
  await submit('/model');
  await wait(120);
  let m = await menu();
  check(m.open, 'the menu opens');
  check(JSON.stringify(m.opts) === JSON.stringify(['default', 'opus', 'sonnet', 'haiku', 'fable']),
    `offers the CLI's aliases — got ${JSON.stringify(m.opts)}`);
  check(m.on === 'default', `highlights the live value first — got ${m.on}`);
  check(sent.length === 0, 'a slash command is NOT sent to Claude Code as a prompt');

  console.log('\n=== arrow + Enter picks, and SAVES ===');
  await key('ArrowDown');
  await wait(60);
  m = await menu();
  check(m.on === 'opus', `ArrowDown moves the highlight — got ${m.on}`);
  await key('Enter');
  await wait(200);
  check(saves.length === 1, `Enter writes exactly one config save — got ${saves.length}`);
  check(saves[0] && saves[0].model === 'opus', `…and it saved model=opus — got ${JSON.stringify(saves[0] && saves[0].model)}`);
  check(saves[0] && saves[0].bypass === true, 'the save carries the rest of the config (bypass survived)');
  check((await menu()).open === false, 'the menu closes after picking');
  check(/model → opus/.test(await lastSystemLine() || ''), 'the transcript says what changed');
  check(sent.length === 0, 'still nothing sent to Claude Code');

  console.log('\n=== /effort <arg> skips the picker ===');
  await submit('/effort xhigh');
  await wait(200);
  check((await menu()).open === false, 'an explicit argument does not open the menu');
  check(saves.length === 2 && saves[1].effort === 'xhigh', `saved effort=xhigh — got ${JSON.stringify(saves[1] && saves[1].effort)}`);
  check(saves[1] && saves[1].model === 'opus', 'the earlier /model choice survived the /effort save');

  console.log('\n=== a bad effort is refused HERE, not by the CLI minutes later ===');
  await submit('/effort ludicrous');
  await wait(150);
  check(saves.length === 2, `a junk value writes no config — got ${saves.length} saves`);
  check(/must be one of/.test(await lastSystemLine() || ''), 'and says what the legal values are');

  console.log('\n=== the current value is marked ===');
  await submit('/effort');
  await wait(120);
  m = await menu();
  check(m.current === 'xhigh', `the live value is marked current — got ${m.current}`);
  check(m.on === 'xhigh', `and is where the highlight starts — got ${m.on}`);

  // Every assertion above is a count or a string, and counts cannot see
  // composition — a menu can satisfy all of them while being unreadable or
  // painted off-screen. The ASCII scenes shipped a blanked glyph past eight
  // green invariants for exactly this reason. So: a picture, of the real menu.
  const shot = path.join(ROOT, 'assets', 'fx', 'probe', 'slash-menu.png');
  require('fs').mkdirSync(path.dirname(shot), { recursive: true });
  require('fs').writeFileSync(shot, (await win.webContents.capturePage()).toPNG());
  console.log(`     wrote ${path.relative(ROOT, shot)}`);

  console.log('\n=== Esc dismisses without interrupting ===');
  await key('Escape');
  await wait(120);
  check((await menu()).open === false, 'Esc closes the menu');
  check(saves.length === 2, 'Esc changes nothing');

  console.log('\n=== an unknown slash is a prompt, not an error ===');
  await submit('/deploy the thing');
  await wait(150);
  check(sent.length === 1 && sent[0].text === '/deploy the thing',
    `/deploy is forwarded to Claude Code verbatim — got ${JSON.stringify(sent.map(s => s.text))}`);

  check(errs.length === 0, `renderer logged no errors${errs.length ? ': ' + errs[0] : ''}`);

  console.log(failures.length ? `\nFAILED — ${failures.length}` : '\nPASSED — slash');
  win.destroy();
  app.exit(failures.length ? 1 : 0);
}

app.whenReady().then(main).catch((e) => { console.error(e); app.exit(1); });
