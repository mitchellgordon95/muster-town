import { grantName, grantPricingOf, vetAsk, type Agent, type Grant } from "@muster-town/schema";
import { lastCounterAt, proposalCard, refuseOrFlag, setAskCard } from "../asks.ts";
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
/** A proposal's money ask's buttons (the same as `askForProposal` files). */
const PROPOSAL_BRANCHES = [{ label: "Fund" }, { label: "Counter" }, { label: "Reject" }];

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
  // legible delegation step 3: the money ask's card (the explorer's, else the town's from the plan) passes the money
  // contract and the linter, or the proposal is refused with the failing rules (the third failing attempt is filed, flagged)
  const card = ask
    ? { body: ask.body, recommendation: ask.recommendation, claims: ask.claims }
    : proposalCard({ askTokens: (open && counteredTokens(open)) || fields.steps.reduce((n, st) => n + grantPricingOf(world.town.get()).stepSizes[st.size], 0), steps: fields.steps.length, keyResults: fields.keyResults, counteredAt: open ? lastCounterAt(open) : null });
  refuseOrFlag(world, caller, "proposal", vetAsk("money", { ...card, branches: PROPOSAL_BRANCHES, targetKind: "grant", dictionary: dictionaryPairs(world) }));
  const g = world.transaction(() => {
    const proposed = open
      ? (world.grantDesk.update(me, open.id, { ...fields, note: "Revised after the counter" }), world.grantDesk.propose(me, open.id, note))
      : world.grantDesk.propose(me, world.grantDesk.create(me, bid, fields).id, note);
    if (ask) setAskCard(world, "grant", proposed.id, card, caller.id);
    return proposed;
  });
  const asg = caller.currentAssignmentId ? world.assignments.get(caller.currentAssignmentId) : undefined;
  if (asg?.reservationId) {
    world.events.append({ type: "exploration.proposed", agentId: caller.id, buildingId: bid, text: `${caller.name}'s exploration ended in a proposal: ${grantName(g)}`, payload: { reservationId: asg.reservationId, assignmentId: asg.id, grantId: g.id, keyResultId: g.keyResultId, askTokens: g.askTokens } });
  }
  const others = world.grants.count("buildingId = ? AND id != ? AND status IN ('proposed', 'countered')", [bid, g.id]);
  const flagged = world.asks.exists("targetKind = 'grant' AND targetId = ? AND status = 'open' AND tags LIKE '%\"lint-failed\"%'", [g.id]);
  return {
    grantId: g.id, status: g.status, goalId: g.goalId, keyResults: g.keyResults.map((k) => ({ id: k.id, text: k.text, due: k.due })),
    // advisory only (docs/how-work-gets-done.md §4 "What a grant is likely to cost"): the ask is the sum of the steps' sizes
    estimate: g.estimate?.sentence ?? null,
    note: `${open ? `Re-proposed ${g.id} with this plan after the counter.` : `New proposal ${g.id}.`} A human funds, counters or rejects it from the Town Hall in-tray.${others ? ` Your building has ${others} other open proposal(s); each is decided on its own.` : ""}${flagged ? " Its ask card still fails the linter after three tries: it is filed flagged lint-failed, so the humans see that it was not cleaned up." : ""}`,
  };
}

/**
 * `close_grant` (the manager): close a funded grant as done before it is spent (town hall mt_6830h8x5qk, decision 3). The
 * open key results go to claimed with the note; the unspent rest returns to the Bank; without reportId the manager's next
 * rollup this session links itself as the close report (`checkpointDocId`).
 */
export async function close_grant(world: World, me: Agent, input: VerbIn<"close_grant">) {
  const g = world.grantDesk.closeDone(me, input.grantId, { note: input.note, reportId: input.reportId ?? null });
  const unspentTokens = g.history.at(-1)?.tokens ?? 0;
  return {
    grantId: g.id, status: g.status, outcome: g.outcome, spentTokens: g.spentTokens, grantTokens: g.grantTokens, unspentTokens,
    keyResults: g.keyResults.map((k) => ({ id: k.id, status: k.status })), checkpointDocId: g.checkpointDocId,
    note: `Closed as done; ${unspentTokens.toLocaleString("en-US")} unspent tokens returned to the Bank. ${g.checkpointDocId ? "Linked. " : "Now submit_report with rollup: true: it links itself to this grant as the close report. "}Its open key results are marked met (a human can flip one to missed from the grant).`,
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
  return { proposal: { id: p.id, action: p.action, status: p.status, outsideScope: p.outsideScope }, note: `Proposed ${p.id}. A human with goals.edit there accepts or cuts it; you hear back in your inbox.${p.outsideScope ? " It reaches outside your building's subtree, so it is flagged." : ""}` };
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
