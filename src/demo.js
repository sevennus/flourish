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

const SHOWCASE =
  "Welcome to {{fx:neon}}Flourish{{/fx:neon}} — a terminal that {{fx:rainbow}}paints as it speaks{{/fx:rainbow}}. {{fx:spark}}\n\n" +
  "The quiet ones: a word can {{fx:shimmer}}shimmer{{/fx:shimmer}}, {{fx:glow}}glow{{/fx:glow}}, run {{fx:fire}}hot{{/fx:fire}}, " +
  "go {{fx:chrome}}machined{{/fx:chrome}}, {{fx:sparkle}}sparkle{{/fx:sparkle}}, {{fx:flicker}}flicker{{/fx:flicker}}, " +
  "{{fx:corrupt}}rot{{/fx:corrupt}}, fade to a {{fx:ghost}}ghost{{/fx:ghost}}, {{fx:wave}}roll{{/fx:wave}}, " +
  "{{fx:bounce}}bounce{{/fx:bounce}}, {{fx:stamp}}land hard{{/fx:stamp}}, {{fx:scramble}}decode into place{{/fx:scramble}}, " +
  "hide behind {{fx:redact}}a black bar{{/fx:redact}}, or land in {{fx:color #ff5cad}}hot pink{{/fx:color}}. {{fx:ripple}}\n\n" +
  "The working ones: {{fx:beam}}a beam sweeps while I read, {{fx:sonar}}sonar while I probe, " +
  "{{fx:matrix}}glyphs when we go into the code, {{fx:meteor}}meteors on a wide sweep, " +
  "{{fx:swarm violet}}a swarm when a dozen things run at once, {{fx:constellation}}a constellation as the pieces connect, " +
  "and {{fx:implode}}an implosion as it all narrows to one answer. {{fx:vortex}}\n\n" +
  "The moods: {{fx:aurora}}an aurora for the lull, {{fx:rain ice}}rain for the long grind, " +
  "{{fx:bloom rose}}a bloom as something opens up, {{fx:frost}}frost when it all goes cold, " +
  "and {{fx:warp violet}}warp when we jump. {{fx:embers}}\n\n" +
  "The loud ones: {{fx:confetti}}confetti on a win, {{fx:fireworks gold}}fireworks for the reveal, " +
  "{{fx:lightning}}lightning for a hard truth, " +
  "and {{fx:glitch}}a channel tear when it all goes wrong. {{fx:shake}}\n\n" +
  "And when it really lands — {{fx:nova}}{{fx:glow}}a nova{{/fx:glow}}. {{fx:pulse}}\n\n" +
  // The unreliable register. Everything above is honest — a glowing command is
  // still the command — and these are not: they change the text after you've
  // read it. The words inside the mutating spans are deliberately throwaway,
  // because smoke.js spot-checks this paragraph and rot WILL eat whatever it is
  // pointed at. "The unreliable ones" sits outside them on purpose.
  "The unreliable ones: two copies {{fx:twin}}drift apart{{/fx:twin}}, characters " +
  "{{fx:overwrite}}land on top of each other{{/fx:overwrite}}, " +
  "{{fx:palimpsest and this is what it said before}}an edit shows its workings{{/fx:palimpsest}}, " +
  "{{fx:rot}}this line will not survive being read twice{{/fx:rot}}, " +
  "{{fx:confabulate}}you will always remember it correctly{{/fx:confabulate}}. " +
  "{{fx:dilate}} Then it just stops for a beat. {{fx:ripple mono}}\n\n" +
  // salvage sits this late on purpose, and it's the one beat in the showcase
  // whose position is load-bearing. It steals its letters from text already on
  // screen, so up at the top — with an empty transcript above it — every
  // character would miss and fall back to flying in from a random point. It
  // would look identical and mean nothing. Down here it has five paragraphs to
  // rob.
  "{{fx:salvage}}This sentence was assembled out of letters already on this screen{{/fx:salvage}}, " +
  "which is the one effect here that needs something to have been said first. {{fx:constellation}}\n\n" +
  "Every one of those was written into my reply by the {{fx:wave}}flourish protocol{{/fx:wave}} — " +
  "the same channel real Claude Code uses over SSH. The terminal adds its own on top: `inline code`, " +
  "**bold**, and numbers like 16000 highlight themselves, and every tool call paints its own shape. " +
  "Now type something and watch the prompt box itself. {{fx:spark gold}}";

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
