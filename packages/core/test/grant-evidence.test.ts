import { describe, expect, it } from "vitest";
import { buildingRoleId, reviewDeck, workSystemPrompt } from "../src/index.ts";
import { creditBank, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KRS = [
  { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" },
  { text: "The board shows the lab's goal first", howToCheck: "Open the lab board" },
];
const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";

/** Mei manages the lab; Noor runs grant-lane sessions on a funded grant with two key results (grant C, gr_95svkzi4l6). */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  creditBank(world);
  const fund = () => {
    const g = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: KRS, objective: "Visitors can tell what the lab is for", steps: [{ title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 1_000_000 }).id);
    return world.grantDesk.decide(admin, g.id, { action: "fund" });
  };
  /** start a session for Noor in a lane (grant on `grantId`, or exploration) */
  const start = (lane: "grant" | "exploration", grantId?: string) => {
    for (const a of world.assignments.where("agentId = ? AND status IN ('pending','active')", [noor.id])) world.assignments.patch(a.id, { status: "cancelled" });
    world.agents.patch(noor.id, { currentAssignmentId: null });
    const a = world.ops.createWork(admin, noor.id, lane === "grant" ? { title: "kr work", lane, grantId } : { title: "explore", lane, gap: "nobody knows the lab" });
    return world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: a.id });
  };
  return { ...s, mei, noor, fund, start };
}

