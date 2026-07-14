# Flourish

A PuTTY-style Windows terminal that **SSHes into your VM and drives Claude Code
there**, streaming its output back and **painting visual flourishes** the model
directs inline.

It is a real SSH client (via `ssh2`). Nothing is installed or run on the VM
beyond the `claude` you already have — Flourish just logs in and runs it
headless. Your Anthropic auth stays on the VM; only SSH credentials live in this
app.

![what it looks like](assets/screenshot.png)

## How it works

```
Windows app ──SSH──▶ Ubuntu VM ──▶ claude -p --output-format stream-json
   (ssh2)                           (Claude Code, real tools on the VM)
      ▲                                    │
      └──────── text deltas + tool events ─┘  → typewriter + flourishes
```

Per message, Flourish runs (roughly):

```
bash -lc "cd <project> && claude -p '<your message>' \
  --output-format stream-json --verbose --include-partial-messages \
  --append-system-prompt '<flourish protocol>' \
  --resume <session-id> --permission-mode bypassPermissions < /dev/null"
```

- **`--resume <session-id>`** keeps the conversation going — context lives in the
  Claude Code session on the VM, so the app only ever sends your latest message.
- **`--append-system-prompt`** teaches Claude Code the flourish vocabulary so its
  normal working replies carry the effect markers.
- **`--permission-mode bypassPermissions`** (the "bypass / dangerous" toggle)
  lets Claude Code run tools without prompting. Turn it off in settings to be
  asked-per-tool instead (headless, so an un-approved tool just errors).
- **`bash -lc`** ensures `claude` is on `PATH` over a non-login SSH exec;
  **`< /dev/null`** avoids Claude Code's 3-second wait for stdin.

Tool calls (Read, Bash, Edit, …) show up as dim `⚙ Tool` lines that flip to
`✓ Tool` when they finish, and a spark fires each time one starts.

## The flourish protocol

22 effects. **Point effects** fire once at the caret; **text spans** wrap text
and must be closed.

| Point effect | Reads as |
|---|---|
| `{{fx:spark}}` | starting a step, a small win |
| `{{fx:ripple}}` | a quiet beat, a realisation |
| `{{fx:pulse}}` | emphasis (screen flash) |
| `{{fx:embers}}` | work warming up |
| `{{fx:meteor}}` | a wide sweep or search |
| `{{fx:confetti}}` | a real success |
| `{{fx:fireworks}}` | a bigger success |
| `{{fx:vortex}}` | converging on an answer |
| `{{fx:lightning}}` | a sudden insight, a hard truth |
| `{{fx:nova}}` | the biggest moments only |
| `{{fx:matrix}}` | digging into code |
| `{{fx:glitch}}` | something broken or corrupt |
| `{{fx:shake}}` | a failure |

| Text span | Reads as |
|---|---|
| `{{fx:glow}}…{{/fx:glow}}` | a key result |
| `{{fx:shimmer}}…{{/fx:shimmer}}` | polished, elegant |
| `{{fx:rainbow}}…{{/fx:rainbow}}` | playful, celebratory |
| `{{fx:fire}}…{{/fx:fire}}` | hot, urgent |
| `{{fx:neon}}…{{/fx:neon}}` | a name or label |
| `{{fx:wave}}…{{/fx:wave}}` | lilting, rolling |
| `{{fx:bounce}}…{{/fx:bounce}}` | upbeat |
| `{{fx:scramble}}…{{/fx:scramble}}` | text that decodes into place |
| `{{fx:color #ff0066}}…{{/fx:color}}` | any specific colour |

The vocabulary is defined once in `src/flourish.js` and everything else is
checked against it: `npm test` fails if a name has no engine case, no CSS rule,
or no mention in the system prompt. That last one matters — an effect the prompt
never teaches is one the model will never fire.

The parser is pure and streaming-safe (it handles a directive split across two
network chunks), so it's unit-tested without a browser.

`wave`, `bounce` and `scramble` render one `<i>` per character (`PER_CHAR_SPANS`)
so they can stagger; everything else is a single styled span.

## Flourishes while you type

The prompt box paints too, independent of the model. Every keystroke throws a
spark off the caret, and typing fast builds **heat** (it decays when you pause)
which escalates the sparks through four tiers — cool green flecks → warm → hot →
a blazing orange plume — and glows the input row to match. Sending spends the
heat: a cold prompt launches with a spark, a blazing one with a nova.

Finding the caret inside an `<input>` is the fiddly part (no Range API for form
fields), so `src/inputfx.js` measures the text before the caret with the input's
own computed font on a scratch canvas.

