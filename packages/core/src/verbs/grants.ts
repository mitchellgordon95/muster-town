import type { Agent } from "@muster-town/schema";
import { homeOf } from "../domain.ts";
import { AppError, badRequest } from "../errors.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/** `propose_grant` (the manager): create the draft and propose it in one call; it lands in the Town Hall in-tray. */
export async function propose_grant(world: World, me: Agent, input: VerbIn<"propose_grant">) {
  const bid = homeOf(me);
  if (!bid) throw badRequest("You have no building to propose a grant for.");
  const { note, ...fields } = input;
  const open = world.grants.first("buildingId = ? AND status IN ('proposed', 'countered')", [bid]);
  if (open) throw new AppError("conflict", `Your building already has an open proposal (${open.id}: ${open.objective}). Finish it first.`);
  const g = world.transaction(() => {
    const draft = world.grantDesk.create(me, bid, fields);
    return world.grantDesk.propose(me, draft.id, note);
  });
  return { grantId: g.id, status: g.status, keyResult: g.keyResult && { id: g.keyResult.id, text: g.keyResult.text }, testingPlan: g.testingPlan, note: "A human funds, counters or rejects it from the Town Hall in-tray." };
}

/** `checkpoint_grant` (the manager): the grant's key-result status up to claimed, and the checkpoint report link. */
export async function checkpoint_grant(world: World, me: Agent, input: VerbIn<"checkpoint_grant">) {
  const g = world.grantDesk.fileCheckpoint(me, input.grantId, { reportId: input.reportId ?? null, status: input.status ?? null, note: input.note });
  return {
    grantId: g.id, status: g.status, checkpointDocId: g.checkpointDocId, keyResult: g.keyResult && { id: g.keyResult.id, status: g.keyResult.status },
    note: g.checkpointDocId ? "Linked. A human continues, adjusts or cuts it from the Town Hall in-tray." : "Now submit_report with rollup: true: it links itself to this grant as the checkpoint report.",
  };
}

/**
 * `set_key_result` (the manager): add a key result to its own building's goal, or edit one (`id`), on the same path as
 * POST /api/buildings/:id/key-results. A new one names the meeting notes or report it comes from; the manager's next
 * rollup lists it so a human can cut it.
 */
export async function set_key_result(world: World, me: Agent, input: VerbIn<"set_key_result">) {
  const bid = input.buildingId ?? homeOf(me);
  if (!bid) throw badRequest("You have no building; give buildingId.");
  const words = { text: input.text, howToCheck: input.howToCheck, sourceDocIds: input.sourceDocIds };
  let kr;
  if (input.id) {
    const cur = world.keyResults.get(input.id);
    if (!cur || cur.buildingId !== bid) throw badRequest(`${input.id} is not a key result of ${world.buildings.get(bid)?.name ?? bid}'s goal.`);
    kr = world.grantDesk.updateKeyResult(me, input.id, words);
  } else {
    if (!input.text || !input.howToCheck) throw badRequest("A new key result needs text and howToCheck.");
    if (!input.sourceDocIds?.length && me.kind !== "human") throw badRequest("Name the meeting notes or report it comes from in sourceDocIds.");
    kr = world.grantDesk.createKeyResult(me, bid, { text: input.text, howToCheck: input.howToCheck, sourceDocIds: input.sourceDocIds ?? [] });
  }
  return {
    keyResult: { id: kr.id, text: kr.text, howToCheck: kr.howToCheck, status: kr.status, sourceDocIds: kr.sourceDocIds },
    note: "On the building board now. Your next rollup lists it (appended for you) so a human can keep or cut it; propose_grant can name it.",
  };
}
