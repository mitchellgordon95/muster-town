import { describe, expect, it } from "vitest";
import { buildingRoleId, jobThread, keyResultEntry, managerQueue, openManagerEntries } from "../src/index.ts";
import type { Event } from "@muster-town/schema";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

/** Seeded lab with an agent manager, one key result written by the admin, and a grant on it funded and at its checkpoint. */
function setup() {
  const s = seededWorld();
  const { world, admin } = s;
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  world.buildings.patch(LAB, { managerAgentId: manager.id });
  const g = world.grantDesk.create(manager, LAB, { keyResults: [{ text: "Visitors can read the goal", howToCheck: "Open the board" }], objective: "Goal on the board", approach: "a line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two tries", askTokens: 10_000_000 });
  const kr = world.keyResults.require(g.keyResultId!);
  const funded = world.grantDesk.decide(admin, world.grantDesk.propose(manager, g.id).id, { action: "fund", tokens: 10_000_000 });
  world.grants.patch(funded.id, { status: "checkpoint", checkpointsDone: [0.5] });
  const last = (type: string): Event => world.events.list({ buildingId: LAB, types: [type as never], limit: 1000 }).at(-1)!;
  /** town-written report docs in the lab: the loop writes none (kr_o8dbx2axii) */
  const rows = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report'", [LAB]);
  const thread = () => jobThread(world, funded.id)!.entries;
  return { ...s, manager, kr, grant: funded, last, rows, thread };
}

describe("a human's grant and key-result decisions are entries on the job's thread (plan dc_uwx045472m step 5)", () => {
  it("continuing a grant is a human entry that asks no move: on the thread, not in the manager's queue, and no report doc", () => {
    const { world, admin, grant, rows, thread } = setup();
    world.grantDesk.decide(admin, grant.id, { action: "continue", note: "keep going" });
    const e = thread().at(-1)!;
    expect(e).toMatchObject({ authorKind: "human", level: "none", note: "keep going", moved: { kind: "decision", action: "continue" } });
    expect(openManagerEntries(world, LAB)).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("fund asks no move of the manager either: the plan's first step is queued by the code", () => {
    const { world, rows, thread } = setup();
    expect(thread().find((e) => e.moved.action === "fund")).toMatchObject({ authorKind: "human", level: "none" });
    expect(openManagerEntries(world, LAB)).toEqual([]);
    expect(rows()).toHaveLength(0);
  });

  it("a cut waits for the manager as an entry, announced once; a human's key-result edit is a record; the manager's own marks write nothing", () => {
    const { world, admin, manager, kr, grant, last, rows } = setup();
    world.grantDesk.decide(admin, grant.id, { action: "cut", note: "not worth it" });
    const [cut] = openManagerEntries(world, LAB);
    expect(cut).toMatchObject({ jobId: `jb_${grant.id}`, authorKind: "human", level: "manager", note: "not worth it", docId: null, moved: { kind: "decision", action: "cut" } });
    expect(world.events.list({ buildingId: LAB, types: ["entry.created"], limit: 100 }).filter((e) => e.payload.entryId === cut!.id)).toHaveLength(1);
    expect(managerQueue(world, LAB).map((x) => x.id)).toContain(cut!.id);
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Visitors can read the goal in one glance" });
    const edited = keyResultEntry(world, last("kr.updated"))!;
    expect(edited).toMatchObject({ jobId: `jb_${grant.id}`, authorKind: "human", level: "none", moved: { kind: "decision", action: "edited", keyResultId: kr.id } });
    expect(edited.note).toMatch(new RegExp(`^Key result ${kr.id} edited by `));
    // the same event delivered again writes nothing
    expect(keyResultEntry(world, last("kr.updated"))).toBeNull();
    // the manager (an agent) marking a key result is not a human event
    world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" });
    expect(keyResultEntry(world, last("kr.updated"))).toBeNull();
    expect(openManagerEntries(world, LAB).map((e) => e.id)).toEqual([cut!.id]);
    expect(rows()).toHaveLength(0);
  });

  it("a key result a human marks missed waits for the manager; marked met it is a record", () => {
    const { world, admin, kr, grant, last } = setup();
    world.grantDesk.updateKeyResult(admin, kr.id, { status: "missed", note: "the board is blank" });
    const missed = keyResultEntry(world, last("kr.updated"))!;
    expect(missed).toMatchObject({ jobId: `jb_${grant.id}`, level: "manager", moved: { action: "marked", status: "missed" } });
    expect(missed.body).toContain("the board is blank");
    expect(openManagerEntries(world, LAB).map((e) => e.id)).toEqual([missed.id]);
  });

  it("re-marking a key result with its current status and no note is a no-op: no kr.updated, no entry", () => {
    const { world, admin, kr, rows } = setup();
    const count = () => world.events.list({ buildingId: LAB, types: ["kr.updated"], limit: 1000 }).length;
    const before = count();
    expect(world.grantDesk.updateKeyResult(admin, kr.id, { status: kr.status })).toEqual(world.keyResults.get(kr.id));
    expect(count()).toBe(before);
    // the same status with a new note is evidence: a real update
    world.grantDesk.updateKeyResult(admin, kr.id, { status: kr.status, note: "still on it" });
    expect(count()).toBe(before + 1);
    expect(world.keyResults.get(kr.id)!.statusNote).toBe("still on it");
    expect(rows()).toHaveLength(0);
  });

  it("a key result moved in the goal tree says moved, not marked with its unchanged status (events 69772, 69781)", () => {
    const { world, admin, kr, last } = setup();
    const to = world.goalTree.create(admin, { parentId: "gl_join", text: "Somewhere else" });
    world.goalTree.moveKr(admin, world.keyResults.get(kr.id)!, to.id);
    const entry = keyResultEntry(world, last("kr.updated"))!;
    expect(entry.note).toMatch(new RegExp(`^Key result ${kr.id} moved by `));
    expect(entry.body).toContain(`Now under goal ${to.id}: Somewhere else`);
    expect(entry.body).toContain("Status unchanged");
    expect(entry.level).toBe("none");
  });

  it("a building without an agent manager gets no entry (a human works its in-tray)", () => {
    const { world, admin, kr, last } = setup();
    world.buildings.patch(LAB, { managerAgentId: null });
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Changed" });
    expect(keyResultEntry(world, last("kr.updated"))).toBeNull();
  });
});