## Requirements

- **On the VM:** Claude Code (`claude`) installed and authenticated, and SSH
  access (key or password). That's it — no server to run.
- **To build/develop:** Node.js 18+ and npm.

```bash
npm install        # ssh2 (pure-JS) is the only runtime dep
```

## Start / Stop

```bash
npm start          # launches the Electron app
```

Open **⚙ settings**, enter your VM's host/IP (Tailscale IP works), username, and
SSH key (or password), optionally a working directory and model, then **Test
connection**. Or tick **Demo mode** to see the effects with no VM. Close the
window (or Ctrl-C the launching terminal) to stop.

## Test

Pure-logic unit tests (parser, stream translator, command builder, and the
vocabulary-vs-engine/CSS/prompt seams):

```bash
npm test           # node --test — 39 tests, no browser/VM needed
```

Headless GUI smoke test (renders the real UI under a virtual display → PNG):

```bash
npm run screenshot           # needs xvfb; writes ./flourish-screenshot.png
```

Visual proof of every effect — fires each one in the real renderer and captures
it mid-flight to `assets/fx/<name>.png`:

```bash
npm run fx-shots             # needs xvfb; 18 frames
```

The SSH bridge was also verified end-to-end against real Claude Code over a real
SSH connection (text streaming, session-id capture, tool events, bypass mode)
using the shipping `src/bridge.js` + `src/ccstream.js`.

## Build the Windows program

Cross-packages a Windows x64 build from Linux (no Wine):

```bash
npm run package:win
(cd dist && zip -r Flourish-win32-x64.zip Flourish-win32-x64)
```

Output: `dist/Flourish-win32-x64/Flourish.exe` — copy the folder/zip to your
Windows 11 box and double-click. No install step.

## Architecture

```
main.js          Electron main: SSH connection, runs claude, parses stream-json,
                 relays text deltas + tool events over IPC. Demo mode too.
preload.js       contextBridge: the narrow window.flourishAPI surface.
src/bridge.js    pure: ssh2 connect config + the remote command builder.
src/ccstream.js  pure: Claude Code stream-json → app events (+ line buffer).
src/flourish.js  pure: streaming flourish-directive parser (UMD).
src/prompt.js    the flourish protocol appended to Claude Code's system prompt.
src/effects.js   canvas particle engine + full-screen effects.
src/inputfx.js   prompt-box typing sparks + the heat model.
src/renderer.js  terminal UI + typewriter that interleaves text and tool events.
src/demo.js      offline scripted responder (no VM needed).
tools/fx-shots.js  visual verification harness (alternate Electron entry).
```

## Notes

- **Particle glow is a cached sprite, not `ctx.shadowBlur`.** Chromium
  rasterizes canvas2d shadows on the CPU per draw call: with `shadowBlur`,
  `{{fx:nova}}`'s 180 glowing particles measured **2 frames in 353ms (~6fps)**,
  so every particle was still bunched at the origin while the effect "played".
  Baking each colour's falloff into a 64px offscreen canvas once and blitting it
  per particle took the same effect to **16 frames in 262ms (~61fps)**. Don't
  reintroduce per-particle shadows.
- **The typewriter drains its whole text backlog per frame.** It used to move
  one chunk into the reveal buffer only once that buffer ran dry, which pinned
  `reveal.length` at ~6 and defeated the adaptive rate — a hard ceiling of ~50
  chars/s regardless of how fast the model streamed (a 630-char reply finished
  painting **9.6s after the stream ended**). Now ~118 chars/s under software GL,
  and it speeds up the further behind it gets.
- **`tools/fx-shots.js` shows its window and disables background throttling.**
  A hidden or occluded Electron window throttles `requestAnimationFrame`, so
  particle life stops advancing, effects never expire, and each captured frame
  is a pile-up of the previous few.
- **`ssh2` runs in pure-JS crypto mode.** Its optional native bindings
  (`sshcrypto`, `cpu-features`) are removed and `.npmrc` sets `omit=optional`,
  because a Node-ABI `.node` crashes Electron and can't be cross-compiled for
  Windows from Linux. Pure-JS supports ed25519/rsa keys and passwords fine.
- **Host keys** are currently accepted on first use without pinning (fine for a
  Tailscale/LAN VM you control). A future version can add TOFU verification.
- The Linux build can't render the Windows GUI, so final visual confirmation is
  on Windows; `npm run screenshot` verifies the identical renderer under Linux.
