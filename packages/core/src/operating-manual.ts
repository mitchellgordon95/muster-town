/**
 * The operating manual (Mitchell, 1:1 mt_t65exni4et, 2026-11-15: "operating manual lgtm"): the agent-facing page on how
 * the town works (jobs, sessions and threads, reports, needs and asks), written for an agent and owned by the Secretary.
 * It is a Town Hall doc tagged `operating-manual` (the first one: a later copy never takes its place). It is a town pin,
 * always on (design dc_8194l8soj4 §3, seeded by `Skills.seed` and migration 120): every session's "## Pinned pages"
 * carries its text in full, read live, so a Secretary rewrite shows at the next session. The code contract is
 * docs/architecture.md; this is not it.
 */
import type { Doc } from "@muster-town/schema";
import { TOWN_HALL_ID } from "./world/layout.ts";
import type { World } from "./world.ts";

export const OPERATING_MANUAL_TAG = "operating-manual";

/** The manual: the first published Town Hall doc tagged `operating-manual`, or undefined before anyone wrote one. */
export function operatingManualDoc(world: World): Doc | undefined {
  return world.docs.first("buildingId = ? AND state IN ('building','library') AND tags LIKE ?", [TOWN_HALL_ID, `%"${OPERATING_MANUAL_TAG}"%`], "ORDER BY createdAt, rowid");
}
