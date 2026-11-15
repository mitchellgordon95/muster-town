import { askStructure, askWarnings, grantName, grantPricingOf, type Agent, type Grant } from "@muster-town/schema";
import { proposalTitle, refuseMissingStructure } from "../asks.ts";
import { renderNeed } from "../ask-verb.ts";
import { openNeedsOn, PROPOSAL_BRANCHES } from "../needs.ts";
import { dictionaryPairs } from "../dictionary.ts";
import { homeOf } from "../domain.ts";
import { counteredTokens } from "../grants.ts";
import { AppError, badRequest } from "../errors.ts";
import type { World } from "../world.ts";
import type { VerbIn } from "./types.ts";

/**
 * `propose_grant` (the manager, or a fork of it on the manager's behalf): create the draft and propose it in one call; it lands in the Town Hall in-tray. A
 * building can have several proposals open at once (1:1 mt_akz25kqo2q). With `grantId` the call answers a counter: it
 * rewrites that countered proposal with the given plan and re-proposes it under the same id (work queued on it stays
 * attached). Without one it is a new proposal. It is filed against a goal and carries its own key results
 * (docs/how-work-gets-done.md §4).
 */
export async function propose_grant(world: World, caller: Agent, input: VerbIn<"propose_grant">) {
  // a fork of the manager (an explorer, docs/how-work-gets-done.md §3) proposes for its building as its manager
  const me = world.permissions.managerOfFork(caller) ?? caller;
  const bid = homeOf(me);
  if (!bid) throw badRequest("You have no building to propose a grant for.");
  const { note, grantId, ask, ...fields } = input;
  let open: Grant | undefined;
  if (grantId) {
    open = world.grants.get(grantId);
    if (!open || open.buildingId !== bid) throw badRequest(`${grantId} is not a proposal of your building.`);
    if (open.status !== "countered") throw new AppError("conflict", `${grantId} is ${open.status}: only a countered proposal is re-proposed. Leave grantId out for a new proposal.`);
  }
  // the proposal writes a need (1:1 mt_t65exni4et decision 2); a card given here renders it at once, else the manager
  // renders it from the need. A card is refused only when it lacks structure (1:1 mt_ewxnhs90cq decision 5); the style
  // rules it breaks are filed as warnings in its history and named in the answer
  const card = ask ? { body: ask.body, recommendation: ask.recommendation, claims: ask.claims ?? [] } : null;
  const vetCard = card ? { ...card, branches: PROPOSAL_BRANCHES, targetKind: "grant", dictionary: dictionaryPairs(world) } : null;
  if (vetCard) refuseMissingStructure("proposal", askStructure("money", vetCard));
  const warnings = vetCard ? askWarnings("money", vetCard) : [];
  const g = world.transaction(() => {
    const proposed = open
      ? (world.grantDesk.update(me, open.id, { ...fields, note: "Revised after the counter" }), world.grantDesk.propose(me, open.id, note))
      : world.grantDesk.propose(me, world.grantDesk.create(me, bid, fields).id, note);
    const need = card ? openNeedsOn(world, "grant", proposed.id).at(-1) : undefined;
    if (card && need) renderNeed(world, need, { title: proposalTitle(proposed), ...card }, caller.id);
    return proposed;
  });
  const asg = caller.currentAssignmentId ? world.assignments.get(caller.currentAssignmentId) : undefined;
  if (asg?.reservationId) {
    world.events.append({ type: "exploration.proposed", agentId: caller.id, buildingId: bid, text: `${caller.name}'s exploration ended in a proposal: ${grantName(g)}`, payload: { reservationId: asg.reservationId, assignmentId: asg.id, grantId: g.id, keyResultId: g.keyResultId, askTokens: g.askTokens } });
  }
  const others = world.grants.count("buildingId = ? AND id != ? AND status IN ('proposed', 'countered')", [bid, g.id]);
  return {
    grantId: g.id, status: g.status, goalId: g.goalId, keyResults: g.keyResults.map((k) => ({ id: k.id, text: k.text, due: k.due })),
    // advisory only (docs/how-work-gets-done.md §4 "What a grant is likely to cost"): the ask is the sum of the steps' sizes
    estimate: g.estimate?.sentence ?? null,
    note: `${open ? `Re-proposed ${g.id} with this plan after the counter.` : `New proposal ${g.id}.`} A human funds, counters or rejects it from the Town Hall in-tray.${others ? ` Your building has ${others} other open proposal(s); each is decided on its own.` : ""}${warnings.length ? ` Its ask card is filed with ${warnings.length} style warning(s), kept in its history; next time: ${warnings.join("; ")}` : ""}`,
  };
}

