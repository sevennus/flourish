# Claude Operating Instructions — Flourish

Flourish is a terminal that paints: Claude Code, in a browser, with visual effects
driven by `{{fx:…}}` directives the model emits inline. **Read `README.md` first** —
it carries the design reasoning, the measured particle budget, and the traps. This
file is only the rules.

Flourish moved out of `/var/www/simjim/apps/flourish` into its own repo on
2026-07-16, because two Claude sessions editing one git tree kept reading each
other's uncommitted work as their own. SimJim's `CLAUDE.md` no longer governs this
folder. What follows is what still applies, plus what's specific to here.

## ⛔ Restarting this service kills the session that asked for it

**You are very likely running inside Flourish right now.** `server.js` spawns
`claude` as a child process, so an agent working on this repo is usually a
grandchild of `flourish.service`. Check before you assume:

```bash
ps -o ppid=,cmd= -p $PPID     # `/usr/bin/node server.js` => you are inside it
```

`systemctl restart flourish` SIGTERMs its active `claude` children **by design**
(process-group kill, `detached:true` + `process.kill(-pid)`). If you restart while
replying, **you kill yourself mid-sentence and the user sees `claude exited with
code 143`** — 143 is SIGTERM. This has already happened once, during the very move
that created this repo.

**Never run `systemctl restart flourish` yourself. Hand the user the command.**
Also check for in-flight runs before suggesting it, or you 502 someone else:

```bash
pgrep -P $(systemctl show -p MainPID --value flourish)
```

## What needs a restart, and what doesn't

Editing `src/` is a **browser reload** — but only for files the *browser* loads.

| Change | To take effect |
|---|---|
| `src/renderer.js`, `effects.js`, `styles.css`, `index.html`, `writeups/` | Browser reload |
| `src/prompt.js`, `src/bridge.js`, `src/demo.js`, `src/ccstream.js` | **Restart** — `require()`d by `server.js`, baked in at startup |
| `server.js` itself (routes, MIME `TYPES`, config) | **Restart** |

A prompt or vocabulary change does **nothing** on a browser reload, however many
times you Ctrl-R. This is the single most common way to fool yourself here.

To see what prompt the *running* server actually sends, rather than what's on disk:
`ps` on the flourish child shows the `--append-system-prompt` on its argv.

## Where it runs

- `/var/www/flourish` · systemd `flourish.service` · `127.0.0.1:8787`
- nginx proxies `/flourish/` with `proxy_buffering off` (buffered = the typewriter
  arrives in one lump and every effect fires at once, on nothing).
- **Tailnet-only, and this is load-bearing.** It drives Claude Code with
  `--permission-mode bypassPermissions` against `/var/www/simjim` — reachability
  **is** arbitrary code execution as `aiops`. Verify both directions after touching
  the fence: 200 from `100.76.34.62`, **403 from `127.0.0.1`** (where cloudflared
  connects from). See `/var/www/simjim/FENCE.md`.
- `.flourish-config.json` is runtime state, gitignored.

## `server.js:46` — `cwd: '/var/www/simjim'` is deliberate

That's the directory Flourish's Claude *works in*. SimJim is the app it **drives**;
this repo is only its home. Moving the app did not move its subject. Don't "fix"
this to point at itself.

## Writeups live here now

Every bug that cost more than a minute gets a writeup: **the symptom, how you found
it (what you compared, traced, measured), the root cause, the options offered and
how it was decided, and the fix with its verification.**

Include the **evidence you used to reach the conclusion as viewable artifacts** —
generated plots, probe dumps, before/after numbers, screenshots — not just prose
about them.

- Put them in **`src/writeups/<slug>/index.html`** with artifacts alongside.
- Add a card to **`src/writeups/index.html`**, newest first.
- Served at `/flourish/writeups/index.html`, linked from the titlebar. Static —
  **no restart**.
- Directory URLs do **not** resolve (`serveStatic` has no index fallback). Link to
  `<slug>/index.html` explicitly.
- Do **not** publish these to SimJim's history admin. That surface is keyed to
  SimJim SHAs, and since the `git subtree split` these are different repos with
  different SHAs. Writeups authored before 2026-07-16 cite SimJim SHAs and stay
  valid there; the mapping is in `src/writeups/index.html`.

## Verify by driving it, not by reading it

This repo has an unusually bad record of green tests on broken apps. Four separate
times, an assertion encoded the bug as the requirement.

- **`npm run smoke:web`** — no preload, real server, real network. **Use this for
  web work.** It catches a class Electron structurally cannot see.
- **`npm run test:interactive`** — drives the *interaction*: mid-reply typing, queue
  order, Esc. Named `.js` **not** `.test.js` on purpose (`node --test` discovers the
  latter and fails it on `require('electron')`).
- `npm test` covers pure modules only. **It has passed 88/88 on a fatally broken
  app.** `npm run screenshot` **exits 0 no matter what is in the PNG** — it is a
  viewing tool. Never cite either as evidence the app runs.
- **When the user reports the same thing twice, suspect the assertion before the
  code.** When a harness "proves" an effect works, check it isn't exercising a
  fallback — `tools/fx-shots.js` once photographed one and committed it as proof.

⚠ A real run through `/api/chat` spawns a **full agent with tools** — it will go run
your test suite and burn real money. Use demo mode for checks.

## Rules that carried over from SimJim

- **Keep secrets in `.env`.** Never hard-code API keys, passwords, or tokens.
- **Never disable the firewall.** Never expose a service publicly unless told to.
- **Verify completed work** with `curl`, `systemctl status`, or tests — and say
  plainly if something failed or was skipped.
- **Commit meaningful checkpoints.** A `post-commit` hook auto-pushes to
  `github.com/sevennus/flourish` — which is **PUBLIC**. Nothing secret lands here.
- Explain major system changes before making them.

## The user

Jim. He wants short running progress narration during multi-step work, and he wants
the effects **loaded up**, not rationed — "i have max 20x, that's what this is for."
Prompt-token cost is explicitly not a constraint.

**He hates text that erodes or fades as he reads it.** Destruction is fine — `burn`
is his own idea — but the disappearing must *be* the message, never decoration.
