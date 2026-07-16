'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { shq, normalizeTarget, connectConfig, buildInner, buildCommand } = require('../src/bridge');

test('a PuTTY .ppk key is rejected with an actionable message', () => {
  const p = path.join(os.tmpdir(), 'flourish-test-' + process.pid + '.ppk');
  fs.writeFileSync(p, 'PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n...');
  try {
    assert.throws(
      () => connectConfig({ authMethod: 'key', privateKeyPath: p }),
      /PuTTY .ppk key.*Export OpenSSH key/s);
  } finally { fs.unlinkSync(p); }
});

test('an OpenSSH-looking key is passed through as privateKey', () => {
  const p = path.join(os.tmpdir(), 'flourish-test-osk-' + process.pid);
  fs.writeFileSync(p, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
  try {
    const c = connectConfig({ authMethod: 'key', privateKeyPath: p });
    assert.ok(Buffer.isBuffer(c.privateKey));
  } finally { fs.unlinkSync(p); }
});

test('normalizeTarget splits a pasted user@host out of the Host field', () => {
  assert.deepStrictEqual(
    normalizeTarget({ host: 'aiops@192.168.86.208', username: '', port: 22 }),
    { host: '192.168.86.208', username: 'aiops', port: 22 });
});
test('normalizeTarget leaves a clean host/username alone', () => {
  assert.deepStrictEqual(
    normalizeTarget({ host: '192.168.86.208', username: 'aiops', port: 22 }),
    { host: '192.168.86.208', username: 'aiops', port: 22 });
});
test('an explicit Username wins over a user@ in the host', () => {
  assert.strictEqual(normalizeTarget({ host: 'root@h', username: 'aiops' }).username, 'aiops');
});
test('normalizeTarget pulls a :port and strips ssh:// and paths', () => {
  assert.deepStrictEqual(
    normalizeTarget({ host: 'ssh://user@host:2222/whatever' }),
    { host: 'host', username: 'user', port: 2222 });
});
test('normalizeTarget handles [ipv6]:port and bare host:port', () => {
  assert.deepStrictEqual(normalizeTarget({ host: '[::1]:2222', username: 'u' }), { host: '::1', username: 'u', port: 2222 });
  assert.deepStrictEqual(normalizeTarget({ host: 'host:2200', username: 'u' }), { host: 'host', username: 'u', port: 2200 });
});

const base = { claudePath: 'claude', bypass: true };

test('shq safely single-quotes, neutralizing embedded quotes', () => {
  assert.strictEqual(shq('hi'), "'hi'");
  assert.strictEqual(shq("it's"), "'it'\\''s'");
});

test('inner command has the required headless streaming flags', () => {
  const c = buildInner('hello', base, null);
  assert.match(c, /(^|\s)'claude' -p 'hello'/);
  assert.match(c, /--output-format stream-json/);
  assert.match(c, /--verbose/);
  assert.match(c, /--include-partial-messages/);
  assert.match(c, /--append-system-prompt '/);
  assert.match(c, /< \/dev\/null$/);
});

test('bypass on adds bypassPermissions; off omits it', () => {
  assert.match(buildInner('x', { ...base, bypass: true }, null), /--permission-mode bypassPermissions/);
  assert.doesNotMatch(buildInner('x', { ...base, bypass: false }, null), /bypassPermissions/);
});

test('cwd, model, and resume are threaded through when present', () => {
  const c = buildInner('x', { ...base, cwd: '/var/www/simjim', model: 'claude-opus-4-8' }, 'sess-123');
  assert.match(c, /^cd '\/var\/www\/simjim' &&/);
  assert.match(c, /--model 'claude-opus-4-8'/);
  assert.match(c, /--resume 'sess-123'/);
});

test('a prompt with a quote cannot break out of the command', () => {
  const c = buildInner("run 'rm -rf'; echo pwned", base, null);
  // the dangerous quote is escaped inside a single-quoted arg, not a real break
  assert.match(c, /-p 'run '\\''rm -rf'\\''; echo pwned'/);
});

test('buildCommand wraps the inner command in a login shell', () => {
  const cmd = buildCommand('hello', base, null);
  assert.ok(cmd.startsWith("bash -lc '"));
  assert.match(cmd, /claude/);
});

// ---------------------------------------------------------------------------
// The two transports, kept honest.
//
// The web app spawns claude with an argv array (buildArgs); the legacy SSH path
// builds a shell string (buildInner). They cannot be one function — quoting for
// a shell would embed literal quotes into spawn's arguments — so they are two
// implementations of one invocation, which is a standing invitation to drift.
// The README claimed for a while that they were shared; they never were. A flag
// added to only one is a flag the other silently never passes, and nothing else
// in this repo would notice.
test('both transports pass the same claude flags (they drift the moment you touch one)', () => {
  const { buildArgs } = require('../src/bridge');

  // Strip single-quoted values first: the system prompt is megabytes of prose
  // and would otherwise contribute whatever "--foo" it happens to mention.
  const flagsInShell = (s) =>
    [...s.replace(/'(?:[^']|'\\'')*'/g, "''").matchAll(/(?:^|\s)(--[a-z-]+)/g)]
      .map((m) => m[1]).sort();
  const flagsInArgv = (a) => a.filter((x) => /^--[a-z-]+$/.test(x)).sort();

  for (const cfg of [
    { ...base },
    { ...base, bypass: false },
    { ...base, model: 'claude-opus-4-8' },
    { ...base, cwd: '/var/www/simjim', model: 'claude-opus-4-8' },
  ]) {
    for (const sess of [null, 'sess-abc']) {
      assert.deepStrictEqual(
        flagsInArgv(buildArgs('hello', cfg, sess)),
        flagsInShell(buildInner('hello', cfg, sess)),
        `buildArgs and buildInner disagree for cfg=${JSON.stringify(cfg)} session=${sess}`
      );
    }
  }
});

test('both transports teach the model the same vocabulary', () => {
  const { buildArgs } = require('../src/bridge');
  const { FLOURISH_SYSTEM_PROMPT } = require('../src/prompt');
  const args = buildArgs('hi', base, null);
  const i = args.indexOf('--append-system-prompt');
  assert.ok(i !== -1, 'the web path must append the flourish prompt, or the model fires nothing');
  assert.strictEqual(args[i + 1], FLOURISH_SYSTEM_PROMPT, 'unquoted: spawn takes the raw string');
  assert.ok(buildInner('hi', base, null).includes(shq(FLOURISH_SYSTEM_PROMPT)),
    'the SSH path must append the same prompt, quoted for the shell');
});
