import { describe, expect, it } from "vitest";
import { boardWithTownDocs, buildingRoleId, sessionMemory, unpublishTownFyi, workSystemPrompt, TOWN_HALL_ID } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

describe("Town Hall board (town-wide FYIs)", () => {
  it("managers and admins post to the Town Hall board; it shows first, marked town-wide, on every building's board and in the brief", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human' AND id != ?", [LAB, mei.id])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    // a member can't post a town-wide FYI, and buildingId is only for FYIs
    await expect(world.verbs.write(mei, { type: "fyi", title: "rule", body: "x", state: "building", buildingId: TOWN_HALL_ID })).rejects.toThrow(/Town Hall board/);
    await expect(world.verbs.write(mei, { type: "note", title: "n", body: "x", state: "building", buildingId: TOWN_HALL_ID })).rejects.toThrow(/only for FYIs/);
    const own = await world.verbs.write(mei, { type: "fyi", title: "lab fyi", body: "x", state: "building" });
    const rule = await world.verbs.write(manager, { type: "fyi", title: "Merge rules", body: "Commit straight to main.", state: "building", buildingId: TOWN_HALL_ID });
    expect(world.docs.get(rule.id)!.buildingId).toBe(TOWN_HALL_ID);
    const byAdmin = await world.verbs.write(admin, { type: "fyi", title: "Admin rule", body: "y", state: "building", buildingId: TOWN_HALL_ID });

    const board = await world.verbs.board(mei, { limit: 20 });
    expect(board.docs.map((d) => d.id)).toEqual([byAdmin.id, rule.id, own.id]);
    expect(board.docs[0]).toMatchObject({ townWide: true, from: "Town Hall" });
    expect(board.docs[2]).not.toHaveProperty("townWide");
    // the Town Hall's own board isn't doubled
    expect(boardWithTownDocs(world, TOWN_HALL_ID, 20).map((d) => d.id)).toEqual([byAdmin.id, rule.id]);

    const b = world.buildings.require(LAB, "building");
    const prompt = workSystemPrompt(mei, b, world.town.get(), sessionMemory(world, mei, b));
    expect(prompt).toContain("Town-wide FYIs");
    expect(prompt).toContain("Commit straight to main.");
  });

  it("no Town Hall FYIs: no brief block", () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const b = world.buildings.require(LAB, "building");
    expect(workSystemPrompt(mei, b, world.town.get(), sessionMemory(world, mei, b))).not.toContain("Town-wide FYIs");
  });

  it("the Town Hall has a board place everyone sees in `look`", async () => {
    const { world, by } = seededWorld();
    const place = world.layout.places.find((p) => p.id === `board:${TOWN_HALL_ID}`);
    expect(place).toMatchObject({ kind: "board", buildingId: TOWN_HALL_ID });
    const look = await world.verbs.look(by("Mei"), {});
    expect(look.places.map((p: { id: string }) => p.id)).toContain(`board:${TOWN_HALL_ID}`);
  });

  it("its author or an admin takes a town-wide FYI off the board; it goes back to the author's drafts", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const manager = world.agents.first("homeBuildingId = ? AND kind != 'human' AND id != ?", [LAB, mei.id])!;
    world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
    const a = await world.verbs.write(manager, { type: "fyi", title: "Old rule", body: "stale", state: "building", buildingId: TOWN_HALL_ID });
    const b = await world.verbs.write(manager, { type: "fyi", title: "Other rule", body: "x", state: "building", buildingId: TOWN_HALL_ID });
    expect(() => unpublishTownFyi(world, mei, a.id)).toThrow(/author or a town admin/);
    const own = await world.verbs.write(mei, { type: "fyi", title: "lab fyi", body: "x", state: "building" });
    expect(() => unpublishTownFyi(world, mei, own.id)).toThrow(/Town Hall board/);
    expect(unpublishTownFyi(world, manager, a.id).state).toBe("draft");
    expect(unpublishTownFyi(world, admin, b.id).state).toBe("draft");
    expect(boardWithTownDocs(world, LAB, 20).map((d) => d.id)).toEqual([own.id]);
    expect(() => unpublishTownFyi(world, manager, a.id)).toThrow(/Town Hall board/);
  });
});
