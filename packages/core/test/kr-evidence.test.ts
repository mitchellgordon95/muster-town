/**
 * Build step 10 of docs/legible-delegation.md (§5): a key result's evidence class, verified | claimed | unknown, a column
 * beside `status` (migration 103). A fork's report that claims it makes it claimed; a human marking it met, or a passed
 * `kr` claim check, makes it verified. `status` moves exactly as before.
 */
import { describe, expect, it } from "vitest";
import { buildingQueue, createBuilding, createResident, forkManager, retireFork, updateBuilding } from "../src/index.ts";
import { runClaimChecks } from "../src/ask-checks.ts";
import { createAsk } from "../src/asks.ts";
import { migrate } from "../src/db.ts";
import { creditBank, seededWorld } from "./helpers.ts";

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

describe("key-result evidence class (docs/legible-delegation.md §5)", () => {
  it("unknown until claimed: a fork's report claiming it makes it claimed; a human marking it met makes it verified; status is unchanged by it", async () => {
    const { world, admin, b, k1, k2 } = lab();
    expect(world.keyResults.require(k1.id).evidence ?? "unknown").toBe("unknown");
    const a = buildingQueue(world, b.id)[0]!;
    const { fork } = forkManager(world, b.id, a.id);
    world.assignments.patch(a.id, { status: "active" });
    await world.verbs.submit_report(fork, { title: "Banner", body: REPORT, verdict: "continue", keyResults: [{ id: k1.id, status: "claimed", evidence: "PR #12" }, { id: k2.id, status: "on-track", evidence: "half done" }] });
    retireFork(world, fork.id);
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "claimed", evidence: "claimed" });
    expect(world.keyResults.require(k2.id)).toMatchObject({ status: "on-track", evidence: "unknown" });
    // the checkpoint card's key results carry it
    expect(world.grantDesk.evidence(world.grants.require(k1.grantId!)).keyResults.find((k) => k.id === k1.id)).toMatchObject({ evidence: "claimed" });
    world.grantDesk.updateKeyResult(admin, k1.id, { status: "met", note: "seen live" });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "met", evidence: "verified" });
    expect(world.grantDesk.get(k1.grantId!).keyResults.find((k) => k.id === k1.id)).toMatchObject({ evidence: "verified" });
    // a human taking met back drops it to what the new status says
    world.grantDesk.updateKeyResult(admin, k1.id, { status: "claimed", note: "not yet after all" });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "claimed", evidence: "claimed" });
  });

  it("a kr claim check that passes verifies its key result once, with a verified notice; a failing one leaves it", async () => {
    const { world, k1 } = lab();
    const { ask } = createAsk(world, { type: "click", buildingId: null, sourceDocId: null, title: "Health", branches: [{ label: "Done" }, { label: "Decline" }], claims: [{ text: "Health answers", check: { kind: "kr", ref: k1.id } }] });
    await runClaimChecks(world, ask, { getUrl: async () => ({ status: 500, body: "" }) });
    expect(world.keyResults.require(k1.id).evidence ?? "unknown").toBe("unknown");
    await runClaimChecks(world, world.asks.require(ask.id), { getUrl: async () => ({ status: 200, body: "" }) });
    expect(world.keyResults.require(k1.id)).toMatchObject({ status: "not-started", evidence: "verified" });
    await runClaimChecks(world, world.asks.require(ask.id), { getUrl: async () => ({ status: 200, body: "" }) });
    expect(world.events.list({ types: ["kr.verified"] })).toHaveLength(1);
    expect(world.notices.count("kind = 'verified'")).toBe(1);
  });

  it("migration 103 back-fills met by a human as verified; met by an agent (a manager's close) or by no one, and claimed, as claimed", () => {
    const { world, admin, pix, k1, k2, g } = lab();
    const human = world.holderOf(admin).id;
    expect(human).toMatch(/^us_/);
    world.keyResults.patch(k1.id, { status: "met", statusBy: human });
    world.keyResults.patch(k2.id, { status: "claimed" });
    const [k3, k4] = [
      world.keyResults.upsert({ ...world.keyResults.require(k1.id), id: "kr_byagent", status: "met", statusBy: pix.id, grantId: g.id }),
      world.keyResults.upsert({ ...world.keyResults.require(k1.id), id: "kr_bynoone", status: "met", statusBy: null, grantId: g.id }),
    ];
    world.db.exec("ALTER TABLE key_results DROP COLUMN evidence");
    world.db.prepare("DELETE FROM schema_version WHERE version = 103").run();
    migrate(world.db);
    expect(world.keyResults.require(k1.id).evidence).toBe("verified");
    expect(world.keyResults.require(k2.id).evidence).toBe("claimed");
    expect(world.keyResults.require(k3.id).evidence).toBe("claimed");
    expect(world.keyResults.require(k4.id).evidence).toBe("claimed");
  });
});
