/**
 * Build step 7 of docs/legible-delegation.md (§7.3 point 4, §8): a step report's forecast is the gate. Past the ceiling it
 * is one money ask on the grant (Adjust / Cut, a card the town writes that passes the money contract); a later hold at
 * the ceiling folds into it; within the ceiling it is a `gate` notice and no ask.
 */
import { vetAsk } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, listNotices, newId, nowIso, openAsks, retireFork, updateBuilding } from "../src/index.ts";
import { fileForecast } from "../src/grant-forecast.ts";
import { createAsk } from "../src/asks.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const KR = { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" };
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
/** S 50k + M 150k + L 400k = a ceiling of 600k at the seeded table */
const STEPS = [
  { size: "S" as const, title: "Check the banner", description: "Open the lab as a guest" },
  { size: "M" as const, title: "Build the banner", description: "Ship the banner PR" },
  { size: "L" as const, title: "Build the board", description: "Ship the board PR" },
];

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Gated", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = () => world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", steps: STEPS, stopCondition: "s" }).id).id, { action: "fund" });
  /** a fork takes the building's first queued step, spends `tokens` on it (a booked session) and files its report */
  const runStep = async (tokens: number, verdict: "continue" | "pivot" | "stop" = "continue") => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    world.sessions.upsert({
      id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: a.grantId,
    } as never);
    const r = await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict, left: "The rest of the plan." });
    retireFork(world, fork.id);
    return { a, r };
  };
  const gateAsks = (grantId: string) => world.asks.where("targetKind = 'grant' AND targetId = ?", [grantId], "ORDER BY createdAt, rowid").filter((x) => x.branches.some((br) => br.action === "adjust"));
  return { ...s, b, pix, fund, runStep, gateAsks };
}

