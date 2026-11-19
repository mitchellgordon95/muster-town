/**
 * A key result has one parent and one status (grant gr_h4m0lyhb1f step 2, migration 125): its grant, and one of open /
 * claimed / met / met-unverified / missed. The evidence class of legible delegation step 10 folded into the status: a
 * fork's report claims it, a human (or a passed `kr` claim check on a claimed one) makes it met.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, retireFork, updateBuilding } from "../src/index.ts";
import { runClaimChecks } from "../src/ask-checks.ts";
import { migrate } from "../src/db.ts";
import { creditBank, seededWorld, seedAsk } from "./helpers.ts";

const REPORT = "## What I did\nx\n## Findings\ny\n## What I need from you\nNothing needed.";

function lab() {
  const s = seededWorld();
  const { world, seed, admin } = s;
  const b = createBuilding(world, { name: "Gated", headcount: 3, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  creditBank(world);
  const g = world.grantDesk.decide(admin, world.grantDesk.propose(null, world.grantDesk.create(null, b.id, {
    keyResults: [{ text: "Health answers", howToCheck: "curl -s https://muster.town/api/health" }, { text: "A guest sees the banner", howToCheck: "Open the lab as a guest" }],
    objective: "A banner", steps: [{ size: "M", title: "Build the banner", description: "Ship it" }, { size: "S", title: "Check it", description: "Look" }], stopCondition: "s",
  }).id).id, { action: "fund" });
  const [k1, k2] = world.grantDesk.keyResultsOf(g.id);
  return { ...s, b, pix, g, k1: k1!, k2: k2! };
}

describe("a key result's one status (gr_h4m0lyhb1f step 2)", () => {
  it("a fork's report files open or claimed; a human marks it met and can take it back; the checkpoint card shows the status", async () => {
    const { world, admin, b, k1, k2 } = lab();
    expect(world.keyResults.require(k1.id).status).toBe("open");
    expect(world.keyResults.require(k1.id)).not.toHaveProperty("buildingId");
    expect(world.krBuildingId(k1)).toBe(b.id);
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    await expect(world.verbs.submit_report(fork, { title: "Banner", body: REPORT, verdict: "continue", left: "x", keyResults: [{ id: k2.id, status: "on-track" as "open", evidence: "half done" }] })).rejects.toThrow();
    await world.verbs.submit_report(fork, { title: "Banner", body: REPORT, verdict: "continue", left: "The rest of the plan.", keyResults: [{ id: k1.id, status: "claimed", evidence: "PR #12" }, { id: k2.id, status: "open", evidence: "half done" }] });
    retireFork(world, fork.id);
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "claimed" });
    expect(world.keyResults.require(k2.id)).toMatchObject({ status: "open", statusNote: expect.stringContaining("half done") });
    expect(world.grantDesk.evidence(world.grants.require(k1.grantId!)).keyResults.map((k) => k.verdict)).toEqual(["shipped", "not"]);
    world.grantDesk.updateKeyResult(admin, k1.id, { status: "met", note: "seen live" });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "met" });
    world.grantDesk.updateKeyResult(admin, k1.id, { status: "claimed", note: "not yet after all" });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "claimed", archivedAt: null });
  });

  it("a kr claim check that passes makes a claimed key result met once, with a verified notice; an open one or a failing check leaves it", async () => {
    const { world, k1 } = lab();
    const { ask } = seedAsk(world, { type: "click", buildingId: null, sourceDocId: null, title: "Health", branches: [{ label: "Done" }, { label: "Decline" }], claims: [{ text: "Health answers", check: { kind: "kr", ref: k1.id } }] });
    await runClaimChecks(world, ask, { getUrl: async () => ({ status: 200, body: "" }) });
    expect(world.keyResults.require(k1.id).status).toBe("open");
    world.keyResults.patch(k1.id, { status: "claimed" });
    await runClaimChecks(world, world.asks.require(ask.id), { getUrl: async () => ({ status: 500, body: "" }) });
    expect(world.keyResults.require(k1.id).status).toBe("claimed");
    await runClaimChecks(world, world.asks.require(ask.id), { getUrl: async () => ({ status: 200, body: "" }) });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "met", archivedAt: expect.any(String) });
    await runClaimChecks(world, world.asks.require(ask.id), { getUrl: async () => ({ status: 200, body: "" }) });
    expect(world.events.list({ types: ["kr.verified"] })).toHaveLength(1);
    expect(world.notices.count("kind = 'verified'")).toBe(1);
  });

  it("migration 125 folds the old statuses and the evidence column into one status and drops buildingId, objectiveId and evidence", () => {
    const { world, b, g } = lab();
    world.db.exec("ALTER TABLE key_results ADD COLUMN buildingId TEXT; ALTER TABLE key_results ADD COLUMN objectiveId TEXT; ALTER TABLE key_results ADD COLUMN evidence TEXT DEFAULT 'unknown'");
    const put = world.db.prepare("INSERT INTO key_results (id, buildingId, position, text, howToCheck, status, evidence, grantId, goalId, updatedAt) VALUES (?, ?, 99, 't', 'h', ?, ?, ?, ?, ?)");
    const rows: [string, string, string, string][] = [
      ["kr_ns", "not-started", "unknown", "2026-11-18T00:00:00Z"], ["kr_ot", "on-track", "unknown", "2026-11-18T00:00:00Z"],
      ["kr_ar", "at-risk", "claimed", "2026-11-18T00:00:00Z"], ["kr_cl", "claimed", "claimed", "2026-11-18T00:00:00Z"],
      ["kr_mv", "met", "verified", "2026-11-01T00:00:00Z"], ["kr_mc", "met", "claimed", "2026-11-10T00:00:00Z"],
      ["kr_mu_old", "met", "unknown", "2026-11-10T00:00:00Z"], ["kr_mu_new", "met", "unknown", "2026-11-18T00:00:00Z"],
      ["kr_mx", "missed", "unknown", "2026-11-18T00:00:00Z"],
    ];
    for (const [id, status, evidence, at] of rows) put.run(id, b.id, status, evidence, g.id, g.goalId, at);
    world.db.prepare("DELETE FROM schema_version WHERE version = 125").run();
    migrate(world.db);
    const status = (id: string) => (world.db.prepare("SELECT status FROM key_results WHERE id = ?").get(id) as { status: string }).status;
    expect(Object.fromEntries(rows.map(([id]) => [id, status(id)]))).toEqual({
      kr_ns: "open", kr_ot: "open", kr_ar: "open", kr_cl: "claimed", kr_mv: "met", kr_mc: "met", kr_mu_old: "met-unverified", kr_mu_new: "met", kr_mx: "missed",
    });
    const cols = (world.db.prepare("PRAGMA table_info(key_results)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).not.toContain("buildingId");
    expect(cols).not.toContain("objectiveId");
    expect(cols).not.toContain("evidence");
    expect(cols).toContain("grantId");
  });
});
