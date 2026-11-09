/**
 * Notices (docs/legible-delegation.md §8, build step 5): a state change with nothing to do. Each writer files its notice:
 * a rollup's submit (one `shipped` per Shipped item), a funded grant closed as done (`closed-loop`), a key result a
 * human verified (`verified`), the Secretary's slate and weekly pattern; `listNotices` (GET /api/notices) filters them.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { listNotices } from "../src/notices.ts";
import { settleRollup } from "../src/secretary.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const ITEMS = "**1. A spend banner**\n**What it is:** a banner.\n**What you'd see:** Map → Bank shows today's spend.\n![banner](/api/media/mf_abc123.png)\n**Your call:** None.\n\n**2. A quieter board**\n**What it is:** fewer cards.\n**What you'd see:** The board shows five cards.\n**Your call:** None.";
const body = (shipped: string, needs = "Nothing needed.") => `## Shipped\n${shipped}\n\n## Decided\n- none\n\n## Key results\n(none)\n\n## Needs from Mitchell\n${needs}`;

async function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  creditBank(world, 10_000_000);
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const r = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
  const roll = (title: string, b: string) => world.verbs.submit_report(mei, { title, body: b, verdict: "stop", rollup: true, provenance: { sourceIds: [r.id], urls: [] } });
  const grant = () => world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, {
    keyResults: [{ text: "The banner shows today's spend", howToCheck: "Open Map → Bank" }], objective: "A spend banner", approach: "a line", steps: [{ size: "M", title: "Step 1", description: "Do it" }], stopCondition: "s", askTokens: 600_000,
  }).id);
  return { ...s, world, mei, sec, roll, grant };
}

describe("notices", () => {
  it("a rollup's submit files one shipped notice per Shipped item (its What you'd see line and picture); one that asks nothing is archived", async () => {
    const { world, roll } = await setup();
    const up = await roll("Rollup: banner", body(ITEMS));
    const shipped = listNotices(world, { kind: "shipped" });
    expect(shipped.map((n) => [n.title, n.body, n.picture, n.refs])).toEqual([
      ["A quieter board", "The board shows five cards.", null, [up.id]],
      ["A spend banner", "Map → Bank shows today's spend.", "mf_abc123", [up.id]],
    ]);
    expect(shipped[0]).toMatchObject({ buildingId: LAB, goalId: world.buildings.require(LAB).goalId });
    // it asks nothing: archived on submit (the digest used to do this daily)
    expect(up.decision).toBe("approve");
    expect(world.docs.require(up.id)).toMatchObject({ decision: "approve", decidedBy: "system" });
    // a rollup that asks something in words stays pending; its items are notices all the same
    const asks = await roll("Rollup: question", body(ITEMS, "- Should visitors see the Bank before they sign in?"));
    expect(asks.decision).toBe("pending");
    expect(listNotices(world, { kind: "shipped" })).toHaveLength(4);
    // settling again files nothing twice
    settleRollup(world, world.docs.require(asks.id), []);
    expect(listNotices(world, { kind: "shipped" })).toHaveLength(4);
  });

  it("a funded grant closed as done files its closed loop (funded on, for, closed at, what it bought), rewritten once its close report lands", async () => {
    const { world, admin, mei, roll, grant } = await setup();
    const g = grant();
    world.grantDesk.decide(admin, g.id, { action: "fund", tokens: 600_000 });
    world.grantDesk.closeDone(mei, g.id, { note: "the banner is live" });
    const [loop] = listNotices(world, { kind: "closed-loop" });
    expect(loop).toMatchObject({ title: "A spend banner", buildingId: LAB, refs: [g.id] });
    expect(loop!.body).toMatch(/^You funded this on \d{4}-\d\d-\d\d for 600,000 tokens\. It closed \d{4}-\d\d-\d\d at 0\. Here is what it bought:\n\nIts close report isn't filed yet\.$/);
    // the close report links itself (submit_report in the same session); settling it rewrites the same notice
    const up = await roll("Rollup: closed the banner grant", body(ITEMS));
    world.grants.patch(g.id, { checkpointDocId: up.id });
    settleRollup(world, world.docs.require(up.id), [world.grants.require(g.id)]);
    const loops = listNotices(world, { kind: "closed-loop" });
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ id: loop!.id, picture: "mf_abc123", refs: [g.id, up.id] });
    expect(loops[0]!.body).toContain("Here is what it bought:\n\n- A spend banner: Map → Bank shows today's spend.\n- A quieter board: The board shows five cards.");
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
    const pattern = await world.verbs.rank(sec, { pattern: { title: "Two buildings hit the same permission", body: `Both ${g.id} and ${kr.id} stalled on it.`, rule: "Forks ask for a scoped token before starting" } }) as { noticeId: string; askId: string };
    expect(world.notices.require(pattern.noticeId, "notice")).toMatchObject({ kind: "pattern", refs: [g.id, kr.id] });
    expect(world.asks.require(pattern.askId)).toMatchObject({ type: "policy", targetId: `ledger:${pattern.noticeId}` });
    expect(listNotices(world)[0]!.id).toBe(pattern.noticeId);
    expect(listNotices(world, { building: LAB }).every((n) => n.buildingId === LAB)).toBe(true);
    expect(listNotices(world, { goal: v!.goalId! }).map((n) => n.id)).toContain(v!.id);
    expect(listNotices(world, { limit: 1 })).toHaveLength(1);
    expect(() => listNotices(world, { kind: "nope" })).toThrow(/kind: one of shipped, closed-loop, verified, slate, pattern, gate/);
  });
});
