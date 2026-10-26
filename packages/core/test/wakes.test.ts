import { describe, expect, it } from "vitest";
import { buildingRoleId, intrayOf, managerIntrayRow } from "../src/index.ts";
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
  const kr = world.grantDesk.createKeyResult(admin, LAB, { text: "Visitors can read the goal", howToCheck: "Open the board" });
  const g = world.grantDesk.create(manager, LAB, { keyResultId: kr.id, objective: "Goal on the board", approach: "a line", stopCondition: "two tries", askTokens: 10_000_000, testingPlan: [] });
  const funded = world.grantDesk.decide(admin, world.grantDesk.propose(manager, g.id).id, { action: "fund" });
  world.grants.patch(funded.id, { status: "checkpoint", checkpointsDone: [0.5] });
  const last = (type: string): Event => world.events.list({ buildingId: LAB, types: [type as never], limit: 1000 }).at(-1)!;
  const rows = () => world.docs.where("authorId = 'system' AND buildingId = ? AND type = 'report'", [LAB]);
  return { ...s, manager, kr, grant: funded, last, rows };
}

describe("manager in-tray rows for grant and key-result events (docs/wakes.md step 3)", () => {
  it("a human continuing a grant writes one town row in the in-tray; delivering the event again writes nothing", () => {
    const { world, admin, grant, last, rows } = setup();
    world.grantDesk.decide(admin, grant.id, { action: "continue", note: "keep going" });
    const e = last("grant.funded");
    expect(e.payload).toMatchObject({ grantId: grant.id, action: "continue" });
    const row = managerIntrayRow(world, e)!;
    expect(row).toMatchObject({ type: "report", decision: "pending", buildingId: LAB, authorId: "system", state: "building" });
    expect(row.title).toBe(`Grant ${grant.id} continued: 10,000,000 tokens`);
    expect(row.body).toContain("keep going");
    expect(world.nameOf(row.authorId)).toBe("Town");
    expect(intrayOf(world, LAB).map((d) => d.id)).toContain(row.id);
    expect(managerIntrayRow(world, e)).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it("fund, counter and reject already wake the manager with an assignment: no row", () => {
    const { world, last, rows } = setup();
    expect(last("grant.funded").payload).toMatchObject({ action: "fund" });
    expect(managerIntrayRow(world, last("grant.funded"))).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it("a cut grant and a human's key-result edits each write a row; the manager's own edits and status marks don't", () => {
    const { world, admin, manager, kr, grant, last, rows } = setup();
    world.grantDesk.decide(admin, grant.id, { action: "cut", note: "not worth it" });
    expect(managerIntrayRow(world, last("grant.closed"))!.title).toBe(`Grant ${grant.id} cut`);
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Visitors can read the goal in one glance" });
    expect(managerIntrayRow(world, last("kr.updated"))!.title).toMatch(new RegExp(`^Key result ${kr.id} edited by `));
    world.grantDesk.createKeyResult(admin, LAB, { text: "Second", howToCheck: "Look" });
    expect(managerIntrayRow(world, last("kr.created"))!.body).toContain("How to check: Look");
    // the manager (an agent) writing or marking a key result is not a human event
    world.grantDesk.updateKeyResult(manager, kr.id, { status: "on-track" });
    expect(managerIntrayRow(world, last("kr.updated"))).toBeNull();
    world.grantDesk.createKeyResult(manager, LAB, { text: "Third", howToCheck: "Look again", sourceDocIds: [] });
    expect(managerIntrayRow(world, last("kr.created"))).toBeNull();
    expect(rows()).toHaveLength(3);
  });

  it("a building without an agent manager gets no row (a human works its in-tray)", () => {
    const { world, admin, kr, last, rows } = setup();
    world.buildings.patch(LAB, { managerAgentId: null });
    world.grantDesk.updateKeyResult(admin, kr.id, { text: "Changed" });
    expect(managerIntrayRow(world, last("kr.updated"))).toBeNull();
    expect(rows()).toHaveLength(0);
  });
});
