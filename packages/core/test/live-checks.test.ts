/**
 * Live checks on a deploy wait (grant gr_qg42b4guky step 1): a step parked on {deploy, checks, verifies} is checked by
 * the town once its deploy is live. All pass: done with no session, a "live checks passed" entry, its own grant's key
 * results verified. Any fails: the work wakes with each check, what it expected and what the live town returned.
 */
import { describe, expect, it } from "vitest";
import { WAIT_TTL_MS } from "@muster-town/schema";
import { buildingQueue, checkWaits, createBuilding, createResident, describeWait, forkManager, jobThread, retireFork, updateBuilding } from "../src/index.ts";
import { creditBank, musterWorld } from "./helpers.ts";

const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";
const STEPS = [
  { size: "M" as const, title: "Ship the banner", description: "Ship the banner PR" },
  { size: "S" as const, title: "Measure and close", description: "Measure" },
];
const SHA = "8842a21";

function lab() {
  const s = musterWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Checky", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const fund = (text: string) => {
    const g = world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, {
      keyResults: [{ text, howToCheck: "GET /api/health" }], objective: "o", approach: "a", steps: STEPS, stopCondition: "s", askTokens: 500_000,
    }).id).id, { action: "fund" });
    return { g, kr: world.keyResults.first("grantId = ?", [g.id])! };
  };
  /** a fork takes the building's first queued assignment and parks it on `resumeWhen` */
  const park = async (resumeWhen: unknown) => {
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    try {
      return await world.verbs.submit_report(fork, { title: `Parked ${a.title}`, body: REPORT, verdict: "continue", resumeWhen: resumeWhen as never, next: "check it live" });
    } finally { retireFork(world, fork.id); }
  };
  world.host.apiGet = async (path) => path === "/api/health" ? { status: 200, body: { commit: "8842a21ffff", deploy: { state: "current" } } } : { status: 404, body: {} };
  return { ...s, b, fund, park };
}

describe("live checks on a deploy wait (gr_qg42b4guky)", () => {
  it("checks that pass close the parked step as done with no session: a 'live checks passed' entry with each check, its own key result verified, the next step queued", async () => {
    const { world, b, fund, park } = lab();
    const { g, kr } = fund("The banner is live");
    const r = await park({ deploy: SHA, checks: [{ kind: "api", ref: "GET /api/health /deploy/state current" }, { kind: "url", ref: "https://muster.town/", status: 200, contains: "Muster" }], verifies: [kr.id] });
    const cont = world.assignments.require(r.nextAssignmentId!);
    expect(describeWait(world, cont.waitFor!)).toBe("a redeploy with 8842a21, then 2 live checks");
    const getUrl = async () => ({ status: 200, body: "<title>Muster Town</title>" });
    // not live yet: nothing runs
    expect(checkWaits(world, new Date(), { getUrl }).checking).toEqual([]);
    world.host.isLive = (s) => s === SHA;
    world.host.commit = "8842a21ffff";
    const { checking, unblocked } = checkWaits(world, new Date(), { getUrl });
    expect(unblocked).toEqual([]);
    expect(checking).toHaveLength(1);
    // while the checks run, a second tick starts no second run
    expect(checkWaits(world, new Date(), { getUrl }).checking).toEqual([]);
    await Promise.all(checking);
    expect(world.assignments.require(cont.id)).toMatchObject({ status: "done", waitFor: null });
    const entry = jobThread(world, g.id)!.entries.find((e) => e.moved.kind === "live-checks")!;
    expect(entry).toMatchObject({ note: `live checks passed (2); verified ${kr.id}`, authorKind: "code", level: "none", assignmentId: cont.id });
    expect(entry.body).toContain("passed: api GET /api/health /deploy/state current: /deploy/state is \"current\", expected current");
    expect(entry.body).toContain("passed: url https://muster.town/ (expected status 200, contains \"Muster\"): HTTP 200, expected 200; the body contains \"Muster\"");
    expect(world.keyResults.require(kr.id).status).toBe("met");
    expect(world.events.recent({ limit: 20 }).some((e) => e.type === "kr.verified" && (e.payload as { keyResultId?: string }).keyResultId === kr.id)).toBe(true);
    expect(world.sessions.where("assignmentId = ?", [cont.id])).toHaveLength(0);
    expect(buildingQueue(world, b.id).map((a) => [a.title, a.grantStep])).toEqual([["Measure and close", 1]]);
  });

  it("a failing check wakes the parked step with the check, what it expected and what the live town returned; no key result moves", async () => {
    const { world, fund, park } = lab();
    const { g, kr } = fund("The banner is live");
    const r = await park({ deploy: SHA, checks: [{ kind: "api", ref: "GET /api/health /commit 1234567" }, { kind: "url", ref: "https://muster.town/", contains: "Banner" }], verifies: [kr.id] });
    world.host.isLive = () => true;
    const { checking } = checkWaits(world, new Date(), { getUrl: async () => ({ status: 503, body: "down" }) });
    const [cont] = await Promise.all(checking);
    expect(cont).toMatchObject({ id: r.nextAssignmentId, status: "pending", waitFor: null, grantStep: 0 });
    expect(cont!.description).toContain("Live checks when this resumed: 2 of 2 failed.");
    expect(cont!.description).toContain("- FAILED: api GET /api/health /commit 1234567: /commit is \"8842a21ffff\", expected 1234567");
    expect(cont!.description).toContain("- FAILED: url https://muster.town/ (expected contains \"Banner\"): HTTP 503; the body does not contain \"Banner\"");
    expect(jobThread(world, g.id)!.entries.find((e) => e.moved.kind === "live-checks")).toMatchObject({ note: "live checks failed (2 of 2); the work resumes" });
    expect(world.keyResults.require(kr.id).status).toBe("open");
  });

  it("verifies refuses a key result of another grant, and verifies without checks", async () => {
    const { world, fund, park } = lab();
    fund("Mine");
    const other = fund("Someone else's");
    await expect(park({ deploy: SHA, checks: [{ kind: "api", ref: "GET /api/health /commit" }], verifies: [other.kr.id] })).rejects.toThrow(/not of this work's grant/);
    await expect(park({ deploy: SHA, verifies: [other.kr.id] })).rejects.toThrow(/name the live checks/);
    expect(world.keyResults.require(other.kr.id).status).toBe("open");
  });

  it("a deploy that never goes live runs no check and expires into the in-tray after 24 h", async () => {
    const { world, fund, park } = lab();
    fund("The banner is live");
    let ran = 0;
    world.host.apiGet = async () => { ran++; return { status: 200, body: {} }; };
    const r = await park({ deploy: SHA, checks: [{ kind: "api", ref: "GET /api/health /commit" }] });
    world.host.isLive = () => false;
    expect(checkWaits(world).checking).toEqual([]);
    const { expired, checking } = checkWaits(world, new Date(Date.now() + WAIT_TTL_MS + 1000));
    expect(checking).toEqual([]);
    expect(expired.map((a) => a.id)).toEqual([r.nextAssignmentId]);
    expect(ran).toBe(0);
  });
});
