/**
 * The Secretary's ranking run (docs/legible-delegation.md §6, build step 5): `rank` reads the open asks, sets each one's
 * rank, defers an ask that is moot behind another, and files the money slate as a notice. It never decides, funds or
 * approves anything; the review deck reads the asks in its order and opens on today's slate.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, requestCaptain, reviewDeck, townRoleId } from "../src/index.ts";
import { rankedAsks } from "../src/asks.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const sec = world.secretary.ensure()!;
  const proposal = (objective: string, askTokens = 300_000) => world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective, approach: "a banner line", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens,
  }).id);
  const askOn = (id: string) => world.asks.first("targetId = ? AND status IN ('open', 'deferred')", [id])!;
  return { ...s, world, manager, sec, proposal, askOn };
}

describe("the Secretary's ranking run", () => {
  it("rank reads the open asks; with order and slate it sets the ranks and files the slate as a notice citing ask ids", async () => {
    const { world, sec, proposal, askOn } = setup();
    const a = proposal("A banner with today's spend"), b = proposal("A second banner"), c = proposal("A third banner");
    const [ka, kb, kc] = [askOn(a.id), askOn(b.id), askOn(c.id)];
    const read = await world.verbs.rank(sec, {});
    expect(read).toMatchObject({ inputs: expect.stringContaining(`${ka.id} · money · `) });
    const out = await world.verbs.rank(sec, {
      order: [kc.id, ka.id, kb.id],
      slate: { fund: [{ askId: kc.id, why: "it unblocks the lab" }], hold: [{ askId: ka.id, until: "the third banner ships", why: "it builds on it" }], skip: [{ askId: kb.id, why: "it overlaps the third banner" }] },
    }) as { ranked: number; slateId: string };
    expect(out.ranked).toBe(3);
    expect([kc, ka, kb].map((k) => world.asks.require(k.id).rank)).toEqual([1, 2, 3]);
    expect(rankedAsks(world).slice(0, 3).map((k) => k.id)).toEqual([kc.id, ka.id, kb.id]);
    const slate = world.notices.require(out.slateId, "notice");
    expect(slate).toMatchObject({ kind: "slate", buildingId: "town-hall", refs: [kc.id, ka.id, kb.id] });
    expect(slate.title).toMatch(/^Money slate \d{4}-\d\d-\d\d: fund 1, hold 1, skip 1$/);
    expect(slate.body).toMatch(new RegExp(`\\*\\*Fund now\\*\\*\\n- Fund "A third banner" at 300,000 tokens \\(${kc.id}\\): it unblocks the lab`));
    expect(slate.body).toContain(`(${ka.id}) until the third banner ships: it builds on it`);
    expect(slate.body).toContain("nothing is funded until you decide each ask");
    expect(world.events.list({ types: ["ask.ranked"] }).at(-1)).toMatchObject({ payload: { ranked: 3, slateId: out.slateId } });
    // the deck opens on today's slate, then the town, then the asks in rank order (each on its grant's own slide)
    const deck = reviewDeck(world).slides;
    expect(deck.slice(0, 5).map((s) => [s.kind, s.askId ?? null])).toEqual([["slate", null], ["town", null], ["proposal", kc.id], ["proposal", ka.id], ["proposal", kb.id]]);
    expect(deck[2]!.text).toMatch(/_Ask #1 \(money\): Fund "A third banner"/);
    // an ask left out of a new order loses its rank; a non-money ask or an unknown id is refused, nothing written
    await expect(world.verbs.rank(sec, { order: ["ak_nope"] })).rejects.toThrow(/not an open ask/);
    await expect(world.verbs.rank(sec, { order: [ka.id, ka.id] })).rejects.toThrow(/listed twice/);
    await world.verbs.rank(sec, { order: [kb.id] });
    expect([kb, kc].map((k) => world.asks.require(k.id).rank)).toEqual([1, null]);
  });

  it("defers an ask behind the one it is moot without; refuses a non-money ask on the slate and anyone but the Secretary", async () => {
    const { world, sec, manager, admin, proposal, askOn } = setup();
    const g = proposal("Continue the captain work");
    const { user: ana } = world.ops.createUser("Ana");
    world.permissions.grant({ kind: "user", id: ana.id }, townRoleId("member"));
    const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "A funder sees what every token bought" });
    const cr = requestCaptain(world, ana.id, goal.id, "I know this goal");
    const click = askOn(cr.id);
    const money = askOn(g.id);
    await expect(world.verbs.rank(sec, { slate: { fund: [{ askId: click.id, why: "x" }], hold: [], skip: [] } })).rejects.toThrow(/money asks only/);
    await expect(world.verbs.rank(manager, {})).rejects.toThrow(/Only the Town Hall's Secretary/);
    await world.verbs.rank(sec, { order: [click.id, money.id], defer: [{ askId: money.id, until: click.id }] });
    expect(world.asks.require(money.id)).toMatchObject({ status: "deferred", deferredUntil: click.id, rank: 2 });
    expect(world.asks.require(money.id).history.at(-1)).toMatchObject({ action: "defer", by: sec.id });
    // a deferred ask stays listed, and is still the human's to decide
    expect(rankedAsks(world).map((a) => a.id)).toContain(money.id);
    await expect(world.verbs.rank(sec, { defer: [{ askId: money.id, until: click.id }] })).rejects.toThrow(/not an open ask/);
    expect(world.grants.require(g.id).status).toBe("proposed");
  });

  it("never decides money: no grant changes, no ask is decided, the run prompt says so", async () => {
    const { world, sec, proposal, askOn } = setup();
    const g = proposal("A banner with today's spend");
    const k = askOn(g.id);
    const before = world.grants.require(g.id);
    await world.verbs.rank(sec, { order: [k.id], slate: { fund: [{ askId: k.id, why: "cheap and ready" }], hold: [], skip: [] } });
    expect(world.grants.require(g.id)).toMatchObject({ status: "proposed", grantTokens: before.grantTokens, history: before.history });
    expect(world.asks.require(k.id)).toMatchObject({ status: "open", decidedBy: null, decision: null });
    expect(world.asks.count("status = 'decided'")).toBe(0);
    const s = world.secretary.ensureRankSchedule()!;
    expect(s.description).toMatch(/You never fund, continue, cut, approve or decide anything yourself/);
    expect(s.description).toMatch(/It funds nothing\./);
  });
});
