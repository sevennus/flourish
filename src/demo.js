/*
 * demo.js — offline scripted responder.
 *
 * Lets the app show effects instantly with no API key, and gives the headless
 * screenshot test something deterministic to render. Pure string in / string
 * out; the main process handles chunking + timing so this stays testable.
 *
 * CommonJS: consumed by the main process (and the tests).
 */
'use strict';

// The full reel. The brief: EVERY effect, fired at least twice, and about three
// times the length of the old one-pass tour. It is deliberately a firehose —
// the app streams it paced by the typewriter, so the scenes spread out into a
// long, dense sequence rather than all landing at once.
//
// Load-bearing invariants, all checked by tools/smoke.js and enforced here:
//   * The section anchors below sit OUTSIDE every span — smoke.js spot-checks
//     each one to prove the stream didn't stall mid-reel: "a terminal that
//     paints as it speaks", "The quiet ones", "The working ones", "The moods",
//     "The loud ones", "a nova", "The unreliable ones", "Then it just stops for
//     a beat", and the final "watch the prompt box itself".
//   * rot / confabulate / intrusive rewrite their own characters after landing,
//     so everything inside them is throwaway prose, never an anchor.
//   * salvage and the grid/arcade scenes STEAL from or paint INTO the text
//     already on screen, so they sit late, with paragraphs above them to rob.
const SHOWCASE =
  // ---- open ----
  "Welcome to {{fx:neon}}Flourish{{/fx:neon}} — {{fx:neon}}a terminal that paints as it speaks{{/fx:neon}}. " +
  "{{fx:spark}} {{fx:spark gold}} This is the whole arsenal: every effect I own, fired more than once, top " +
  "to bottom. {{fx:ripple}} {{fx:ripple ice}} Settle in.\n\n" +

  // ---- the quiet ones: every style span, each twice ----
  "The quiet ones — the register that lives inside a single word. A word can {{fx:shimmer}}shimmer{{/fx:shimmer}} " +
  "and {{fx:shimmer}}shimmer again{{/fx:shimmer}}, {{fx:glow}}glow{{/fx:glow}} then {{fx:glow gold}}glow brighter{{/fx:glow}}, " +
  "run {{fx:fire}}hot{{/fx:fire}} and {{fx:fire}}hotter{{/fx:fire}}, go {{fx:chrome}}machined{{/fx:chrome}} then " +
  "{{fx:chrome}}machined again{{/fx:chrome}}, turn {{fx:rainbow}}playful{{/fx:rainbow}} and {{fx:rainbow}}playful twice{{/fx:rainbow}}, " +
  "and catch a little {{fx:sparkle}}magic{{/fx:sparkle}} then {{fx:sparkle}}a little more{{/fx:sparkle}}. It can " +
  "{{fx:flicker}}fail to hold{{/fx:flicker}} and {{fx:flicker}}fail again{{/fx:flicker}}, {{fx:corrupt}}curdle to garbage{{/fx:corrupt}} " +
  "then {{fx:corrupt}}curdle worse{{/fx:corrupt}}, fade to a {{fx:ghost}}ghost{{/fx:ghost}} and {{fx:ghost}}fainter still{{/fx:ghost}}, " +
  "{{fx:wave}}roll like water{{/fx:wave}} and {{fx:wave}}roll on{{/fx:wave}}, {{fx:bounce}}bounce{{/fx:bounce}} and " +
  "{{fx:bounce}}bounce back{{/fx:bounce}}, {{fx:stamp}}land like a verdict{{/fx:stamp}} then {{fx:stamp}}land harder{{/fx:stamp}}. " +
  "Text can {{fx:scramble}}decode into place{{/fx:scramble}} and {{fx:scramble}}decode once more{{/fx:scramble}}, resolve out of " +
  "{{fx:hexdump}}raw bytes{{/fx:hexdump}} and {{fx:hexdump}}raw bytes again{{/fx:hexdump}}, arrive {{fx:hologram}}projected{{/fx:hologram}} " +
  "then {{fx:hologram}}projected again{{/fx:hologram}}, hide behind {{fx:redact}}a black bar{{/fx:redact}} that slides to a " +
  "{{fx:redact}}second reveal{{/fx:redact}}, and land in {{fx:color #ff5cad}}hot pink{{/fx:color}} or {{fx:color #35f0a0}}poison green{{/fx:color}}. {{fx:ripple gold}}\n\n" +

  // ---- the working ones: every work-shaped point effect, each twice ----
  "The working ones — the shapes real work throws off. {{fx:beam}}A beam sweeps while I read, {{fx:beam ice}}and " +
  "sweeps again on the second pass. {{fx:sonar}}Sonar while I probe, {{fx:sonar violet}}then a wider arc after. " +
  "{{fx:matrix}}Glyphs as we drop into the code, {{fx:matrix violet}}and more of them the deeper it goes. {{fx:meteor}}Meteors " +
  "on a wide search, {{fx:meteor ice}}twice over. {{fx:swarm violet}}A swarm when a dozen things run at once, {{fx:swarm gold}}and " +
  "another dozen behind them. {{fx:constellation}}A constellation as the pieces connect, {{fx:constellation ice}}and connect " +
  "again. {{fx:tracer}}Tracers down the call paths, {{fx:tracer ice}}and back up them. {{fx:circuit}}The board lights up where " +
  "it's wired, {{fx:circuit ember}}trace by trace. {{fx:grid}}The floor tilts into a neon horizon, {{fx:grid violet}}and again. " +
  "{{fx:warp}}The starfield stretches as we jump, {{fx:warp gold}}and jumps once more. {{fx:implode}}Everything narrows to a point, " +
  "{{fx:implode violet}}and narrows again, {{fx:vortex}}spiralling up into {{fx:glow}}one answer{{/fx:glow}} {{fx:vortex gold}}— twice confirmed.\n\n" +

  // ---- the moods, each twice ----
  "The moods — the slow weather in between. {{fx:aurora}}An aurora for the lull, {{fx:aurora ice}}and a second curtain " +
  "behind it. {{fx:bloom rose}}A bloom as something opens, {{fx:bloom gold}}then opens further. {{fx:rain ice}}Rain for the long " +
  "grind, {{fx:rain}}and more rain after. {{fx:embers}}Coals warming up, {{fx:embers ember}}breathing under the ash. {{fx:frost}}Frost " +
  "when it goes cold, {{fx:frost ice xl}}and colder still. {{fx:scanlines}}The CRT soul rolls down, {{fx:scanlines}}and rolls again. " +
  "{{fx:static}}Signal drops to snow, {{fx:static}}and drops once more. {{fx:vhs}}The tracking tears, {{fx:vhs}}and tears again.\n\n" +

  // ---- the loud ones, each twice ----
  "The loud ones — the punctuation you can hear. {{fx:confetti}}Confetti on a win, {{fx:confetti}}and again. {{fx:fireworks gold}}Fireworks " +
  "for the reveal, {{fx:fireworks}}and one more shell. {{fx:lightning}}Lightning for a hard truth, {{fx:lightning violet}}and a second " +
  "strike across every line. {{fx:glitch}}A channel tear when it breaks, {{fx:glitch}}and tears again. {{fx:shake}}The frame flinches, " +
  "{{fx:shake}}and flinches once more. {{fx:pulse}}A flash for emphasis, {{fx:pulse gold}}and a brighter one.\n\n" +

  "And when it really lands — {{fx:nova}}{{fx:glow}}a nova{{/fx:glow}}. And when it lands even harder — {{fx:nova sm}}another. {{fx:pulse}}\n\n" +

  // ---- the machine talks to itself: the ten hacker scenes, each twice ----
  "The machine talks to itself — the low-level register, done literally. First you knock on every door: {{fx:portscan}} " +
  "and knock again, because the first pass never tells the truth: {{fx:portscan}} Something answered, so you follow it home " +
  "hop by hop: {{fx:trace}} and take a second route to be sure: {{fx:trace}} You spread the process tree to see what spawned " +
  "what: {{fx:daemon}} and again, a level deeper: {{fx:daemon}} You read the wire raw, credential and all: {{fx:sniffer}} and " +
  "capture a second burst: {{fx:sniffer}} You take the password one tumbler at a time: {{fx:crack}} then crack a second lock: " +
  "{{fx:crack}} When brute force is too elegant, you just dial every number until one answers: {{fx:wardial}} and dial the next " +
  "exchange: {{fx:wardial}} And some boundaries don't hold — you flood the buffer until the return address is all A's: {{fx:overflow}} " +
  "and smash it again to prove it: {{fx:overflow}}\n\n" +

  // ---- the grid dreams in colour: painted INTO the prose above ----
  "The grid dreams in colour — effects painted INTO these very characters, built out of everything already on the page. A " +
  "wireframe solid tumbles through the paragraph, lighting the letters its edges cross: {{fx:wireframe sphere}} then turns " +
  "end-over-end as a prism: {{fx:wireframe prism}} then once more as a cube: {{fx:wireframe cube}} The whole page dissolves into " +
  "a rolling colour field: {{fx:plasma}} and again at a different frequency: {{fx:plasma violet}} A tunnel bores through the text, " +
  "rings rushing outward: {{fx:tunnel}} and deeper: {{fx:tunnel ember}} Fire climbs the bottom of the screen and the prose burns " +
  "as fuel: {{fx:firewall}} and burns hotter: {{fx:firewall ember}}\n\n" +

  // ---- the arcade: your own words fight back ----
  "The arcade — where your own words fight back. The snake hunts down the nearest character and eats it: {{fx:snake}} and comes " +
  "back hungrier: {{fx:snake violet}} A formation marches down and bombs the paragraph while a cannon holds the line: {{fx:invaders}} " +
  "and reinforcements arrive: {{fx:invaders}} Pac-Man clears a line pellet by pellet with a ghost in chase: {{fx:pacman}} and clears " +
  "another: {{fx:pacman}} A saucer parks over a word and lifts it clean off the line: {{fx:ufo}} and comes back for seconds: {{fx:ufo}} " +
  "A singularity opens and drags the nearby text down the drain: {{fx:blackhole}} and collapses again: {{fx:blackhole violet}} Conway's " +
  "Life breeds out of the ink and gliders away: {{fx:life}} then seeds a second colony: {{fx:life}} The screen turns to wax and drips: " +
  "{{fx:melt}} and melts again: {{fx:melt}} The ground shakes and the characters heap at the bottom: {{fx:quake}} then the aftershock: " +
  "{{fx:quake}} A word lifts off and bounces like the screensaver logo: {{fx:dvd}} still praying for the corner: {{fx:dvd}} The tank " +
  "floods and the fish move in: {{fx:aquarium}} and it refills deeper: {{fx:aquarium}} And the one warm thing that isn't trying to " +
  "prove anything: {{fx:cat}} who brought a friend: {{fx:cat gold}}\n\n" +

  // ---- the arrival: the biggest things it draws ----
  "The arrival — the biggest things this terminal draws. Something dies, and the skull assembles out of the letters and chomps " +
  "its verdict: {{fx:skull}} and death takes an encore: {{fx:skull violet}} The whole city rushes up out of the dark: {{fx:gibson}} " +
  "and you only really see it the second time: {{fx:gibson}} And the title card it all deserves: {{fx:banner}} and one more: {{fx:banner}}\n\n" +

  // ---- the unreliable ones. Anchor sits OUTSIDE the mutating spans; their
  //      contents are throwaway, because rot/confabulate rewrite themselves. ----
  "The unreliable ones — the register that lies. Two copies {{fx:twin}}drift apart{{/fx:twin}}, then {{fx:twin}}drift further{{/fx:twin}}. " +
  "Characters {{fx:overwrite}}land on top of each other{{/fx:overwrite}}, and {{fx:overwrite}}pile up again{{/fx:overwrite}}. " +
  "{{fx:palimpsest and this is what it said before}}An edit shows its workings{{/fx:palimpsest}}, and " +
  "{{fx:palimpsest the previous draft is still down here}}the old draft bleeds up once more{{/fx:palimpsest}}. " +
  "{{fx:rot}}this line will not survive being read twice{{/fx:rot}}, {{fx:rot}}and neither will this one, if you are honest{{/fx:rot}}. " +
  "{{fx:confabulate}}you will always remember it correctly{{/fx:confabulate}}, {{fx:confabulate}}and you would surely have caught any change{{/fx:confabulate}}. " +
  "And a thought that {{fx:intrusive lightning}}was never part of the sentence{{/fx:intrusive}} shoulders in, then a second that " +
  "{{fx:intrusive skull}}withdraws before you can be sure{{/fx:intrusive}}. " +
  "{{fx:dilate}} Then it just stops for a beat. {{fx:dilate}} And stops once more. {{fx:ripple mono}}\n\n" +

  // ---- the destroyers: the disappearing IS the point. Throwaway prose. ----
  "The destroyers, where the vanishing is the whole point. This idea is dead: {{fx:burn right gale}}strike this line from the record " +
  "and let the fire take it downwind{{/fx:burn}}. And this draft was never any good: {{fx:burn left}}burn this one upwind, slower{{/fx:burn}}. " +
  "This one isn't worth keeping at all: {{fx:cascade}}let these characters fall away for good{{/fx:cascade}}, and neither is this: " +
  "{{fx:cascade right}}drop this line too{{/fx:cascade}}.\n\n" +

  // ---- salvage: steals its letters from the reel above, so it sits last ----
  "{{fx:salvage}}This sentence was assembled out of letters already on this screen{{/fx:salvage}}, {{fx:salvage scatter}}and this " +
  "one too, lifted all at once from everything said above{{/fx:salvage}} — the one effect that needs the whole reel to exist first. {{fx:constellation ice}}\n\n" +

  // ---- close (anchor: "watch the prompt box itself") ----
  "Every one of those was written into my reply by the {{fx:wave}}flourish protocol{{/fx:wave}} — the same channel real Claude " +
  "Code uses over SSH. The terminal adds its own on top: `inline code`, **bold**, and numbers like 16000 highlight themselves, " +
  "and every tool call paints its own shape. Now type something and watch the prompt box itself. {{fx:spark gold}} {{fx:confetti}}";

