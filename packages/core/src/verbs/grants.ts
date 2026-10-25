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
