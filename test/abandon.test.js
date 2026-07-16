/*
 * abandon.test.js — if you walk away, does the work actually stop?
 *
 * Jim asked the question that found this: "so i can just refresh this page and
 * that agent dies mid thought or does it continue to consume tokens?" It
 * continued. Measured: a run abandoned after 6s was still burning CPU 54s later,
 * with nobody watching its output, and orphans were quietly stacking up.
 *
 * The cause was three layers deep: nginx only notices a dead client when it
 * tries to WRITE to it, and a thinking Claude Code emits nothing for minutes.
 * No write → no discovery → no upstream close → the server never hears. Fixed
 * with a 3s heartbeat (gives nginx something to fail to deliver), res 'close'
 * (not req 'close', which fires when the body is read), sendBeacon on pagehide,
 * and a process-GROUP kill so tool subprocesses go too.
 *
 * This uses a fake `claude` that just sleeps, so the regression test costs no
 * tokens and is deterministic. It asserts the thing that costs money: the
 * process is GONE after the client leaves.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for `claude` that never says anything and never exits — exactly the
// shape that defeated the old disconnect detection.
function makeFakeClaude(dir) {
  const p = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(p, '#!/bin/bash\nsleep 600\n', { mode: 0o755 });
  return p;
}

async function startServer(dir, claudePath, port) {
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ claudePath, cwd: dir, demoMode: false, bypass: true }));
  const srv = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, FLOURISH_PORT: String(port), FLOURISH_HOST: '127.0.0.1', FLOURISH_CONFIG: cfgPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', () => {});
  for (let i = 0; i < 60; i++) {                 // wait for the port
    try {
      await new Promise((res, rej) => {
        const r = http.get({ host: '127.0.0.1', port, path: '/api/config' }, (x) => { x.resume(); res(); });
        r.on('error', rej);
      });
      return srv;
    } catch { await wait(100); }
  }
  throw new Error('server never came up');
}

// Find the fake-claude the server spawned for us.
function findChild(serverPid) {
  try {
    const out = require('child_process')
      .execFileSync('pgrep', ['-P', String(serverPid)], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean).map(Number);
  } catch { return []; }
}

test('abandoning the page kills the claude run instead of leaving it burning tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flourish-abandon-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const fake = makeFakeClaude(dir);
  const srv = await startServer(dir, fake, port);

  try {
    // Start a run, then walk away mid-flight — the browser-refresh case.
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    req.write(JSON.stringify({ requestId: 'gone-1', text: 'hello' }));
    req.end();
    req.on('error', () => {});          // we're about to cause one
    await wait(1200);

    const kids = findChild(srv.pid);
    assert.strictEqual(kids.length, 1, 'the server should have spawned exactly one claude');
    const claudePid = kids[0];
    assert.ok(alive(claudePid), 'the fake claude should be running before we bail');

    req.destroy();                      // <-- the refresh

    // It must die on its own. Poll rather than sleep-and-hope, so the test
    // reports how long it actually took when it regresses.
    let gone = false;
    for (let i = 0; i < 60; i++) {
      if (!alive(claudePid)) { gone = true; break; }
      await wait(250);
    }
    assert.ok(gone, `claude (pid ${claudePid}) was STILL RUNNING 15s after the client left — ` +
      'an abandoned run burns tokens with nobody reading the output');
    assert.strictEqual(findChild(srv.pid).length, 0, 'no orphans left behind');
  } finally {
    try { process.kill(srv.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shutting the server down takes its runs with it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flourish-shutdown-'));
  const port = 18000 + Math.floor(Math.random() * 2000);
  const fake = makeFakeClaude(dir);
  const srv = await startServer(dir, fake, port);

  try {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    req.write(JSON.stringify({ requestId: 'shutdown-1', text: 'hello' }));
    req.end();
    req.on('error', () => {});
    await wait(1200);

    const kids = findChild(srv.pid);
    assert.strictEqual(kids.length, 1, 'one claude running');
    const claudePid = kids[0];

    process.kill(srv.pid, 'SIGTERM');   // e.g. systemctl restart flourish

    let gone = false;
    for (let i = 0; i < 40; i++) {
      if (!alive(claudePid)) { gone = true; break; }
      await wait(250);
    }
    assert.ok(gone, `claude (pid ${claudePid}) outlived the server — detached:true puts it in ` +
      'its own process group, so nothing reaps it unless the server does');
    req.destroy();
  } finally {
    try { process.kill(srv.pid, 'SIGKILL'); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
