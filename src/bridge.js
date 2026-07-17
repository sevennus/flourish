/*
 * bridge.js — the pure parts of the SSH→Claude Code bridge: how a config maps
 * to an ssh2 connection, and how a user message becomes the remote command.
 *
 * No Electron here, so main.js and the real end-to-end verify script share the
 * exact same command construction (and it's unit-testable).
 */
'use strict';

const fs = require('fs');
const { FLOURISH_SYSTEM_PROMPT } = require('./prompt');

// single-quote a value for POSIX sh
function shq(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// Tolerate people pasting a full SSH target. Pulls username/port out of the
// host field so `aiops@192.168.86.208`, `ssh://user@host:2222`, `host:22`, and
// `[::1]:22` all work; an explicit Username field still wins.
function normalizeTarget(cfg) {
  let host = String(cfg.host || '').trim().replace(/^ssh:\/\//i, '');
  let username = String(cfg.username || '').trim();
  let port = Number(cfg.port) || 22;

  host = host.replace(/\/.*$/, '');                 // drop any path
  const at = host.lastIndexOf('@');                 // user@host
  if (at !== -1) { const u = host.slice(0, at); host = host.slice(at + 1); if (!username && u) username = u; }

  const m6 = host.match(/^\[([^\]]+)\]:(\d+)$/);     // [ipv6]:port
  if (m6) { host = m6[1]; port = Number(m6[2]) || port; }
  else if ((host.match(/:/g) || []).length === 1) { // host:port (ignore bare ipv6)
    const [h, p] = host.split(':');
    if (/^\d+$/.test(p)) { host = h; port = Number(p); }
  }
  return { host, username, port };
}

function connectConfig(cfg) {
  const t = normalizeTarget(cfg);
  const c = {
    host: t.host,
    port: t.port,
    username: t.username,
    readyTimeout: 15000,
    keepaliveInterval: 20000,
  };
  if (cfg.authMethod === 'password') {
    c.password = cfg.password;
  } else if (cfg.authMethod === 'agent') {
    c.agent = process.env.SSH_AUTH_SOCK ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
  } else {
    if (cfg.privateKeyPath) {
      const raw = fs.readFileSync(cfg.privateKeyPath);
      if (raw.slice(0, 24).toString('utf8').startsWith('PuTTY-User-Key-File')) {
        throw new Error('That looks like a PuTTY .ppk key, which isn\'t supported. In PuTTYgen, use Conversions → Export OpenSSH key, then point Flourish at that file (or switch to Password auth).');
      }
      c.privateKey = raw;
    }
    if (cfg.passphrase) c.passphrase = cfg.passphrase;
  }
  return c;
}

// what makes two connections "the same" (so we can reuse the socket)
function connSignature(cfg) {
  const t = normalizeTarget(cfg);
  return [t.host, t.port, t.username, cfg.authMethod, cfg.privateKeyPath, cfg.cwd].join('|');
}

// The inner command that runs Claude Code headless in stream-json mode. The
// trailing `< /dev/null` avoids Claude Code's 3s wait for stdin.
function buildInner(userText, cfg, sessionId) {
  const inner = [];
  if (cfg.cwd && cfg.cwd.trim()) inner.push('cd ' + shq(cfg.cwd.trim()) + ' &&');
  inner.push(shq(cfg.claudePath || 'claude'));
  inner.push('-p', shq(userText));
  inner.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
  inner.push('--append-system-prompt', shq(FLOURISH_SYSTEM_PROMPT));
  if (cfg.model && cfg.model.trim()) inner.push('--model', shq(cfg.model.trim()));
  if (cfg.effort && cfg.effort.trim()) inner.push('--effort', shq(cfg.effort.trim()));
  if (sessionId) inner.push('--resume', shq(sessionId));
  if (cfg.bypass !== false) inner.push('--permission-mode', 'bypassPermissions');
  inner.push('< /dev/null');
  return inner.join(' ');
}

// Wrapped in `bash -lc` so a login shell puts ~/.local/bin (etc.) on PATH for a
// non-interactive SSH exec.
function buildCommand(userText, cfg, sessionId) {
  return 'bash -lc ' + shq(buildInner(userText, cfg, sessionId));
}

// The same invocation as an argv array, for spawning `claude` directly when the
// server already runs on the box Claude Code lives on (server.js). No shell, so
// nothing here is quoted — shq() would embed literal quotes into the arguments.
// Kept beside buildInner() on purpose: these two must teach the model the same
// vocabulary, and they drift the moment they live apart.
function buildArgs(userText, cfg, sessionId) {
  const a = ['-p', String(userText)];
  a.push('--output-format', 'stream-json', '--verbose', '--include-partial-messages');
  a.push('--append-system-prompt', FLOURISH_SYSTEM_PROMPT);
  if (cfg.model && cfg.model.trim()) a.push('--model', cfg.model.trim());
  if (cfg.effort && cfg.effort.trim()) a.push('--effort', cfg.effort.trim());
  if (sessionId) a.push('--resume', sessionId);
  if (cfg.bypass !== false) a.push('--permission-mode', 'bypassPermissions');
  return a;
}

module.exports = { shq, normalizeTarget, connectConfig, connSignature, buildInner, buildCommand, buildArgs };
