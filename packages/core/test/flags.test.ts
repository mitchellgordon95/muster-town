import { describe, expect, it } from "vitest";
import { intrayCounts, intrayOf, managerIntrayBlock, townHallIntray } from "../src/index.ts";
import { buildingRoleId } from "../src/permissions.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** Plant a flag (town hall 2026-10-25, "Pix builds it"): a human's quick request lands in the building in-tray; the manager delegates it. */
describe("plant a flag", () => {
  function managed() {
    const s = seededWorld();
    const manager = s.by("Mei");
    s.world.ops.updateBuilding(s.admin, LAB, { managerAgentId: manager.id, budgetMode: "goal-directed" });
    s.world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    return { ...s, manager };
  }

  it("a human plants it; it is a pending flag doc in the building in-tray, not the Town Hall's; agents can't plant", () => {
    const { world, admin, by, manager } = managed();
    const before = intrayCounts(world).get(LAB) ?? 0; // the seeded lab's own pending reports
    const flag = world.ops.plantFlag(admin, LAB, "Fix the banner typo\nThe lab banner says 'Carbon Cylce'.");
    expect(flag).toMatchObject({ type: "flag", state: "building", decision: "pending", buildingId: LAB, title: "Fix the banner typo", authorKind: "user" });
    expect(intrayOf(world, LAB).map((d) => d.id)).toContain(flag.id);
    expect(townHallIntray(world).reports.map((d) => d.id)).not.toContain(flag.id);
    expect(intrayCounts(world).get(LAB)).toBe(before + 1);
    const ev = world.events.list({ types: ["doc.created"] }).at(-1)!;
    expect(ev.payload).toMatchObject({ docId: flag.id, docType: "flag" });
    expect(managerIntrayBlock(world, world.buildings.require(LAB), manager.id)).toMatch(/FLAG by .*Fix the banner typo/);
    expect(() => world.ops.plantFlag(by("Moss"), LAB, "nope")).toThrow(/Only a human/);
    expect(() => world.ops.plantFlag(admin, LAB, "   ")).toThrow(/needs a note/);
    expect(() => world.ops.plantFlag(admin, "town-hall", "nope")).toThrow(/Town Hall/);
  });

  it("the manager delegates it with review + assigneeId: continue = the flag verbatim, redirect = the note; directed lane even in a goal-directed building", async () => {
    const { world, admin, by, manager } = managed();
    const flag = world.ops.plantFlag(admin, LAB, "Fix the banner typo");
    await expect(world.verbs.review(manager, { docId: flag.id, decision: "continue", note: "" })).rejects.toThrow(/assigneeId/);
    await expect(world.verbs.review(manager, { docId: flag.id, decision: "stop", note: "" })).rejects.toThrow(/no agent to stop/);
    await expect(world.verbs.review(manager, { docId: flag.id, decision: "continue", note: "", assigneeId: admin.id })).rejects.toThrow(/not a resident/);
    const r = await world.verbs.review(manager, { docId: flag.id, decision: "continue", note: "", assigneeId: by("Moss").id });
    const a = world.assignments.require(r.assignmentId!);
    expect(a).toMatchObject({ agentId: by("Moss").id, title: "Fix the banner typo", lane: "directed", fromReportId: flag.id, status: "pending" });
    expect(a.description).toContain("planted a flag");
    expect(world.docs.require(flag.id).decision).toBe("continue");
    await expect(world.verbs.review(manager, { docId: flag.id, decision: "approve", note: "" })).rejects.toThrow(/already decided/);

    const flag2 = world.ops.plantFlag(admin, LAB, "Check the board loads");
    const r2 = await world.verbs.review(manager, { docId: flag2.id, decision: "redirect", note: "Open the board and report what you see", assigneeId: by("Noor").id });
    const a2 = world.assignments.require(r2.assignmentId!);
    expect(a2).toMatchObject({ agentId: by("Noor").id, title: "Open the board and report what you see", lane: "directed" });
    expect(a2.description).toContain("Check the board loads");

    const flag3 = world.ops.plantFlag(admin, LAB, "Nothing to do here");
    const r3 = await world.verbs.review(manager, { docId: flag3.id, decision: "approve", note: "already done" });
    expect(r3.assignmentId).toBeNull();
    expect(intrayOf(world, LAB).filter((d) => d.type === "flag")).toHaveLength(0);
  });
});
