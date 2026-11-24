#!/usr/bin/env node
/**
 * Thought census (grant gr_7h6r66d10i, kr_s6e3nwopuq and kr_n5142dkl6p): of a live town's `agent.thought` lines since a
 * time (the deploy's /api/health startedAt), how many show raw markdown characters in Talk, and how many end in a word
 * cut in half.
 *
 *   node scripts/thought-census.mjs [https://muster.town] [--from=ISO] [--examples=5]
 *
 * Raw markdown is counted twice: in the stored text (`**`, a backtick, a `- ` / `1.` / `#` line start), and in what
 * Talk shows after ThoughtText renders it (packages/web/src/panels/thoughtMarkdown.ts: `**x**` is bold, `` `x` `` is code,
 * list markers and heading hashes come off). The key result is the rendered share.
 *
 * A cut: the line ends in "…". The old clip (slice at 199 + "…") always made a 200-char line; the new one cuts before a
 * space, so the line is shorter. A cut is counted as mid-word when it ends in a letter + "…" and is exactly 200 chars
 * (the old hard cut's signature); every new-style cut is printed so a reader can check its last word by eye.
 * Exit code 0 always: it measures, it doesn't gate.
 */
import { inlineParts, thoughtLines } from "../packages/web/src/panels/thoughtMarkdown.ts";

const args = process.argv.slice(2);
const flag = (name, dflt) => { const a = args.find((x) => x.startsWith(`--${name}`)); return a === undefined ? dflt : a.includes("=") ? a.split("=")[1] : true; };
const base = (args.find((a) => !a.startsWith("--")) ?? "https://muster.town").replace(/\/+$/, "");
const examples = Number(flag("examples", 5));
let from = flag("from", "");
if (!from) {
  const h = await fetch(`${base}/api/health`).then((r) => r.json());
  from = h.startedAt;
  console.log(`--from not given: counting from the live server's start, ${from} (commit ${String(h.commit).slice(0, 8)})`);
}

// /api/events?since=<id> pages forward in id order; `from` keeps events at or after the time
const thoughts = [];
for (let since = 0, pages = 0; pages < 200; pages++) {
  const res = await fetch(`${base}/api/events?since=${since}&from=${encodeURIComponent(from)}&limit=1000`);
  if (!res.ok) { console.error(`GET /api/events: ${res.status}`); process.exit(0); }
  const { events } = await res.json();
  if (!events.length) break;
  for (const e of events) if (e.type === "agent.thought" && e.text) thoughts.push(e);
  since = events[events.length - 1].id;
  if (events.length < 1000) break;
}
if (!thoughts.length) { console.log("no agent.thought lines in the window"); process.exit(0); }

const RAW = /\*\*|`|^\s*(?:[-*+•]\s|\d+[.)]\s|#{1,6}\s)/m;
/** What Talk shows: each line with its markers off, bold and code as their text. */
const shown = (t) => thoughtLines(t).map((l) => inlineParts(l).map((p) => p.text).join("")).join("\n");
const rendered = (t) => {
  // a span ThoughtText renders keeps no marker; leftover ** or ` (unpaired) or a line start it did not take off shows
  const parts = thoughtLines(t).flatMap((l) => inlineParts(l));
  return parts.some((p) => p.kind === "text" && /\*\*|`/.test(p.text));
};
const cuts = thoughts.filter((e) => e.text.endsWith("…"));
const midWord = cuts.filter((e) => /\p{L}…$/u.test(e.text) && e.text.length === 200);
const stored = thoughts.filter((e) => RAW.test(e.text));
const showsRaw = thoughts.filter((e) => rendered(e.text));
const pct = (n) => `${((n / thoughts.length) * 100).toFixed(1)}%`;

console.log(`${base}: ${thoughts.length} agent.thought lines, ${thoughts[0].ts} to ${thoughts[thoughts.length - 1].ts}`);
console.log(`stored text with markdown characters: ${stored.length} (${pct(stored.length)})`);
console.log(`Talk shows raw markdown characters:   ${showsRaw.length} (${pct(showsRaw.length)})   [kr_s6e3nwopuq: under 5%]`);
console.log(`clipped with "…":                     ${cuts.length} (${pct(cuts.length)})`);
console.log(`cut mid-word (200 chars, letter+…):   ${midWord.length} (${pct(midWord.length)})   [kr_n5142dkl6p: 0]`);
for (const e of showsRaw.slice(0, examples)) console.log(`  raw: ${shown(e.text).slice(-120)}`);
for (const e of midWord.slice(0, examples)) console.log(`  mid-word: …${e.text.slice(-60)}`);
for (const e of cuts.filter((c) => !midWord.includes(c)).slice(0, examples)) console.log(`  cut (${e.text.length} chars): …${e.text.slice(-60)}`);
