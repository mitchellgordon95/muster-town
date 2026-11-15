/**
 * The operating manual (Mitchell, 1:1 mt_t65exni4et, 2026-11-15: "operating manual lgtm"): the agent-facing page on how
 * the town works (jobs, sessions and threads, reports, needs and asks), written for an agent and owned by the Secretary.
 * It is a Town Hall doc tagged `operating-manual` (the first one: a later copy never takes its place). Every session's
 * first message pins its text in full beside the policy ledger and the town dictionary (`operatingManualBlock`), read
 * live, so a Secretary rewrite shows at the next session. The code contract is docs/architecture.md; this is not it.
 */
import type { Agent, Doc } from "@muster-town/schema";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

const OPERATING_MANUAL_TAG = "operating-manual";
/** Past this many characters the block pins only the "Needs and asks" section in full and links the rest. */
export const MANUAL_PIN_CAP = 8_000;
const NEEDS_HEADING = "## Needs and asks";

/** The manual: the first published Town Hall doc tagged `operating-manual`, or undefined before anyone wrote one. */
export function operatingManualDoc(world: World): Doc | undefined {
  return world.docs.first("buildingId = ? AND state IN ('building','library') AND tags LIKE ?", [TOWN_HALL_ID, `%"${OPERATING_MANUAL_TAG}"%`], "ORDER BY createdAt, rowid");
}

/** One `## ` section of a markdown body (heading included), or "" when it has none. */
function sectionOf(body: string, heading: string): string {
  const at = body.indexOf(heading);
  if (at < 0) return "";
  const rest = body.slice(at + heading.length);
  const end = rest.search(/^## /m);
  return `${heading}${end < 0 ? rest : rest.slice(0, end)}`.trim();
}

/**
 * The block pinned in every session's first message (managers, forks, the Secretary and the Planner): the manual's text
 * in full, or, past MANUAL_PIN_CAP, its "Needs and asks" section in full and the rest a `read` away. The Secretary's
 * copy adds that the page is its own. "" before the manual exists.
 */
export function operatingManualBlock(world: World, reader?: Agent): string {
  const d = operatingManualDoc(world);
  if (!d) return "";
  const body = d.body.trim();
  const owner = reader && world.secretary.isSecretary(reader)
    ? `\nYou own this page: when a decision changes how the town works (a word like need or ask, a new rule for cards), rewrite it whole with \`write\` (id ${d.id}). Keep it under one screen, in plain short sentences, for an agent: what it does and sees, not where the code lives.`
    : "";
  const head = `## Operating manual (${d.id}, kept by the Secretary: how jobs, threads, reports, needs and asks work here)${owner}`;
  if (body.length <= MANUAL_PIN_CAP) return `${head}\n${body}`;
  const needs = sectionOf(body, NEEDS_HEADING);
  return `${head}\nThe page is long: its "Needs and asks" section is below; \`read\` ${d.id} for the rest.${needs ? `\n${needs}` : ""}`;
}
