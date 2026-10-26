import { describe, expect, it } from "vitest";
import { buildingRoleId, sessionMemory } from "../src/index.ts";
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

describe("managers write key results (1:1 mt_ayi4y9ybyj)", () => {
  it("the building's manager creates and edits its own goal's KRs; residents, other buildings and deletes stay refused", async () => {
    const { world, mei, noor, admin, notes, other } = setup();
    const r = await world.verbs.set_key_result(mei, { ...KR, sourceDocIds: [notes.id] });
    const kr = world.keyResults.require(r.keyResult.id);
    expect(kr).toMatchObject({ buildingId: LAB, createdBy: mei.id, editedBy: null, sourceDocIds: [notes.id], status: "not-started" });
    await expect(world.verbs.set_key_result(mei, KR)).rejects.toThrow(/sourceDocIds/);
    await expect(world.verbs.set_key_result(mei, { ...KR, sourceDocIds: ["dc_nope"] })).rejects.toThrow(/not a published document/);
    await expect(world.verbs.set_key_result(noor, { ...KR, sourceDocIds: [notes.id] })).rejects.toThrow(/manager writes/);
    await expect(world.verbs.set_key_result(mei, { ...KR, buildingId: other.id, sourceDocIds: [notes.id] })).rejects.toThrow(/manager writes/);
    const ed = await world.verbs.set_key_result(mei, { id: kr.id, howToCheck: "Open the banner, Usage line" });
    expect(world.keyResults.require(ed.keyResult.id)).toMatchObject({ howToCheck: "Open the banner, Usage line", createdBy: mei.id, editedBy: mei.id });
    await expect(world.verbs.set_key_result(mei, { id: kr.id, buildingId: other.id, text: "x" })).rejects.toThrow(/not a key result/);
    // status: up to claimed only; met / missed and delete stay human
    expect(() => world.grantDesk.updateKeyResult(mei, kr.id, { status: "met" })).toThrow(/building.fund/);
    expect(() => world.grantDesk.deleteKeyResult(mei, kr.id)).toThrow(/Only a human/);
    // humans keep everything; the view names who wrote and edited it
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Sharper" });
    const view = world.grantDesk.keyResults(LAB).find((k) => k.id === kr.id)!;
    expect(view).toMatchObject({ createdByName: "Mei", editedByName: world.nameOf(admin.ownerUserId!) });
    world.grantDesk.deleteKeyResult(admin, kr.id);
    expect(world.keyResults.get(kr.id)).toBeUndefined();
  });

  it("kr.created / kr.updated events carry the actor; the manager's next rollup lists what it wrote, then the one after doesn't", async () => {
    const { world, mei, notes } = setup();
    const r = await world.verbs.set_key_result(mei, { ...KR, sourceDocIds: [notes.id] });
    await world.verbs.set_key_result(mei, { id: r.keyResult.id, text: "Visitors see today's spend" });
    world.grantDesk.updateKeyResult(mei, r.keyResult.id, { status: "on-track" }); // status only: not an edit
    const evs = world.events.list({ types: ["kr.created", "kr.updated"], buildingId: LAB });
    expect(evs.map((e) => [e.type, e.agentId, e.payload.by, e.payload.byKind])).toEqual([
      ["kr.created", mei.id, mei.id, "agent"], ["kr.updated", mei.id, mei.id, "agent"], ["kr.updated", mei.id, mei.id, "agent"],
    ]);
    expect(evs.map((e) => e.payload.edited)).toEqual([undefined, true, false]);
    expect(world.grantDesk.writtenSinceRollup(mei.id, LAB).map((w) => w.action)).toEqual(["created", "edited"]);
    // the in-tray block tells the manager; a rollup with no covered reports is fine when it lists KR writes
    const b = world.buildings.require(LAB);
    expect(sessionMemory(world, mei, b).team).toContain(`created ${r.keyResult.id}`);
    const up = await world.verbs.submit_report(mei, { title: "KRs from the 1:1", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx\n## Needs from Mitchell\nKeep or cut them.", verdict: "continue", rollup: true });
    const body = world.docs.require(up.id).body;
    expect(body).toContain("## Key results I wrote");
    expect(body).toContain(`- created ${r.keyResult.id}: "${KR.text}" (how to check: ${KR.howToCheck}; from ${notes.id})`);
    expect(body).toContain(`- edited ${r.keyResult.id}: "Visitors see today's spend"`);
    expect(world.grantDesk.writtenSinceRollup(mei.id, LAB)).toEqual([]);
    await expect(world.verbs.submit_report(mei, { title: "Again", body: "x", verdict: "continue", rollup: true })).rejects.toThrow(/sourceIds/);
  });
});