/**
 * `close_grant` (the manager): close a funded grant as done before it is spent (town hall mt_6830h8x5qk, decision 3). The
 * open key results go to met (or met, unverified) with the note; the unspent rest returns to the Bank; `shipped` names
 * what a human can now see or do, one notice each (there is no rollup).
 */
export async function close_grant(world: World, me: Agent, input: VerbIn<"close_grant">) {
  const g = world.grantDesk.closeDone(me, input.grantId, { note: input.note, reportId: input.reportId ?? null, shipped: input.shipped });
  const unspentTokens = g.history.at(-1)?.tokens ?? 0;
  return {
    grantId: g.id, status: g.status, outcome: g.outcome, spentTokens: g.spentTokens, grantTokens: g.grantTokens, unspentTokens,
    keyResults: g.keyResults.map((k) => ({ id: k.id, status: k.status })), checkpointDocId: g.checkpointDocId,
    note: `Closed as done; ${unspentTokens.toLocaleString("en-US")} unspent tokens returned to the Bank. ${input.shipped?.length ? `${input.shipped.length} shipped notice${input.shipped.length === 1 ? "" : "s"} filed for the humans. ` : "You named nothing shipped: the humans see only the closed-loop notice. "}Its open key results are marked met (a human can flip one to missed from the grant).`,
  };
}

/**
 * `withdraw_grant` (the manager, or a fork of it on the manager's behalf; 1:1 mt_a6wb51enia): take back the building's own
 * proposed or countered grant with a note. It leaves the Town Hall in-tray and the deck; its key results archive.
 */
export async function withdraw_grant(world: World, caller: Agent, input: VerbIn<"withdraw_grant">) {
  const me = world.permissions.managerOfFork(caller) ?? caller;
  const bid = homeOf(me);
  const cur = world.grants.get(input.grantId);
  if (!cur || cur.buildingId !== bid) throw badRequest(`${input.grantId} is not a grant of your building.`);
  const g = world.grantDesk.withdraw(me, input.grantId, input.note);
  return {
    grantId: g.id, status: g.status, outcome: g.outcome, keyResults: g.keyResults.map((k) => ({ id: k.id, archived: !!k.archivedAt })),
    note: `Withdrawn: ${g.id} left the Town Hall in-tray and its key results are archived; your note is on the grant. To try a new plan, propose_grant fresh (no grantId).`,
  };
}

/** `propose_goal` (the manager or its fork): a change to the town goal tree for a human to accept or cut (docs/goals.md). */
export async function propose_goal(world: World, me: Agent, input: VerbIn<"propose_goal">) {
  const p = world.goalTree.propose(me, { ...input, sourceDocIds: input.sourceDocIds ?? [], buildingId: homeOf(me) ?? undefined });
  return { proposal: { id: p.id, action: p.action, status: p.status, outsideScope: p.outsideScope }, note: `Proposed ${p.id}. It is an entry on your building's thread, and its need follows: write its card with \`ask\` (targetId ${p.id}, type policy; the branches Accept / Edit and accept / Cut are fixed). A human with goals.edit there decides it; you hear back in your inbox.${p.outsideScope ? " It reaches outside your building's subtree, so it is flagged." : ""}` };
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
    note: "On the board now. Key results belong to grants: propose_grant with its own keyResults.",
  };
}
