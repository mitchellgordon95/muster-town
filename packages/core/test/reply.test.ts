/** Design review 4: reports as replies (one box, one button; empty = archive; "merge"). */
import { describe, expect, it } from "vitest";
import { MERGE_INSTRUCTION } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const BODY = "## What I did\nRan it.\n\n## Findings\nIt works.\n\n## What I need from you\nMerge PR #12.";

async function setup() {
  const s = seededWorld();
  const mei = s.by("Mei");
  const { id } = await s.world.verbs.submit_report(mei, { title: "Run 1", body: BODY, verdict: "continue" });
  return { ...s, mei, docId: id };
}

describe("replyToReport", () => {
  it("text reply: appends a dated section, acknowledges, mentions the author, assigns fromReportId", async () => {
    const { world, admin, mei, docId } = await setup();
    const { doc, assignment } = world.ops.replyToReport(admin, docId, "  Try the 2010 data too.  ");
    expect(doc.decision).toBe("approve");
    expect(doc.decisionNote).toBe("Try the 2010 data too.");
    expect(doc.decidedBy).toBeTruthy();
    expect(doc.decidedAt).toBeTruthy();
    expect(doc.body).toMatch(new RegExp(`\\n\\n## Reply from ${admin.name} \\(\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}\\)\\n\\nTry the 2010 data too\\.\\n$`));
    expect(assignment).toMatchObject({ agentId: mei.id, title: "Reply on: Run 1", fromReportId: docId, status: "pending" });
    expect(assignment!.description).toContain(`${admin.name}'s reply: Try the 2010 data too.`);
    expect(assignment!.description).toContain(`(doc ${docId})`);
    expect(assignment!.description).not.toContain(MERGE_INSTRUCTION);
    const mention = (await world.verbs.inbox(mei, {})).messages.find((m) => m.kind === "mention" && m.docId === docId)!;
    expect(mention.body).toBe(`${admin.name} replied to your report "Run 1": Try the 2010 data too.`);
    expect(world.ops.intray(doc.buildingId!).some((d) => d.id === docId)).toBe(false);
  });

  it("empty reply archives: no assignment, no mention, body unchanged", async () => {
    const { world, admin, mei, docId } = await setup();
    const before = world.docs.require(docId).body;
    const before_asg = world.assignments.where("agentId = ?", [mei.id]).length;
    const { doc, assignment } = world.ops.archiveReport(admin, docId);
    expect(assignment).toBeNull();
    expect(doc.decision).toBe("approve");
    expect(doc.body).toBe(before);
    expect(world.assignments.where("agentId = ?", [mei.id]).length).toBe(before_asg);
    expect((await world.verbs.inbox(mei, { markRead: false })).messages.filter((m) => m.kind === "mention" && m.docId === docId)).toHaveLength(0);
    expect(world.ops.replyToReport(admin, docId, "   ").assignment).toBeNull();
  });

  it('"merge" reply prefixes the merge instruction', async () => {
    const { world, admin, docId } = await setup();
    const { assignment } = world.ops.replyToReport(admin, docId, "Merge");
    expect(assignment!.description.startsWith(MERGE_INSTRUCTION)).toBe(true);
    const { world: w2, admin: a2, docId: d2 } = await setup();
    expect(w2.ops.replyToReport(a2, d2, "merge it, then stop").assignment!.description).toContain("gh pr merge <n> --squash --delete-branch");
  });

  it("revives a stopped author; a retired author gets no assignment but the reply is recorded", async () => {
    const { world, admin, mei, docId } = await setup();
    world.ops.stopAgent(admin, mei.id);
    world.ops.replyToReport(admin, docId, "Keep going");
    expect(world.agents.require(mei.id).status).toBe("idle");

    const s = await setup();
    s.world.ops.dismissAgent(s.admin, s.mei.id);
    const r = s.world.ops.replyToReport(s.admin, s.docId, "Too late");
    expect(r.assignment).toBeNull();
    expect(r.doc.body).toContain("Too late");
    expect(r.doc.decision).toBe("approve");
  });

  it("needs building.review", async () => {
    const { world, by, docId } = await setup();
    expect(() => world.ops.replyToReport(by("Tomas"), docId, "hi")).toThrow(/building.review/);
  });
});
