import type { Agent, Grant } from "@muster-town/schema";
import { homeOf } from "../domain.ts";
import { AppError, badRequest } from "../errors.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/**
 * `propose_grant` (the manager): create the draft and propose it in one call; it lands in the Town Hall in-tray. A
 * building can have several proposals open at once (1:1 mt_akz25kqo2q). With `grantId` the call answers a counter: it
 * rewrites that countered proposal with the given plan and re-proposes it under the same id (work queued on it stays
 * attached). Without one, a countered proposal for the same key result is taken as the one being answered (the old
 * one-proposal habit); otherwise it is a new proposal.
 */
export async function propose_grant(world: World, me: Agent, input: VerbIn<"propose_grant">) {
  const bid = homeOf(me);
  if (!bid) throw badRequest("You have no building to propose a grant for.");
  const { note, grantId, ...fields } = input;
  let open: Grant | undefined;
  if (grantId) {
    open = world.grants.get(grantId);
    if (!open || open.buildingId !== bid) throw badRequest(`${grantId} is not a proposal of your building.`);
    if (open.status !== "countered") throw new AppError("conflict", `${grantId} is ${open.status}: only a countered proposal is re-proposed. Leave grantId out for a new proposal.`);
  } else {
    open = world.grants.first("buildingId = ? AND status = 'countered' AND keyResultId = ?", [bid, fields.keyResultId], "ORDER BY updatedAt DESC");
  }
  const g = world.transaction(() => {
    if (open) {
      world.grantDesk.update(me, open.id, { ...fields, note: "Revised after the counter" });
      return world.grantDesk.propose(me, open.id, note);
    }
    const draft = world.grantDesk.create(me, bid, fields);
    return world.grantDesk.propose(me, draft.id, note);
  });
  const others = world.grants.count("buildingId = ? AND id != ? AND status IN ('proposed', 'countered')", [bid, g.id]);
  return {
    grantId: g.id, status: g.status, keyResult: g.keyResult && { id: g.keyResult.id, text: g.keyResult.text }, testingPlan: g.testingPlan,
    note: `${open ? `Re-proposed ${g.id} with this plan after the counter.` : `New proposal ${g.id}.`} A human funds, counters or rejects it from the Town Hall in-tray.${others ? ` Your building has ${others} other open proposal(s); each is decided on its own.` : ""}`,
  };
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
  const words = { text: input.text, howToCheck: input.howToCheck, sourceDocIds: input.sourceDocIds, objectiveId: input.objectiveId };
  let kr;
  if (input.id) {
    const cur = world.keyResults.get(input.id);
    if (!cur || cur.buildingId !== bid) throw badRequest(`${input.id} is not a key result of ${world.buildings.get(bid)?.name ?? bid}'s goal.`);
    kr = world.grantDesk.updateKeyResult(me, input.id, words);
  } else {
    if (!input.text || !input.howToCheck) throw badRequest("A new key result needs text and howToCheck.");
    if (!input.sourceDocIds?.length && me.kind !== "human") throw badRequest("Name the meeting notes or report it comes from in sourceDocIds.");
    kr = world.grantDesk.createKeyResult(me, bid, { text: input.text, howToCheck: input.howToCheck, sourceDocIds: input.sourceDocIds ?? [], objectiveId: input.objectiveId ?? null });
  }
  return {
    keyResult: { id: kr.id, text: kr.text, howToCheck: kr.howToCheck, status: kr.status, sourceDocIds: kr.sourceDocIds, objectiveId: kr.objectiveId },
    note: "On the building board now. Your next rollup lists it (appended for you) so a human can keep or cut it; propose_grant can name it.",
  };
}

/**
 * `set_objective` (the manager): add an objective to its own building's goal (at most 3), or edit one (`id`), on the
 * same path as POST /api/buildings/:id/objectives. A new one names the KPI it moves and the notes or report it comes from.
 */
export async function set_objective(world: World, me: Agent, input: VerbIn<"set_objective">) {
  const bid = input.buildingId ?? homeOf(me);
  if (!bid) throw badRequest("You have no building; give buildingId.");
  let o;
  if (input.id) {
    const cur = world.objectives.get(input.id);
    if (!cur || cur.buildingId !== bid) throw badRequest(`${input.id} is not an objective of ${world.buildings.get(bid)?.name ?? bid}'s goal.`);
    o = world.grantDesk.updateObjective(me, input.id, { text: input.text, kpi: input.kpi, horizon: input.horizon, sourceDocIds: input.sourceDocIds });
  } else {
    if (!input.text || !input.kpi) throw badRequest("A new objective needs text and kpi (fund, join or trust).");
    if (!input.sourceDocIds?.length && me.kind !== "human") throw badRequest("Name the meeting notes or report it comes from in sourceDocIds.");
    o = world.grantDesk.createObjective(me, bid, { text: input.text, kpi: input.kpi, horizon: input.horizon, sourceDocIds: input.sourceDocIds ?? [] });
  }
  const tree = world.grantDesk.objectiveTree(bid);
  return {
    objective: tree.objectives.find((x) => x.id === o.id) ?? o,
    unsorted: tree.unsorted.map((k) => k.id),
    note: "On the board now. Put key results under it with set_key_result (objectiveId; at most 4 each).",
  };
}
