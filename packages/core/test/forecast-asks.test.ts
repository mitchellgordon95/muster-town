/**
 * Build step 7 of docs/legible-delegation.md (§7.3 point 4, §8), as changed by 1:1 mt_vdu3iqhasi decision 2: a step
 * report's forecast is recorded and asks nothing; within the ceiling it is a `gate` notice. The hold at the ceiling is the
 * only gate: it writes the gate's need on the grant (its facts for the manager, who renders the Adjust / Cut ask).
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, jobThread, listNotices, newId, nowIso, openAsks, retireFork, updateBuilding } from "../src/index.ts";
import { fileForecast } from "../src/grant-forecast.ts";
import { openNeedsOn } from "../src/needs.ts";
import { needAtCheckpoint, retireForecastGates } from "../src/asks.ts";
import { creditBank, renderNeeds, seededWorld } from "./helpers.ts";

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
  const fund = (steps: typeof STEPS = STEPS) => world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "A banner", steps, stopCondition: "s" }).id).id, { action: "fund" });
  /** a fork takes the building's first queued step, spends `tokens` on it (a booked session) and files its report */
  const runStep = async (tokens: number, verdict: "continue" | "pivot" | "stop" = "continue", park?: { title: string }) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    world.sessions.upsert({
      id: newId("se"), agentId: fork.id, assignmentId: a.id, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: tokens, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: a.grantId,
    } as never);
    const r = park
      ? await world.verbs.submit_report(fork, { title: park.title, body: REPORT, verdict, resumeWhen: { after: new Date(Date.now() + 3_600_000).toISOString() }, next: "Merge the PR" })
      : await world.verbs.submit_report(fork, { title: `Report on ${a.title}`, body: REPORT, verdict, left: "The rest of the plan." });
    retireFork(world, fork.id);
    return { a, r };
  };
  const gateAsks = (grantId: string) => world.asks.where("targetKind = 'grant' AND targetId = ?", [grantId], "ORDER BY createdAt, rowid").filter((x) => x.branches.some((br) => br.action === "adjust"));
  /** every gate need ever written on the grant's thread, oldest first, with whether it is still open */
  const gateNeeds = (grantId: string) => {
    const open = new Set(openNeedsOn(world, "grant", grantId).map((n) => n.entry.id));
    return jobThread(world, grantId)!.entries.filter((e) => e.moved.kind === "need" && e.moved.need === "gate").map((e) => ({ ...e, open: open.has(e.id) }));
  };
  return { ...s, b, pix, fund, runStep, gateAsks, gateNeeds };
}