describe("an over-ceiling forecast is a money ask, an on-budget one a notice", () => {
  it("an over-ceiling forecast files one money ask with Adjust and Cut whose town-written card passes the money contract", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    const { r } = await runStep(300_000); // the M step at 2× its size: projected 740k against 600k
    const asks = gateAsks(g.id);
    expect(asks).toHaveLength(1);
    const ask = asks[0]!;
    expect(ask).toMatchObject({ type: "money", status: "open", targetKind: "grant", targetId: g.id, sourceDocId: r.id, tags: [] });
    expect(ask.branches).toEqual([{ label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }]);
    expect(ask.title).toBe('Adjust or cut "A banner": projected 140k past its ceiling');
    expect(ask.body).toContain("You funded this at 600,000 tokens on");
    expect(ask.body).toContain("It has spent 340,000 of its 600,000-token ceiling.");
    expect(ask.body).toContain("Two of 3 steps are done: one S, one M.");
    expect(ask.body).toContain("One step is left: one L.");
    expect(ask.body).toContain("That is 140,000 tokens past the ceiling.");
    expect(ask.body).toContain("If you adjust by 150,000: the ceiling becomes 750,000 tokens, and the work runs on.");
    expect(ask.body).toContain("If you cut:");
    // the shortfall rounded up to the next step size (140k → M 150k), by the building's manager
    expect(ask.recommendation).toBe("Pix recommends adjust by 150,000 tokens.");
    expect(ask.claims).toEqual([{ text: `The latest step report, "Report on Build the banner", says continue.`, check: { kind: "manual", ref: r.id } }]);
    expect(vetAsk("money", { body: ask.body, branches: ask.branches, recommendation: ask.recommendation, claims: ask.claims, targetKind: "grant" })).toEqual([]);
    expect(ask.history.some((h) => h.action === "lint")).toBe(false);
    // the ask is the particle: no gate notice for this step
    expect(listNotices(world, { kind: "gate" }).map((n) => n.title)).toEqual(["Step 1 of 3 landed: 40,000 of 600,000 spent, projected 590,000"]);
  });

  it("a step report with verdict stop recommends cut", async () => {
    const { fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000, "stop");
    expect(gateAsks(g.id)[0]!.recommendation).toBe("Pix recommends cut: the latest step report says stop.");
  });

  it("a later ceiling hold folds into the forecast's ask: one ask, its title says the grant is held, the card still passes", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000);
    await runStep(300_000); // the L step: 640k spent, past the 600k ceiling
    world.grantDesk.checkpoints(g.buildingId);
    expect(world.grants.require(g.id).status).toBe("checkpoint");
    const asks = gateAsks(g.id);
    expect(asks).toHaveLength(1);
    expect(asks[0]!.title).toBe('"A banner" is held at its ceiling: adjust or cut it');
    expect(asks[0]!.body).toContain("New sessions on it wait for you.");
    expect(asks[0]!.history.some((h) => h.action === "fold")).toBe(true);
    expect(asks[0]!.tags).toEqual([]);
    expect(openAsks(world).filter((a) => a.targetId === g.id)).toHaveLength(1);
  });

  it("a live Yes / No money ask on the grant (from rollup prose) becomes the gate: Adjust / Cut, its sources kept, the gate card appended", async () => {
    const { world, pix, fund, runStep, gateAsks } = lab();
    const g = fund();
    const rollup = await world.verbs.write(pix, { type: "fyi", title: "Rollup", body: "x", state: "draft" });
    const { ask: yn } = createAsk(world, { type: "money", targetKind: "grant", targetId: g.id, buildingId: g.buildingId, sourceDocId: rollup.id, by: pix.id, title: "Raise the banner grant?", line: "Raise the banner grant?", body: "From the rollup.", branches: [{ label: "Yes" }, { label: "No" }] });
    await runStep(40_000);
    await runStep(300_000); // over the ceiling: the gate folds into the Yes / No ask
    const live = openAsks(world).filter((a) => a.targetId === g.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.id).toBe(yn.id);
    expect(live[0]!.branches).toEqual([{ label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }]);
    expect(gateAsks(g.id).map((a) => a.id)).toEqual([yn.id]);
    expect(live[0]!.body.startsWith("From the rollup.\n\n")).toBe(true);
    expect(live[0]!.body).toContain("If you cut:");
    expect(live[0]!.title).toBe('Adjust or cut "A banner": projected 140k past its ceiling');
    expect(live[0]!.sources.map((s) => s.docId)).toContain(rollup.id);
    expect(live[0]!.sources.length).toBeGreaterThan(1);
  });

  it("an on-budget forecast files a gate notice and no ask", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    const { r } = await runStep(40_000);
    expect(gateAsks(g.id)).toHaveLength(0);
    const [n] = listNotices(world, { kind: "gate" });
    expect(n).toMatchObject({ kind: "gate", buildingId: g.buildingId, title: "Step 1 of 3 landed: 40,000 of 600,000 spent, projected 590,000", refs: [g.id, r.id] });
  });

  it("a later forecast back within the ceiling retires the running grant's gate ask", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000);
    await runStep(100_000); // the L step far under its size: 440k in all, within 600k
    expect(world.grants.require(g.id).status).toBe("funded");
    expect(gateAsks(g.id)[0]).toMatchObject({ status: "retired" });
    expect(gateAsks(g.id)[0]!.retiredBy).toContain("The forecast is back within the ceiling");
  });

  it("the ask retires when the human adjusts the running grant, and the forecast is measured against the new ceiling", async () => {
    const { world, admin, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000);
    world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 750_000 });
    expect(gateAsks(g.id)[0]).toMatchObject({ status: "retired" });
    expect(world.grantDesk.get(g.id)).toMatchObject({ status: "funded", grantTokens: 750_000, needsTopUp: false, forecast: { ceiling: 750_000, overCeiling: false, shortfall: 0 } });
  });

  it("Cut on a running grant stops it", async () => {
    const { world, admin, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000);
    world.grantDesk.decide(admin, g.id, { action: "cut" });
    expect(["stopping", "closed"]).toContain(world.grants.require(g.id).status);
    expect(gateAsks(g.id)[0]).toMatchObject({ status: "retired" });
  });

  it("a funded grant whose steps were planned before sizes files no forecast, no ask and no notice; an event says why", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    // as migration 098 leaves a grant funded before sizes: its steps carry no size
    world.grants.upsert({ ...world.grants.require(g.id), steps: STEPS.map(({ title, description }) => ({ title, description })) as never });
    await runStep(500_000);
    expect(fileForecast(world, g.id)).toBeNull();
    expect(world.grants.require(g.id)).toMatchObject({ forecast: null, needsTopUp: false });
    expect(gateAsks(g.id)).toHaveLength(0);
    expect(listNotices(world, { kind: "gate" })).toHaveLength(0);
    const ev = world.events.list({ types: ["grant.forecast"] });
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => (e.payload as { skipped?: string }).skipped === "unsized")).toBe(true);
    expect(ev[0]!.text).toContain("planned before step sizes");
  });

  it("a grant that is stopping or closed files no forecast", async () => {
    const { world, fund, runStep, gateAsks } = lab();
    const g = fund();
    await runStep(40_000);
    for (const status of ["stopping", "closed"] as const) {
      world.grants.upsert({ ...world.grants.require(g.id), status });
      expect(fileForecast(world, g.id)).toBeNull();
    }
    expect(gateAsks(g.id)).toHaveLength(0);
    expect(listNotices(world, { kind: "gate" })).toHaveLength(1); // step 1's, while it ran
  });
});

describe("the checkpoint ask's card", () => {
  it("a grant held with no forecast and no report files its card with warnings in its history, naming the fields it lacks", () => {
    const { world, fund, b, gateAsks } = lab();
    const g = fund();
    world.sessions.upsert({
      id: newId("se"), agentId: world.buildings.require(b.id).managerAgentId!, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 600_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
    } as never);
    world.grantDesk.checkpoints(g.buildingId);
    const ask = gateAsks(g.id)[0]!;
    expect(ask.title).toBe('"A banner" is held at its ceiling: adjust or cut it');
    expect(ask.tags).toEqual([]);
    const lint = ask.history.find((h) => h.action === "lint")!.note;
    expect(lint).toContain("structure recommendation");
    expect(lint).toContain("contract claims");
    expect(lint).not.toContain("contract spent");
    expect(lint).not.toContain("contract steps");
  });
});
