/**
 * Notices (docs/legible-delegation.md §8, build step 5): a state change with nothing to do. Each writer files its notice:
 * a grant's close (one `shipped` per item its manager names, then its `closed-loop`), a key result a
 * human verified (`verified`), the Secretary's slate and weekly pattern; `listNotices` (GET /api/notices) filters them.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { goalProduced } from "../src/goal-produced.ts";
import { worldGoalSpend } from "../src/goal-spend.ts";
import { fileNotice, listNotices } from "../src/notices.ts";
import { creditBank, fundBuilding, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const SHIPPED = [
  { title: "A spend banner", whatYoudSee: "Map → Bank shows today's spend.", picture: "mf_abc123" },
  { title: "A quieter board", whatYoudSee: "The board shows five cards." },
];

async function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  creditBank(world, 10_000_000);
  const mei = by("Mei");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const grant = () => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, {
    keyResults: [{ text: "The banner shows today's spend", howToCheck: "Open Map → Bank" }], objective: "A spend banner", approach: "a line", steps: [{ size: "M", title: "Step 1", description: "Do it" }], stopCondition: "s", askTokens: 600_000,
  }).id);
  return { ...s, world, mei, sec, grant };
}

describe("notices", () => {
  it("a funded grant closed as done files its closed loop (funded on, for, closed at, what it bought): the shipped items its manager names at the close, or a line saying it named none", async () => {
    const { world, admin, mei, grant } = await setup();
    const g = grant();
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 600_000 });
    world.grantDesk.closeDone(mei, g.id, { note: "the banner is live", shipped: SHIPPED });
    // what it bought is the close's shipped items, each a notice on the grant (its What you'd see line and picture)
    const shipped = listNotices(world, { kind: "shipped" });
    expect(shipped.map((n) => [n.title, n.body, n.picture, n.refs])).toEqual([
      ["A quieter board", "The board shows five cards.", null, [g.id]],
      ["A spend banner", "Map → Bank shows today's spend.", "mf_abc123", [g.id]],
    ]);
    expect(shipped[0]).toMatchObject({ buildingId: LAB, goalId: world.buildings.require(LAB).goalId });
    const loops = listNotices(world, { kind: "closed-loop" });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ title: "A spend banner", buildingId: LAB, picture: "mf_abc123", refs: [g.id] });
    expect(loops[0]!.body).toMatch(/^You funded this on \d{4}-\d\d-\d\d for 600,000 tokens\. It closed \d{4}-\d\d-\d\d at 0\. Here is what it bought:\n\n- A spend banner: Map → Bank shows today's spend\.\n- A quieter board: The board shows five cards\.$/);
    // a close that names nothing shipped says so, and points at the grant's thread
    const bare = grant();
    world.grantDesk.decide(admin, bare.id, { action: "fund", tokens: 600_000 });
    world.grantDesk.closeDone(mei, bare.id, { note: "done" });
    const loop = listNotices(world, { kind: "closed-loop" }).find((n) => n.refs.includes(bare.id))!;
    expect(loop).toMatchObject({ picture: null, refs: [bare.id] });
    expect(loop.body).toMatch(/^You funded this on \d{4}-\d\d-\d\d for 600,000 tokens\. It closed \d{4}-\d\d-\d\d at 0\. Here is what it bought:\n\nIts manager named nothing shipped at the close; its thread \(the grant page\) has each step's report\.$/);
    expect(listNotices(world, { kind: "shipped" })).toHaveLength(2);
    expect(listNotices(world, { kind: "closed-loop" })).toHaveLength(2);
    // closing marks its key results met: that is no human verification
    expect(listNotices(world, { kind: "verified" })).toHaveLength(0);
  });

  it("a key result a human marks met files a verified notice; the Secretary's pattern note is a notice (its slate: secretary-rank.test.ts); the list filters by building, goal, kind and limit, newest first", async () => {
    const { world, admin, mei, sec, grant } = await setup();
    const g = grant();
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 600_000 });
    const kr = world.grantDesk.keyResultsOf(g.id)[0]!;
    world.grantDesk.updateKeyResult(mei, kr.id, { status: "claimed", note: "live" });
    expect(listNotices(world, { kind: "verified" })).toHaveLength(0); // a manager's claim verifies nothing
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "met", note: "checked it live" });
    const [v] = listNotices(world, { kind: "verified" });
    expect(v).toMatchObject({ title: "The banner shows today's spend", refs: [kr.id, g.id], buildingId: LAB });
    expect(v!.body).toMatch(/verified it met: checked it live\n\nHow to check: Open Map → Bank$/);
    const pattern = await world.verbs.rank(sec, { pattern: { title: "Two buildings hit the same permission", body: `Both ${g.id} and ${kr.id} stalled on it.`, rule: "Forks ask for a scoped token before starting", ruleCard: { title: "Ask for a scoped token first", body: "Two buildings stalled on the same permission.\nThe rule answers it before it is asked.\nReversing it means deleting the line.", recommendation: "Add it: it stalled two buildings." } } }) as { noticeId: string; askId: string };
    expect(world.notices.require(pattern.noticeId, "notice")).toMatchObject({ kind: "pattern", refs: [g.id, kr.id] });
    expect(world.asks.require(pattern.askId)).toMatchObject({ type: "policy", targetId: `ledger:${pattern.noticeId}` });
    expect(listNotices(world)[0]!.id).toBe(pattern.noticeId);
    expect(listNotices(world, { building: LAB }).every((n) => n.buildingId === LAB)).toBe(true);
    expect(listNotices(world, { goal: v!.goalId! }).map((n) => n.id)).toContain(v!.id);
    expect(listNotices(world, { limit: 1 })).toHaveLength(1);
    expect(() => listNotices(world, { kind: "nope" })).toThrow(/kind: one of shipped, closed-loop, verified, slate, pattern, gate/);
  });
});

describe("a goal's subtree (gr_6kangldj4t step 1)", () => {
  it("the goal filter keeps the notices of the goal and every goal below it; the root also keeps those filed on no goal", async () => {
    const { world } = await setup();
    const mid = fundBuilding(world, LAB, {});
    const leaf = world.goalTree.create(null, { parentId: mid, text: "A leaf under the lab" }).id;
    const other = world.goalTree.create(null, { parentId: "gl_town", text: "A sibling" }).id;
    const at = (goalId: string | null, title: string) => fileNotice(world, { kind: "shipped", buildingId: LAB, goalId, title, body: "", picture: null, refs: [] }).id;
    const onMid = at(mid, "mid"), onLeaf = at(leaf, "leaf"), onOther = at(other, "other"), onNone = at(null, "none");
    expect(listNotices(world, { goal: mid }).map((n) => n.id).sort()).toEqual([onMid, onLeaf].sort());
    expect(listNotices(world, { goal: leaf }).map((n) => n.id)).toEqual([onLeaf]);
    expect(listNotices(world, { goal: "gl_town" }).map((n) => n.id).sort()).toEqual([onMid, onLeaf, onOther, onNone].sort());
    expect(listNotices(world, { goal: "gl_nope" })).toEqual([]);
  });

  it("goalProduced counts the subtree's shipped items, closed grants, key results met and tokens over the window", async () => {
    const { world, admin, mei, grant } = await setup();
    const mid = fundBuilding(world, LAB, {});
    const other = world.goalTree.create(null, { parentId: "gl_town", text: "A sibling" }).id;
    const g = grant();
    expect(world.grants.require(g.id).goalId).toBe(mid);
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 600_000 });
    world.grantDesk.closeDone(mei, g.id, { note: "the banner is live", shipped: SHIPPED });
    const p = goalProduced(world, mid, 30);
    expect(p.counts).toMatchObject({ shipped: 2, grantsClosed: 1, keyResultsMet: 1, keyResultsUnverified: 1, keyResultsMissed: 0 });
    expect(p.counts.tokens).toBe(worldGoalSpend(world, mid, 30).total);
    expect(p.shipped.map((n) => n.title)).toEqual(["A quieter board", "A spend banner"]);
    expect(p.grants).toEqual([expect.objectContaining({ id: g.id, title: "A spend banner", outcome: "done", grantTokens: 600_000, spentTokens: 0 })]);
    expect(p.keyResults.map((k) => k.status)).toEqual(["met-unverified"]);
    // the root sees it too; a sibling goal and a window that ends before it do not; the list is capped, the count is not
    expect(goalProduced(world, "gl_town", 30).counts).toMatchObject({ shipped: 2, grantsClosed: 1, keyResultsMet: 1 });
    expect(goalProduced(world, other, 30).counts).toMatchObject({ shipped: 0, grantsClosed: 0, keyResultsMet: 0, tokens: 0 });
    expect(goalProduced(world, mid, 30, new Date(Date.now() - 86_400_000)).counts).toMatchObject({ shipped: 0, grantsClosed: 0 });
    const capped = goalProduced(world, mid, 30, new Date(), 1);
    expect([capped.shipped.length, capped.counts.shipped]).toEqual([1, 2]);
    expect(() => goalProduced(world, "gl_nope")).toThrow();
  });
});