describe("a forecast asks nothing; the hold at the ceiling is the only gate (1:1 mt_vdu3iqhasi decision 2)", () => {
  it("an over-ceiling forecast writes no need and no ask; the forecast and its events are the record", async () => {
    const { world, fund, runStep, gateAsks, gateNeeds } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000); // the M step at 2× its size: projected 740k against 600k
    expect(gateAsks(g.id)).toHaveLength(0);
    expect(gateNeeds(g.id)).toHaveLength(0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "funded", needsTopUp: true, forecast: { spent: 340_000, ceiling: 600_000, projected: 740_000, overCeiling: true, shortfall: 140_000 } });
    const [up] = world.events.list({ types: ["grant.top-up-needed"] });
    expect(up!.payload).toMatchObject({ grantId: g.id, shortfallTokens: 140_000, projected: 740_000, ceiling: 600_000 });
    expect(world.events.list({ types: ["grant.forecast"] })).toHaveLength(2);
    // no gate notice for the step past the ceiling either: the forecast is the record
    expect(listNotices(world, { kind: "gate" }).map((n) => n.title)).toEqual(["Step 1 of 3 landed: 40,000 of 600,000 spent, projected 590,000"]);
  });

  it("an on-budget forecast files a gate notice and no need", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund();
    const { r } = await runStep(40_000);
    expect(gateNeeds(g.id)).toHaveLength(0);
    const [n] = listNotices(world, { kind: "gate" });
    expect(n).toMatchObject({ kind: "gate", buildingId: g.buildingId, title: "Step 1 of 3 landed: 40,000 of 600,000 spent, projected 590,000", refs: [g.id, r.id] });
  });

  it("the hold at the ceiling writes one gate need with Adjust and Cut and the gate's facts, and no card", async () => {
    const { world, fund, runStep, gateAsks, gateNeeds } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(300_000);
    const { r } = await runStep(300_000); // the L step: 640k spent, past the 600k ceiling
    world.grantDesk.checkpoints(g.buildingId);
    expect(world.grants.require(g.id).status).toBe("checkpoint");
    expect(gateAsks(g.id)).toHaveLength(0);
    const needs = gateNeeds(g.id);
    expect(needs).toHaveLength(1);
    const need = needs[0]!;
    expect(need).toMatchObject({ open: true, level: "human", authorKind: "code", moved: { need: "gate", targetKind: "grant", targetId: g.id, type: "money", branches: [{ label: "Adjust", action: "adjust" }, { label: "Cut", action: "cut" }] } });
    expect(need.note).toBe(`Grant ${g.id} "A banner" reached its gate: it is held at its 600,000-token ceiling.`);
    expect(need.body).toContain("You funded this at 600,000 tokens on");
    expect(need.body).toContain("It has spent 640,000 of its 600,000-token ceiling. New sessions on it wait for you.");
    expect(need.body).toContain("Three of 3 steps are done: one S, one M, one L.");
    expect(need.body).toContain(`The latest step report is ${r.id}, "Report on Build the board". Its verdict is continue.`);
  });

  it("a held grant whose latest step report says stop suggests cut", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(600_000, "stop");
    world.grantDesk.checkpoints(g.buildingId);
    expect(gateNeeds(g.id)[0]!.body).toContain("Suggested: Pix recommends cut: the latest step report says stop.");
  });

  it("the human's adjust at the hold settles the need and retires the card, keeping the card they saw on the answer entry", async () => {
    const { world, admin, fund, runStep, gateAsks, gateNeeds } = lab();
    const g = fund();
    await runStep(40_000);
    await runStep(600_000);
    world.grantDesk.checkpoints(g.buildingId);
    const [card] = renderNeeds(world);
    world.grantDesk.decide(admin, g.id, { action: "adjust", tokens: 750_000 });
    expect(gateAsks(g.id)[0]).toMatchObject({ status: "retired" });
    const need = gateNeeds(g.id)[0]!;
    expect(need.open).toBe(false);
    const answer = jobThread(world, g.id)!.entries.find((e) => e.answers === need.id)!;
    expect(answer).toMatchObject({ authorKind: "human", moved: { decision: "decided", card: { askId: card!.id, title: card!.title, branches: ["Adjust", "Cut"] } } });
    expect(answer.body).toContain(card!.title);
    expect(world.grantDesk.get(g.id)).toMatchObject({ status: "funded", grantTokens: 750_000 });
  });

  it("the boot repair retires a forecast gate ask and settles its need on a running grant, and leaves a held grant's gate alone", async () => {
    const { world, fund, runStep, gateAsks, gateNeeds } = lab();
    // a running grant with a gate need and card a forecast filed before the change
    const g = fund();
    await runStep(40_000);
    needAtCheckpoint(world, world.grants.require(g.id), 340_000);
    const [card] = renderNeeds(world);
    expect(card).toBeTruthy();
    // a held grant with its own gate need
    const h = fund();
    world.sessions.upsert({
      id: newId("se"), agentId: "system", assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 600_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: h.id,
    } as never);
    world.grantDesk.checkpoints(h.buildingId);
    expect(world.grants.require(h.id).status).toBe("checkpoint");
    expect(retireForecastGates(world)).toBe(2);
    expect(gateAsks(g.id)[0]).toMatchObject({ status: "retired" });
    expect(gateAsks(g.id)[0]!.retiredBy).toContain("mt_vdu3iqhasi decision 2");
    expect(gateNeeds(g.id).every((n) => !n.open)).toBe(true);
    expect(world.grants.require(g.id).status).toBe("funded");
    expect(gateNeeds(h.id).filter((n) => n.open)).toHaveLength(1);
    // idempotent
    expect(retireForecastGates(world)).toBe(0);
  });

  it("a funded grant whose steps were planned before sizes files no forecast, no need and no notice; an event says why", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund();
    // as migration 098 leaves a grant funded before sizes: its steps carry no size
    world.grants.upsert({ ...world.grants.require(g.id), steps: STEPS.map(({ title, description }) => ({ title, description })) as never });
    await runStep(500_000);
    expect(fileForecast(world, g.id)).toBeNull();
    expect(world.grants.require(g.id)).toMatchObject({ forecast: null, needsTopUp: false });
    expect(gateNeeds(g.id)).toHaveLength(0);
    expect(listNotices(world, { kind: "gate" })).toHaveLength(0);
    const ev = world.events.list({ types: ["grant.forecast"] });
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => (e.payload as { skipped?: string }).skipped === "unsized")).toBe(true);
    expect(ev[0]!.text).toContain("planned before step sizes");
  });

  it("a grant that is stopping or closed files no forecast", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund();
    await runStep(40_000);
    for (const status of ["stopping", "closed"] as const) {
      world.grants.upsert({ ...world.grants.require(g.id), status });
      expect(fileForecast(world, g.id)).toBeNull();
    }
    expect(gateNeeds(g.id)).toHaveLength(0);
    expect(listNotices(world, { kind: "gate" })).toHaveLength(1); // step 1's, while it ran
  });
});

