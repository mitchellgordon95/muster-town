import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const KR = { text: "A visitor can see today's spend on the banner", howToCheck: "Open the lab banner, read Usage" };

/** Mei is the lab's manager agent; Noor a resident; a published meeting-notes doc is what a KR comes from. */
function setup() {
  const s = seededWorld();
  const { world, by, admin } = s;
  const mei = by("Mei"), noor = by("Noor");
  world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
  world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
  const notes = world.docs.upsert({ ...world.docs.first("1 = 1")!, id: "dc_notes1", type: "meeting-notes", state: "building", buildingId: LAB, title: "1:1 notes", body: "KR: banner" });
  const other = world.buildings.first("id != ?", [LAB])!; // the town hall: another building
  return { ...s, mei, noor, notes, other };
}

describe("managers write key results through their grants (docs/how-work-gets-done.md §4)", () => {
  it("the manager's grant carries its KRs; the manager edits them; residents, met/missed and deletes stay refused", async () => {
    const { world, mei, noor, admin, notes } = setup();
    const r = await world.verbs.propose_grant(mei, { keyResults: [KR], objective: "Spend on the banner", stopCondition: "s", askTokens: 1000, findingsDocIds: [notes.id] });
    const kr = world.keyResults.require(world.grants.require(r.grantId).keyResultId!);
    expect(kr).toMatchObject({ buildingId: LAB, grantId: r.grantId, createdBy: mei.id, editedBy: null, status: "not-started", text: KR.text });
    await expect(world.verbs.propose_grant(noor, { keyResults: [KR], objective: "o", stopCondition: "s", askTokens: 1000 })).rejects.toThrow();
    world.grantDesk.updateKeyResult(mei, kr.id, { howToCheck: "Open the banner, Usage line" });
    expect(world.keyResults.require(kr.id)).toMatchObject({ howToCheck: "Open the banner, Usage line", createdBy: mei.id, editedBy: mei.id });
    // status: up to claimed only; met / missed and delete stay human
    expect(() => world.grantDesk.updateKeyResult(mei, kr.id, { status: "met" })).toThrow(/building.fund/);
    expect(() => world.grantDesk.deleteKeyResult(mei, kr.id)).toThrow(/Only a human/);
    // humans keep everything; the view names who wrote and edited it
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Sharper" });
    const view = world.grantDesk.keyResults(LAB).find((k) => k.id === kr.id)!;
    expect(view).toMatchObject({ createdByName: "Mei", editedByName: world.nameOf(admin.ownerUserId!) });
    // a human deletes it only once its grant is closed
    expect(() => world.grantDesk.deleteKeyResult(admin, kr.id)).toThrow(/close the grant first/);
    world.grantDesk.decide(admin, r.grantId, { action: "reject", note: "not now" });
    world.grantDesk.deleteKeyResult(admin, kr.id);
    expect(world.keyResults.get(kr.id)).toBeUndefined();
  });

  it("set_key_result and propose_key_result are gone", () => {
    const { world } = setup();
    expect(world.verbs).not.toHaveProperty("set_key_result");
    expect(world.verbs).not.toHaveProperty("propose_key_result");
  });
});
