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
  "{{fx:wave}}roll{{/fx:wave}}, {{fx:bounce}}bounce{{/fx:bounce}}, {{fx:scramble}}decode into place{{/fx:scramble}}, " +
  "or land in {{fx:color #ff5cad}}hot pink{{/fx:color}}. {{fx:ripple}}\n\n" +
  "The loud ones: {{fx:confetti}}confetti on a win, {{fx:fireworks}}fireworks for the reveal, " +
  "{{fx:embers}}embers as the work warms up, {{fx:meteor}}meteors on a wide sweep, " +
  "{{fx:vortex}}a vortex converging on an answer, {{fx:lightning}}lightning for a hard truth, " +
  "{{fx:matrix}}glyphs when we go into the code, and {{fx:glitch}}a channel tear when it all breaks. {{fx:shake}}\n\n" +
  "And when it really lands — {{fx:nova}}{{fx:glow}}a nova{{/fx:glow}}. {{fx:pulse}}\n\n" +
  "Every one of those was written into my reply by the {{fx:wave}}flourish protocol{{/fx:wave}} — " +
  "the same channel real Claude Code uses over SSH. Now type something and watch the prompt box itself. {{fx:spark}}";

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