describe("grant C: forks file key-result evidence with submit_report (kr_13txlz2pnc)", () => {
  it("a grant-lane report sets its own grant's key results (status, a note naming the report, statusBy = the fork) and the top-up", async () => {
    const { world, noor, fund, start } = setup();
    const g = fund();
    const [k1, k2] = world.grantDesk.keyResultsOf(g.id);
    start("grant", g.id);
    const r = await world.verbs.submit_report(noor, {
      title: "Step 1 shipped the banner", body: REPORT, verdict: "continue",
      keyResults: [{ id: k1!.id, status: "claimed", evidence: "PR #12, live at /lab: the banner shows Usage" }],
      topUp: { tokens: 200_000, buys: "KR 2: the board leads with the goal" },
    });
    expect(r.warnings ?? []).toEqual([]);
    expect(world.keyResults.require(k1!.id)).toMatchObject({ status: "claimed", statusNote: `PR #12, live at /lab: the banner shows Usage (report ${r.id})`, statusBy: noor.id });
    expect(world.keyResults.require(k2!.id)).toMatchObject({ status: "not-started", statusBy: null });
    expect(world.grants.require(g.id)).toMatchObject({ topUpTokens: 200_000, whatTopUpBuys: "KR 2: the board leads with the goal" });
    expect(world.events.recent({ types: ["kr.updated"] })[0]?.payload).toMatchObject({ keyResultId: k1!.id, by: noor.id, reportId: r.id });
  });

  it("refuses evidence from another grant's session, an exploration session, a key result of another grant, and a status above claimed", async () => {
    const { world, noor, fund, start } = setup();
    const g = fund(), other = fund();
    const mine = world.grantDesk.keyResultsOf(g.id)[0]!, theirs = world.grantDesk.keyResultsOf(other.id)[0]!;
    start("grant", other.id);
    await expect(world.verbs.submit_report(noor, { title: "t", body: REPORT, verdict: "continue", keyResults: [{ id: mine.id, status: "on-track", evidence: "x" }] }))
      .rejects.toThrow(/not a key result of your session's grant/);
    start("exploration");
    await expect(world.verbs.submit_report(noor, { title: "t", body: REPORT, verdict: "continue", keyResults: [{ id: mine.id, status: "on-track", evidence: "x" }] }))
      .rejects.toThrow(/only from a grant-lane session.*exploration/);
    await expect(world.verbs.submit_report(noor, { title: "t", body: REPORT, verdict: "continue", topUp: { tokens: 1, buys: "x" } }))
      .rejects.toThrow(/topUp is filed only from a grant-lane session/);
    start("grant", g.id);
    await expect(world.verbs.submit_report(noor, { title: "t", body: REPORT, verdict: "continue", keyResults: [{ id: theirs.id, status: "claimed", evidence: "x" }] }))
      .rejects.toThrow(/not a key result of your session's grant/);
    await expect(world.verbs.submit_report(noor, { title: "t", body: REPORT, verdict: "continue", keyResults: [{ id: mine.id, status: "met" as never, evidence: "x" }] }))
      .rejects.toThrow();
    // nothing was filed by the refusals
    expect(world.keyResults.require(mine.id)).toMatchObject({ status: "not-started", statusBy: null });
    expect(world.docs.where("type = 'report' AND title = 't'", [])).toHaveLength(0);
  });

  it("a grant-lane report with neither keyResults nor topUp is filed with a warning; an exploration report gets none", async () => {
    const { world, noor, fund, start } = setup();
    const g = fund();
    start("grant", g.id);
    const r = await world.verbs.submit_report(noor, { title: "no evidence", body: REPORT, verdict: "continue" });
    expect(r.warnings?.join(" ")).toMatch(/no keyResults or topUp/);
    expect(world.docs.require(r.id).body).toBe(REPORT);
    start("exploration");
    expect((await world.verbs.submit_report(noor, { title: "explored", body: REPORT, verdict: "stop" })).warnings).toBeUndefined();
  });

  it("evidence() lists the grant's own reports and the forks' notes; 'No evidence filed by the forks' when none; the latest top-up wins", async () => {
    const { world, noor, admin, fund, start } = setup();
    const g = fund();
    const [k1] = world.grantDesk.keyResultsOf(g.id);
    start("grant", g.id);
    const first = await world.verbs.submit_report(noor, { title: "Step 1, nothing to claim", body: REPORT, verdict: "continue" });
    let e = world.grantDesk.evidence(world.grants.require(g.id));
    expect(e).toMatchObject({ filed: false, topUpTokens: null });
    expect(e.reports.map((x) => x.id)).toEqual([first.id]);
    expect(e.reports[0]).toMatchObject({ title: "Step 1, nothing to claim", authorName: "Noor", verdict: "continue" });
    // the held card (a grant at checkpoint) and its deck slide say no fork filed evidence, and omit the top-up line
    world.grants.patch(g.id, { status: "checkpoint" });
    let slide = reviewDeck(world).slides.find((s) => s.grantId === g.id)!;
    expect(slide.text).toContain("No evidence filed by the forks");
    expect(slide.text).toContain(`Step 1, nothing to claim (${first.id}, Noor, continue)`);
    expect(slide.text).not.toContain("A top-up");
    world.grants.patch(g.id, { status: "funded" });

    start("grant", g.id);
    await world.verbs.submit_report(noor, { title: "Step 2", body: REPORT, verdict: "continue", keyResults: [{ id: k1!.id, status: "on-track", evidence: "half the banner" }], topUp: { tokens: 100_000, buys: "the first try" } });
    start("grant", g.id);
    const third = await world.verbs.submit_report(noor, { title: "Step 3", body: REPORT, verdict: "continue", topUp: { tokens: 300_000, buys: "the board" } });
    e = world.grantDesk.evidence(world.grants.require(g.id));
    expect(e).toMatchObject({ filed: true, topUpTokens: 300_000, whatTopUpBuys: "the board" });
    expect(e.reports.map((x) => x.title)).toEqual(["Step 1, nothing to claim", "Step 2", "Step 3"]);
    expect(e.keyResults[0]).toMatchObject({ status: "on-track", verdict: "partly", by: "Noor" });
    world.grants.patch(g.id, { status: "checkpoint" });
    slide = reviewDeck(world).slides.find((s) => s.grantId === g.id)!;
    expect(slide.text).not.toContain("No evidence filed by the forks");
    expect(slide.text).toContain("~ partly: half the banner (report");
    expect(slide.text).toContain("(Noor)");
    expect(slide.text).toContain("A top-up of 300,000 tokens buys: the board");
    expect(slide.text).toContain(third.id);
  });

  it("a hold keeps the top-up the forks filed; a continue clears it", async () => {
    const { world, noor, admin, fund, start } = setup();
    const g = fund();
    start("grant", g.id);
    await world.verbs.submit_report(noor, { title: "s", body: REPORT, verdict: "continue", topUp: { tokens: 100_000, buys: "x" } });
    world.sessions.upsert({ ...world.sessions.where("grantId = ?", [g.id])[0]!, output: 900_000 }); // past the hold at 850k
    world.budget.charge(noor.id, 0, 0);
    expect(world.grants.require(g.id)).toMatchObject({ status: "checkpoint", topUpTokens: 100_000 });
    world.grantDesk.decide(admin, g.id, { action: "continue" });
    expect(world.grants.require(g.id)).toMatchObject({ status: "funded", topUpTokens: null, whatTopUpBuys: "" });
  });

  it("the fork prompt tells a grant-lane fork to file keyResults and topUp", () => {
    const { world, noor } = setup();
    const p = workSystemPrompt(noor, world.buildings.require(LAB), world.town.get());
    expect(p).toContain("keyResults: [{id, status, evidence}]");
    expect(p).toContain("topUp: {tokens, buys}");
  });
});
