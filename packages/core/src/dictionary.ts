/**
 * The town dictionary (docs/legible-delegation.md §5 "A town dictionary", build step 10): one meaning per word. A Town
 * Hall doc of type `dictionary`, created once at boot (`ensureDictionary`, beside the policy ledger), one entry per line
 * (`- **word**: meaning`) and an "Avoid → use" list (`- top-up → adjust`). Every manager's first message pins a short
 * block naming the words (`dictionaryBlock`), and the ask linter's `dictionary` rule warns on an avoided word with its
 * replacement: core passes the doc's pairs in at vet time (`dictionaryPairs`), so the schema rule stays pure.
 */
import type { Doc, DictionaryPair } from "@muster-town/schema";
import { createDoc } from "./domain.ts";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

const AVOID_HEADING = "## Avoid → use";

/** The words the dictionary is seeded with, one meaning each. */
const SEED_ENTRIES: readonly [string, string][] = [
  ["ask", "something only a human can do, stored with its type, target, branches and recommendation. The human decides it."],
  ["notice", "a state change with nothing to do: something shipped, a grant closed, a key result verified."],
  ["record", "what an ask or a notice came from: a rollup, a report, a grant plan. It is one click down from the card."],
  ["gate", "the point where a grant waits for a human: at its ceiling, or a step report whose forecast is past it."],
  ["ceiling", "the tokens a human funded a grant for. The grant runs to it and holds there, never before."],
  ["size", "a step's price class: S, M or L, priced by the collective's table. A step bigger than L is split."],
  ["verified", "a key result a human saw live, or one whose check the server ran and passed."],
  ["claimed", "a key result a fork's report or the manager says is done. Nobody has checked it yet."],
  ["unknown", "a key result with no evidence either way."],
  ["fund / counter / reject", "a human's three answers to a grant proposal."],
  ["adjust / cut", "a human's two answers at a gate: change the ceiling, or end the grant here."],
  ["hold", "a grant at its ceiling: new sessions on it wait for a human."],
  ["slate", "the Secretary's ranked set of money asks: fund these, hold these, skip these, and why."],
  ["ledger", "the policy ledger: one rule per line with its origin, pinned in every manager's prompt."],
];

/** The words the town does not use, each with the one it uses instead. */
const SEED_AVOID: readonly DictionaryPair[] = [
  { avoid: "top-up", use: "adjust" },
  { avoid: "checkpoint card", use: "gate" },
  { avoid: "approve a grant", use: "fund" },
  { avoid: "approve the grant", use: "fund" },
  { avoid: "kill the grant", use: "cut" },
  { avoid: "decision card", use: "ask" },
];

const SEED_BODY = [
  "# Town dictionary",
  "",
  "One meaning per word. Every manager's prompt pins these words, and an ask card using an avoided word is filed with a warning naming its replacement. Edit a line here to change a meaning; the linter reads the Avoid → use list as it stands.",
  "",
  "## Words",
  "",
  ...SEED_ENTRIES.map(([w, m]) => `- **${w}**: ${m}`),
  "",
  AVOID_HEADING,
  "",
  ...SEED_AVOID.map((p) => `- ${p.avoid} → ${p.use}`),
  "",
].join("\n");

function dictionaryDoc(world: World): Doc | undefined {
  return world.docs.first("type = 'dictionary' AND buildingId = ?", [TOWN_HALL_ID], "ORDER BY createdAt, rowid");
}

/** The dictionary, created once (server boot): a Town Hall doc of type `dictionary`, seeded. Null before the Town Hall exists. */
export function ensureDictionary(world: World): Doc | null {
  const have = dictionaryDoc(world);
  if (have) return have;
  const th = world.buildings.get(TOWN_HALL_ID);
  if (!th) return null;
  const by = world.reorgs.planner();
  return createDoc(world, {
    type: "dictionary", state: "building", buildingId: th.id, title: "Town dictionary", tags: ["dictionary"],
    authorId: by?.id ?? th.createdBy ?? "system", authorKind: by ? "agent" : "user", body: SEED_BODY,
  }, "The town dictionary opened in the Town Hall");
}

/** A dictionary body's words (the `- **word**` lines of "## Words"). */
function wordsOf(body: string): string[] {
  return [...body.matchAll(/^\s*-\s*\*\*([^*]+)\*\*\s*:/gm)].map((m) => m[1]!.trim());
}

/** A dictionary body's "avoid → use" pairs (the `- a → b` lines under "## Avoid → use"; `->` works too). */
function pairsOf(body: string): DictionaryPair[] {
  const at = body.indexOf(AVOID_HEADING);
  if (at < 0) return [];
  const rest = body.slice(at + AVOID_HEADING.length);
  const end = rest.search(/^## /m);
  return (end < 0 ? rest : rest.slice(0, end)).split("\n").flatMap((l) => {
    const m = /^\s*-\s*(.+?)\s*(?:→|->)\s*(.+?)\s*$/.exec(l);
    return m ? [{ avoid: m[1]!.replace(/\*\*|`/g, ""), use: m[2]!.replace(/\*\*|`/g, "") }] : [];
  });
}

/** The pairs the ask linter reads at vet time: the Town Hall dictionary's, or none before it exists. */
export function dictionaryPairs(world: World): DictionaryPair[] {
  const d = dictionaryDoc(world);
  return d ? pairsOf(d.body) : [];
}

/**
 * The block pinned in every manager's first message: the dictionary's words and its avoid → use pairs, under 120 words
 * (the meanings are a `read` away). "" before the dictionary exists.
 */
export function dictionaryBlock(world: World): string {
  const d = dictionaryDoc(world);
  if (!d) return "";
  const words = wordsOf(d.body);
  const pairs = pairsOf(d.body).slice(0, 8);
  return `## Town dictionary (${d.id}: \`read\` it for the meanings)\nOne meaning per word. Use these words as the dictionary defines them: ${words.join(", ")}.${pairs.length ? ` Avoid → use: ${pairs.map((p) => `${p.avoid} → ${p.use}`).join(", ")}. Write the word to use, never the avoided one.` : ""}`;
}