describe("the gate's facts never coerce (decision-5 audit ranks 6-7)", () => {
  it("a step report with no verdict reads as 'It gave no verdict', never 'continue'", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund();
    const { r } = await runStep(40_000);
    const { verdict: _dropped, ...noVerdict } = world.docs.require(r.id);
    world.docs.upsert(noVerdict as never);
    world.sessions.upsert({
      id: newId("se"), agentId: world.grants.require(g.id).proposedBy ?? "system", assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 600_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
    } as never);
    world.grantDesk.checkpoints(g.buildingId);
    const body = gateNeeds(g.id).at(-1)!.body;
    expect(body).toContain(`The latest step report is ${r.id}, "Report on Check the banner". It gave no verdict.`);
    expect(body).not.toContain("Its verdict is continue");
  });

  it("unsized steps are counted as unsized in the gate's facts, never priced as M; proposing them is refused", async () => {
    const { world, fund, runStep, gateNeeds, b } = lab();
    const g = fund();
    world.grants.upsert({ ...world.grants.require(g.id), steps: STEPS.map(({ title, description }) => ({ title, description })) as never });
    await runStep(650_000);
    world.grantDesk.checkpoints(g.buildingId);
    const body = gateNeeds(g.id).at(-1)!.body;
    expect(body).toMatch(/steps? (is|are) left: two unsized\./);
    expect(body).not.toMatch(/one M|two M/);
    // a draft whose steps carry no size can't be priced: propose names the step
    const d = world.grantDesk.create(null, b.id, { keyResults: [KR], objective: "Old plan", steps: STEPS, stopCondition: "s" });
    world.grants.upsert({ ...world.grants.require(d.id), steps: STEPS.map(({ title, description }) => ({ title, description })) as never });
    expect(() => world.grantDesk.propose(null, d.id)).toThrow(/Step 1 \("Check the banner"\) has no size: it was planned before step sizes, so it can't be priced/);
  });
});

describe("the checkpoint's need", () => {
  it("a grant held with no forecast and no report writes its need with what the town knows, and no suggestion it can't back", () => {
    const { world, fund, b, gateNeeds, gateAsks } = lab();
    const g = fund();
    world.sessions.upsert({
      id: newId("se"), agentId: world.buildings.require(b.id).managerAgentId!, assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 600_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
    } as never);
    world.grantDesk.checkpoints(g.buildingId);
    expect(gateAsks(g.id)).toHaveLength(0);
    const need = gateNeeds(g.id)[0]!;
    expect(need.open).toBe(true);
    expect(need.body).toContain("It has spent 600,000 of its 600,000-token ceiling.");
    expect(need.body).not.toContain("Suggested:");
    expect(need.body).not.toContain("latest step report");
  });
});

