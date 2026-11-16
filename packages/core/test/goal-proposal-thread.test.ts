/**
 * Goal proposals join the thread model (Mitchell, 1:1 mt_dwsxo7oms8 decision 4): `propose_goal` writes the proposal as
 * an entry on the proposer's thread and the town files its need right after it (kind goal, a policy ask with Accept /
 * Edit and accept / Cut). The manager writes the card; nothing writes it by code. The human's decision answers the need
 * on the thread and edits the tree; no open proposal is a raw row anywhere in the queue.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createBuilding, jobThread, townHallIntray } from "../src/index.ts";
import { backfillAsks, decideAsk } from "../src/asks.ts";
import { openNeedsOn, unrenderedNeeds } from "../src/needs.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const CARD = {
  type: "policy" as const, title: "Accept the new words of the lab goal",
  body: "Change: the lab goal reads \"A funder sees every token\".\nYou have not decided on it before.\nReversing it means one more edit.",
  branches: [{ label: "Accept" }, { label: "Cut" }], recommendation: "Accept: it says what the lab does now.",
};

function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
  world.goalTree.attach(admin, LAB, goal.id);
  return { ...s, mei, goal };
}

describe("goal proposals on the thread (1:1 mt_dwsxo7oms8 decision 4)", () => {
  it("propose_goal writes the proposal entry, then a need by code; no card is written and nothing is a raw queue row", async () => {
    const { world, mei, goal } = setup();
    const { proposal: p } = await world.verbs.propose_goal(mei, { action: "edit", targetId: goal.id, text: "A funder sees every token", why: "shorter" });
    const thread = jobThread(world, LAB)!;
    expect(thread.job.id).toBe(`jb_${LAB}`);
    const entry = thread.entries.find((e) => e.id === `en_${p.id}`)!;
    expect(entry).toMatchObject({ level: "none", authorKind: "manager", authorId: mei.id, moved: { kind: "goal-proposal", proposalId: p.id, action: "edit", targetId: goal.id, why: "shorter", fields: { text: "A funder sees every token" } } });
    const need = thread.entries.find((e) => e.id === `en_${p.id}_need`)!;
    expect(need.seq).toBe(entry.seq + 1);
    expect(need).toMatchObject({ level: "human", authorKind: "code", moved: { kind: "need", need: "goal", targetKind: "goalProposal", targetId: p.id, type: "policy" } });
    expect(need.note).toBe(`Needs a human's decision on the goal "A funder sees what every token bought" (${p.id})`);
    expect((need.moved.branches as { label: string; action: string }[]).map((b) => b.action)).toEqual(["accept", "edit", "cut"]);
    // the manager's to render; no ask, no raw row
    expect(unrenderedNeeds(world, LAB).map((n) => n.entry.id)).toEqual([need.id]);
    expect(world.asks.count("targetId = ?", [p.id])).toBe(0);
    expect(townHallIntray(world)).not.toHaveProperty("goalProposals");
  });

  it("the manager renders the ask on the proposal; a second ask on the need is refused at the door", async () => {
    const { world, mei, goal } = setup();
    const { proposal: p } = await world.verbs.propose_goal(mei, { action: "edit", targetId: goal.id, text: "A funder sees every token", why: "shorter" });
    const r = await world.verbs.ask(mei, { ...CARD, targetId: p.id });
    expect(r).toMatchObject({ entryId: `en_${p.id}_need`, folded: false });
    const a = world.asks.require(r.askId);
    // the need's type and branches, the manager's words
    expect(a).toMatchObject({ type: "policy", targetKind: "goalProposal", targetId: p.id, sourceEntryId: `en_${p.id}_need`, title: CARD.title });
    expect(a.branches.map((b) => b.label)).toEqual(["Accept", "Edit and accept", "Cut"]);
    expect(unrenderedNeeds(world, LAB)).toEqual([]);
    await expect(world.verbs.ask(mei, { ...CARD, title: "Accept it again", targetId: p.id })).rejects.toThrow(new RegExp(`live card, ask ${a.id}`));
    expect(world.asks.count("targetId = ?", [p.id])).toBe(1);
    // a policy card on a goal proposal states the change; a card with no rule and no change is refused
    const { proposal: q } = await world.verbs.propose_goal(mei, { action: "add-goal", parentId: goal.id, text: "Grant pages show sessions", why: "funders" });
    await expect(world.verbs.ask(mei, { ...CARD, body: "Please press it.\nYou have not decided on it before.", targetId: q.id })).rejects.toThrow(/rule/);
  });

  it("Edit and accept: the human's decision edits the tree, answers the need on the thread with the card they saw and retires the ask", async () => {
    const { world, mei, admin, goal } = setup();
    const { proposal: p } = await world.verbs.propose_goal(mei, { action: "edit", targetId: goal.id, text: "A funder sees every token", why: "shorter" });
    const { askId } = await world.verbs.ask(mei, { ...CARD, targetId: p.id });
    // the ask's own decide is refused: the proposal's verb decides it
    expect(() => decideAsk(world, admin, askId, "Accept")).toThrow(/goal-proposals/);
    const v = world.goalTree.decideProposal(admin, p.id, { action: "accept", text: "Every token is on the record", note: "my words" });
    expect(v.status).toBe("accepted");
    expect(world.goalTree.get(goal.id)!.text).toBe("Every token is on the record");
    expect(world.asks.require(askId).status).toBe("retired");
    expect(openNeedsOn(world, "goalProposal", p.id)).toEqual([]);
    const answer = jobThread(world, LAB)!.entries.find((e) => e.answers === `en_${p.id}_need`)!;
    expect(answer.authorKind).toBe("human");
    expect(answer.note).toMatch(/^Edit and accept: goal proposal .* accepted\. my words/);
    expect(answer.moved).toMatchObject({ card: { askId, title: CARD.title } });
    // the proposer's inbox line stays
    expect(world.messages.where("toId = ?", [mei.id]).some((m) => m.body.includes(`Your goal proposal ${p.id}`))).toBe(true);
  });

  it("a newer proposal on the same target supersedes the older: its need is settled and its ask retired", async () => {
    const { world, mei, goal } = setup();
    const { proposal: p1 } = await world.verbs.propose_goal(mei, { action: "edit", targetId: goal.id, text: "One", why: "a" });
    const { askId } = await world.verbs.ask(mei, { ...CARD, targetId: p1.id });
    const { proposal: p2 } = await world.verbs.propose_goal(mei, { action: "edit", targetId: goal.id, text: "Two", why: "b" });
    expect(world.goalProposals.require(p1.id).status).toBe("superseded");
    expect(world.asks.require(askId).status).toBe("retired");
    expect(openNeedsOn(world, "goalProposal", p1.id)).toEqual([]);
    expect(unrenderedNeeds(world, LAB).map((n) => n.targetId)).toEqual([p2.id]);
  });

  it("a human's proposal (no building) goes on the Town Hall's thread", async () => {
    const { world, admin, goal } = setup();
    const p = world.goalTree.propose(admin, { action: "add-goal", parentId: goal.id, text: "Sessions are legible", why: "mine" });
    expect(jobThread(world, "town-hall")!.entries.find((e) => e.id === `en_${p.id}_need`)).toMatchObject({ moved: { need: "goal", targetId: p.id } });
  });

  it("boot repair: an open proposal filed before the thread model gets its entry and need once", () => {
    const { world, mei, goal } = setup();
    const other = createBuilding(world, { name: "Other" }, null);
    const at = new Date().toISOString();
    for (const [id, b] of [["gp_old1", LAB], ["gp_old2", other.id]] as const) {
      world.goalProposals.upsert({ id, action: "edit", targetId: goal.id, parentId: null, fields: { text: "48 h" }, why: "Nov 10", proposedBy: mei.id, buildingId: b, reorgId: null, sourceDocIds: [], status: "open", decidedBy: null, decidedAt: null, note: "", resultId: null, createdAt: at });
    }
    backfillAsks(world);
    expect(openNeedsOn(world, "goalProposal", "gp_old1")[0]).toMatchObject({ buildingId: LAB, need: "goal" });
    expect(openNeedsOn(world, "goalProposal", "gp_old2")[0]).toMatchObject({ buildingId: other.id });
    const entries = world.db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number };
    backfillAsks(world);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM entries").get()).toEqual(entries);
  });
});