const RESPONSES = [
  {
    match: /\b(hi|hello|hey|yo|sup|howdy)\b/i,
    text:
      "Hey there. {{fx:spark}} You've reached {{fx:glow}}Flourish{{/fx:glow}} in demo mode — " +
      "no key needed to see the {{fx:rainbow}}fireworks{{/fx:rainbow}}. Ask me to celebrate something and watch. {{fx:ripple}}",
  },
  {
    match: /\b(celebrate|win|won|success|ship|shipped|done|finished|launch)\b/i,
    text:
      "That calls for a party. {{fx:confetti}} {{fx:fireworks}} " +
      "Genuinely {{fx:glow}}well done{{/fx:glow}} — {{fx:rainbow}}ship it{{/fx:rainbow}}! {{fx:nova}}",
  },
  {
    match: /\b(effect|effects|flourish|flourishes|show|demo|what can you)\b/i,
    text: SHOWCASE,
  },
  {
    match: /\b(matrix|hack|code|green)\b/i,
    text:
      "Follow the white rabbit. {{fx:matrix}} Wake up, {{fx:color #33ff88}}Neo{{/fx:color}}... " +
      "the {{fx:wave}}terminal{{/fx:wave}} has you. {{fx:spark}}",
  },
  {
    match: /\b(break|broke|broken|fail|failed|error|bug|crash|wrong)\b/i,
    text:
      "{{fx:glitch}} Something's {{fx:fire}}on fire{{/fx:fire}} — and not the good kind. {{fx:shake}} " +
      "In the real thing I'd go read the stack trace; {{fx:embers}}here I just get to look worried about it. {{fx:lightning}}",
  },
  {
    match: /\b(search|find|look|scan|sweep|where)\b/i,
    text:
      "Casting the net wide. {{fx:meteor}} Sweeping the tree{{fx:matrix}}, pulling the threads together{{fx:vortex}}, " +
      "and landing on {{fx:glow}}one answer{{/fx:glow}}. {{fx:spark}}",
  },
  {
    match: /\b(secret|reveal|hidden|decode|mystery)\b/i,
    text:
      "Leaning in. {{fx:ripple}} {{fx:scramble}}The message decodes as it arrives{{/fx:scramble}} — " +
      "that's the {{fx:neon}}scramble{{/fx:neon}} span, one character at a time. {{fx:lightning}}",
  },
];

const DEFAULT =
  "You're in {{fx:glow}}demo mode{{/fx:glow}}, so I'm reading from a small script instead of the live model. " +
  "Try \"{{fx:shimmer}}show me the effects{{/fx:shimmer}}\" or add your Anthropic API key in settings to talk to the real thing. {{fx:spark}}";

function pickDemoResponse(userText) {
  const t = String(userText || '');
  for (const r of RESPONSES) {
    if (r.match.test(t)) return r.text;
  }
  return DEFAULT;
}

module.exports = { pickDemoResponse, SHOWCASE, DEFAULT, RESPONSES };