describe("the step in flight is priced at what is left of it (gr_76e81kdpvy, findings dc_94qevcrr7x)", () => {
  /** the Pins grant gr_y4s2j99vgm: three M steps, a 450,000 ceiling */
  const PINS = [0, 1, 2].map((i) => ({ size: "M" as const, title: `Pins step ${i + 1}`, description: "Ship its PR" }));

  it("the Pins numbers: held at 453,179 with step 3 at 195,685 and parked on CI, the gate suggests 50,000, not 400,000, and names step 3", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund(PINS);
    expect(g.grantTokens).toBe(450_000);
    await runStep(100_000);
    await runStep(157_494); // 257,494 after two steps: projected 407,494, within the ceiling
    expect(gateNeeds(g.id)).toHaveLength(0);
    await runStep(195_685, "continue", { title: "Pins step 3 in draft PR #486; parked on its CI" });
    expect(world.grantDesk.stepStates(world.grants.require(g.id))[2]).toMatchObject({ status: "pending", spentTokens: 195_685 });
    world.grantDesk.checkpoints(g.buildingId);
    expect(world.grants.require(g.id).status).toBe("checkpoint");
    const body = gateNeeds(g.id).at(-1)!.body;
    expect(body).toContain("It has spent 453,179 of its 450,000-token ceiling.");
    expect(body).toContain("One step is left: one M.");
    // step 3 is past its 150,000 price: priced at the floor, half the smallest size (25,000), never a full M again
    expect(body).toContain("At what its steps have left, it is projected to spend 478,179 tokens in all.");
    expect(body).toContain("That is 28,179 tokens past the ceiling.");
    expect(body).toContain("Suggested: Pix recommends adjust by 50,000 tokens.");
    expect(body).not.toContain("400,000");
    expect(body).toContain(`Step 3 is in flight: "Pins step 3 in draft PR #486; parked on its CI". It has spent 195,685 tokens against its 150,000-token size`);
    // the free-tokens earmark (under oversell) reads the same remainder
    const { expectedRemaining } = await import("../src/grant-forecast.ts");
    const { stepCalibration } = await import("../src/grant-estimate.ts");
    expect(expectedRemaining(world, world.grants.require(g.id), stepCalibration(world), 0)).toBe(25_000);
  });

  it("a step in flight under its price is priced at its price less its spend", async () => {
    const { world, fund, runStep } = lab();
    const g = fund(PINS);
    await runStep(100_000);
    await runStep(150_000);
    await runStep(90_000, "continue", { title: "Step 3 parked on its CI" });
    const { expectedRemaining } = await import("../src/grant-forecast.ts");
    const { stepCalibration } = await import("../src/grant-estimate.ts");
    expect(expectedRemaining(world, world.grants.require(g.id), stepCalibration(world), 0)).toBe(60_000);
  });

  it("a step not started is still priced at its full size: the projection does not change, and no step is named in flight", async () => {
    const { world, fund, runStep, gateNeeds } = lab();
    const g = fund(PINS);
    await runStep(100_000);
    await runStep(260_000); // 360,000 spent, step 3 queued with no spend: 360,000 + a full M = 510,000
    expect(world.grants.require(g.id).forecast).toMatchObject({ projected: 510_000, shortfall: 60_000 });
    // held at the ceiling with step 3 still unstarted: priced at its full size, never named in flight
    world.sessions.upsert({
      id: newId("se"), agentId: "system", assignmentId: null, meetingId: null, purpose: "work", backend: "host", status: "done", model: "m",
      sdkSessionId: null, output: 90_000, costUsd: 0, turns: 0, reportId: null, error: null, startedAt: nowIso(), endedAt: nowIso(), funding: null, lane: "grant", grantId: g.id,
    } as never);
    world.grantDesk.checkpoints(g.buildingId);
    const body = gateNeeds(g.id).at(-1)!.body;
    expect(body).toContain("At what its steps have left, it is projected to spend 600,000 tokens in all.");
    expect(body).toContain("That is 150,000 tokens past the ceiling.");
    expect(body).toContain("Suggested: Pix recommends adjust by 150,000 tokens.");
    expect(body).not.toContain("in flight");
  });
});
