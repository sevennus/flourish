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

40 effects. **Point effects** fire once at the caret; **text spans** wrap text
and must be closed.

| Point effect | Reads as |
|---|---|
| `{{fx:spark}}` | starting a step, a small win |
| `{{fx:ripple}}` | a quiet beat, a realisation |
| `{{fx:pulse}}` | emphasis (screen flash) |
| `{{fx:embers}}` | work warming up |
| `{{fx:meteor}}` | a wide sweep or search |
| `{{fx:beam}}` | reading, checking, going through |
| `{{fx:sonar}}` | probing, testing, looking for something |
| `{{fx:matrix}}` | digging into code |
| `{{fx:swarm}}` | many things at once, parallel work |
| `{{fx:constellation}}` | connecting the pieces, seeing the pattern |
| `{{fx:aurora}}` | ambient, calm, a lull |
| `{{fx:bloom}}` | something growing, opening out |
| `{{fx:rain}}` | steady, a lot of small things, a downbeat |
| `{{fx:frost}}` | cold, stopping, a freeze |
| `{{fx:warp}}` | speed, a big jump |
| `{{fx:vortex}}` | converging on an answer |
| `{{fx:implode}}` | narrowing down, focusing |
| `{{fx:confetti}}` | a real success |
| `{{fx:fireworks}}` | a bigger success |
| `{{fx:lightning}}` | a sudden insight, a hard truth |
| `{{fx:nova}}` | the biggest moments only |
| `{{fx:shatter}}` | something broke hard |
| `{{fx:glitch}}` | something broken or corrupt |
| `{{fx:shake}}` | a failure |

| Text span | Reads as |
|---|---|
| `{{fx:glow}}…{{/fx:glow}}` | a key result |
| `{{fx:shimmer}}…{{/fx:shimmer}}` | polished, elegant |
| `{{fx:chrome}}…{{/fx:chrome}}` | hard, engineered, machined |
| `{{fx:rainbow}}…{{/fx:rainbow}}` | playful, celebratory |
| `{{fx:sparkle}}…{{/fx:sparkle}}` | delightful, a little magic |
| `{{fx:fire}}…{{/fx:fire}}` | hot, urgent |
| `{{fx:neon}}…{{/fx:neon}}` | a name or label |
| `{{fx:flicker}}…{{/fx:flicker}}` | unstable, failing |
| `{{fx:corrupt}}…{{/fx:corrupt}}` | broken data, garbage |
| `{{fx:ghost}}…{{/fx:ghost}}` | an aside, a maybe |
| `{{fx:wave}}…{{/fx:wave}}` | lilting, rolling |
| `{{fx:bounce}}…{{/fx:bounce}}` | upbeat |
| `{{fx:stamp}}…{{/fx:stamp}}` | a verdict, a decision, final |
| `{{fx:scramble}}…{{/fx:scramble}}` | text that decodes into place |
| `{{fx:redact}}…{{/fx:redact}}` | a bar slides away — a reveal |
| `{{fx:color #ff0066}}…{{/fx:color}}` | any specific colour |

Point effects take an optional **palette** (`mint` `ice` `gold` `ember` `violet`
`rose` `mono`) and **size** (`sm` `md` `lg` `xl`), in either order —
`{{fx:spark gold}}`, `{{fx:nova sm}}`, `{{fx:swarm violet lg}}`. An unknown word
is ignored rather than fatal, so a typo costs the shading, not the effect.

The vocabulary is defined once in `src/flourish.js` and everything else is
checked against it: `npm test` fails if a name has no engine case, no CSS rule,
or no mention in the system prompt. That last one matters — an effect the prompt
never teaches is one the model will never fire. The same goes for the arg
grammar (a palette the parser accepts but the engine lacks would silently paint
the default) and for the tool map below (which the prompt can't cover, because
the model never writes it).

The parser is pure and streaming-safe (it handles a directive split across two
network chunks), so it's unit-tested without a browser.

`wave`, `bounce`, `scramble`, `stamp`, `corrupt` and `sparkle` render one `<i>`
per character (`PER_CHAR_SPANS`) so they can stagger; everything else is a
single styled span.

### Variety is mostly free

The system prompt is prepended to **every** request, so the vocabulary is the one
part of Flourish with a running token cost. Most of the variety is therefore
bought somewhere cheaper:

- **Each effect has 3–4 structural variants**, picked at random. `spark` is an
  even radial burst, or an upward fan, or a crackling double-pop, or a ring that
  snaps outward; `fireworks` is a double shell, a drooping willow, or a ring
  around a dense heart. Same directive, different picture, no prompt cost.
- **The app fires its own effects** from things the model never says: see below.
- **The auto-highlight layer** styles what the model didn't mark up at all.

### What the app paints by itself

None of this costs the model a token, and it keeps painting even in a reply that
fires no directives at all.

- **Every tool call paints its own shape** — `Read`/`Grep` sweep a beam, `Bash`
  rains glyphs, `Edit`/`Write` throw sparks, `WebSearch` throws meteors, `Task`
  releases a swarm. Tool *completion* puffs green (it used to paint nothing).
