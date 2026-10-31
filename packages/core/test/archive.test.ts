/** A report's actions are Talk to the author and Archive (1:1 mt_cz11aqe81a): archive acknowledges, no assignment. */
import { describe, expect, it } from "vitest";
import { seededWorld } from "./helpers.ts";

const BODY = "## What I did\nRan it.\n\n## Findings\nIt works.\n\n## What I need from you\nMerge PR #12.";

async function setup() {
  const s = seededWorld();
  const mei = s.by("Mei");
  const { id } = await s.world.verbs.submit_report(mei, { title: "Run 1", body: BODY, verdict: "continue" });
  return { ...s, mei, docId: id };
}

describe("archiveReport", () => {
  it("acknowledges: no assignment, no mention, body unchanged, leaves the in-tray; a second archive changes nothing", async () => {
    const { world, admin, mei, docId } = await setup();
    const before = world.docs.require(docId).body;
    const before_asg = world.assignments.where("agentId = ?", [mei.id]).length;
    const { doc, assignment } = world.ops.archiveReport(admin, docId);
    expect(assignment).toBeNull();
    expect(doc).toMatchObject({ decision: "approve", body: before });
    expect(doc.decisionNote ?? null).toBeNull();
    expect(doc.decidedBy).toBeTruthy();
    expect(world.assignments.where("agentId = ?", [mei.id]).length).toBe(before_asg);
    expect((await world.verbs.inbox(mei, { markRead: false })).messages.filter((m) => m.kind === "mention" && m.docId === docId)).toHaveLength(0);
    expect(world.ops.intray(doc.buildingId!).some((d) => d.id === docId)).toBe(false);
    const at = doc.decidedAt;
    expect(world.ops.archiveReport(admin, docId).doc.decidedAt).toBe(at);
  });

  it("resumeAgent un-stops to idle without creating an assignment; no-op otherwise; needs agent control", async () => {
    const { world, admin, mei, by } = await setup();
    const before = world.assignments.where("agentId = ?", [mei.id]).length;
    world.ops.stopAgent(admin, mei.id);
    expect(world.ops.resumeAgent(admin, mei.id).status).toBe("idle");
    expect(world.assignments.where("agentId = ?", [mei.id]).length).toBe(before);
    world.agents.upsert({ ...world.agents.require(mei.id), status: "banned" });
    expect(world.ops.resumeAgent(admin, mei.id).status).toBe("banned");
    expect(() => world.ops.resumeAgent(by("Tomas"), mei.id)).toThrow(/building.assign/);
  });

  it("needs building.review", async () => {
    const { world, by, docId } = await setup();
    expect(() => world.ops.archiveReport(by("Tomas"), docId)).toThrow(/building.review/);
  });
});
