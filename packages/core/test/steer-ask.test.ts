/**
 * The decision queue's Steer button (Mitchell, 1:1 mt_mjxwzdhhd7): a human opens their 1:1 with the manager of the
 * building that filed an ask, about that ask. The human's first line presents the ask and its job; the 1:1's focus is
 * the ask, so every line the human says reaches the manager with the ask and the last entries of its job thread.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, createBuilding, createOneOnOne, focusBlock, managerAgentOf } from "../src/index.ts";
import { askAt, creditBank, seededWorld, renderNeeds } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  const g = askAt(world, world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, {
    keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective: "Banner shows Usage", approach: "a banner line", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 350_000,
  }).id), 350_000);
  renderNeeds(world, manager.id);
  const ask = world.asks.first("targetKind = 'grant' AND targetId = ?", [g.id])!;
  return { ...s, manager, g, ask };
}

describe("Steer: a 1:1 with the filing building's manager about an ask", () => {
  it("presents the ask and its job, focuses the 1:1 on it, and carries the job thread with each line", () => {
    const { world, admin, ask } = setup();
    const m = createOneOnOne(world, admin, LAB, { askId: ask.id });
    expect(m.facilitatorId).toBe(managerAgentOf(world, world.buildings.require(LAB, "building"))!.id);
    expect(m.focus).toMatchObject({ kind: "ask", id: ask.id });
    const first = m.transcript.find((u) => u.speakerKind === "user")!;
    expect(first.text).toContain(`(${ask.id})`);
    expect(first.text).toMatch(/on job jb_\S+ \(its thread: GET \/api\/jobs\/jb_/);
    const block = focusBlock(world, m);
    expect(block).toContain(`Ask ${ask.id}`);
    expect(block).toMatch(/\nJob jb_\S+ ".*" \(\w+\): its thread has \d+ entr/);
    expect(block).toMatch(/\n- #1 /);
    // returning to the same 1:1 about the same ask says it once
    const again = createOneOnOne(world, admin, LAB, { askId: ask.id });
    expect(again.id).toBe(m.id);
    expect(again.transcript.filter((u) => u.speakerKind === "user" && u.text.includes(`(${ask.id})`))).toHaveLength(1);
  });

  it("refuses an ask another building filed, and an unknown ask", () => {
    const { world, admin, ask, seed } = setup();
    const other = createBuilding(world, { name: "Other" }, seed.admin.id);
    expect(() => createOneOnOne(world, admin, other.id, { askId: ask.id })).toThrow(/filed by another building/);
    expect(() => createOneOnOne(world, admin, LAB, { askId: "ak_nope" })).toThrow(/Ask/);
  });
});