- **`src/autofx.js` highlights form, not meaning** — inline `` `code` ``,
  `**bold**` and bare numbers style themselves. This is why the system prompt
  tells the model *not* to wrap code or numbers in spans: the terminal already
  does it, and doing it with a span is what breaks copy/paste.
- **Punctuation micro-sparks** — `!` and `?` throw a small burst as they're
  revealed (throttled, or an excited reply strobes).
- **The connection paints itself** — a ripple on connect, frost on disconnect, a
  glitch on error. The model can't narrate any of that: when it matters, it's
  unreachable.
- **Ambient idle** — after ~45s of nothing, a slow aurora/swarm/constellation.

## Flourishes while you type

The prompt box paints too, independent of the model. Three layers stack:

- **Heat** — typing fast builds heat (it decays when you pause), escalating the
  sparks through five tiers — cool green flecks → warm → hot → blaze → a
  white-hot **inferno** that makes the input row itself breathe. Sending spends
  it: a cold prompt launches with a spark, an incandescent one with a nova.
- **Key class** — *what* you typed matters, not just how fast. Space puffs (and
  pays out more for a longer word), `.,;:` tick, digits fleck cyan, capitals
  land bigger, `!` sparks, `?` ripples, delete is a cold puff that cools the
  streak, and pasted text gets a constellation — it didn't come from your hands,
  so it shouldn't look like it did.
- **Streak** — an unbroken run pays out at 25, 60, 120 and 200 keys, so a long
  fluent sentence builds to something. Arrow keys leave a small wake, and a
  written-but-unsent message breathes rather than sitting inert.

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

Pure-logic unit tests (parser, auto-highlighter, stream translator, command
builder, and the vocabulary-vs-engine/CSS/prompt/tool-map seams):

```bash
npm test           # node --test — 63 tests, no browser/VM needed
```

Headless GUI smoke test (renders the real UI under a virtual display → PNG):

```bash
npm run screenshot           # needs xvfb; writes ./flourish-screenshot.png
```

Visual proof of every effect — fires each one in the real renderer and captures
it mid-flight to `assets/fx/<name>.png`:

```bash
npm run fx-shots             # needs xvfb; 37 frames
```

Particle budget — fills the engine to each rung and counts real frames:

```bash
npm run fx-bench             # needs xvfb
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
src/flourish.js  pure: streaming flourish-directive parser + arg grammar (UMD).
src/autofx.js    pure: streaming auto-highlighter for code/bold/numbers (UMD).
src/prompt.js    the flourish protocol appended to Claude Code's system prompt.
src/effects.js   canvas particle engine + full-screen effects.
src/inputfx.js   prompt-box typing sparks + the heat model.
src/renderer.js  terminal UI + typewriter that interleaves text and tool events,
                 the tool→effect map, and the app's own ambient/status effects.
src/demo.js      offline scripted responder (no VM needed).
tools/fx-shots.js  visual verification harness (alternate Electron entry).
tools/fx-bench.js  particle-budget benchmark (alternate Electron entry).
```

## Notes

- **The particle cap is a backstop, not a budget.** `MAX_PARTICLES` is 16000,
  but no effect comes close: the biggest single one is `{{fx:nova xl}}` at
  **1352** particles, and a plain `nova` is 520. Measured on this VM under
  software GL (`npm run fx-bench`, a pessimistic floor — a real GPU does
  better):

  | particles | fps |
  |---|---|
  | 400 | 60 |
  | 1600 | 60 |
  | 4000 | 60 |
  | 8000 | 31 |
  | 16000 | 11–16 |

  So the knee is around **4000**, roughly three simultaneous nova-xl, and the
  cap exists only to stop a pathological pile-up from going worse than ~15fps.
  Raising the cap alone changes nothing visible; if you want more on screen,
  raise the *per-effect* counts and re-run the bench. Ignore the first rung of a
  cold run — window/GL warm-up makes it lie (it once reported 4000 as slower
  than 8000).
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
  is a pile-up of the previous few. Its `reset()` must clear *every* array the
  engine animates (`particles` `rings` `bolts` `sheets` `sweeps` `links` `frost`
  `matrix`) — miss one when adding an effect and that effect quietly stacks up
  across every later shot.
- **An effect must be fully formed while it can still be seen.** A particle's
  alpha is `1 - life/max`, so any effect that eases its shape across the whole
  lifetime finishes forming at the moment it's already two-thirds faded.
  `bloom` originally opened over `t*1.5` and photographed as a dim smudge; it
  opens over `t*3.4` now — fully a flower by `t≈0.3`, then holds while it fades.
- **`ssh2` runs in pure-JS crypto mode.** Its optional native bindings
  (`sshcrypto`, `cpu-features`) are removed and `.npmrc` sets `omit=optional`,
  because a Node-ABI `.node` crashes Electron and can't be cross-compiled for
  Windows from Linux. Pure-JS supports ed25519/rsa keys and passwords fine.
- **Host keys** are currently accepted on first use without pinning (fine for a
  Tailscale/LAN VM you control). A future version can add TOFU verification.
- The Linux build can't render the Windows GUI, so final visual confirmation is
  on Windows; `npm run screenshot` verifies the identical renderer under Linux.
