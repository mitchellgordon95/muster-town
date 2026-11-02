import { describe, expect, test } from "vitest";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { cleanBuildingName } from "../src/naming.ts";
import { result, setup, text } from "./helpers.ts";

/** A goal under the root and a building made for it the way POST /api/buildings does (no name typed: the goal's short text). */
function goalAndBuilding(world: ReturnType<typeof setup>["world"], words = "People who would use Muster Town know that it exists") {
  const goal = world.goalTree.create(null, { parentId: ROOT_GOAL_ID, text: words });
  const building = world.ops.createBuilding(null, { goalId: goal.id, headcount: 1 });
  return { goal, building };
}

describe("naming a new building (flag dc_42c9cjbzls)", () => {
  test("the cheap model's answer renames it; the call is one booked session on its manager, on the building's cheapModel", async () => {
    const { world, runtime, sdk } = setup(async function* (s) {
      if (!s.agentId) { yield text("\"Outreach\""); yield result(30, 0.0001, "\"Outreach\""); }
    });
    const { building } = goalAndBuilding(world);
    expect(building.name).toBe("People who would use Muster Town know…");
    const named = await runtime.nameBuilding(building.id);
    expect(named.name).toBe("Outreach");
    expect(world.buildings.require(building.id).name).toBe("Outreach");
    const calls = sdk.sessions.filter((s) => !s.agentId);
    expect(calls).toHaveLength(1);
    expect(calls[0].options.model).toBe(building.cheapModel);
    expect(calls[0].received[0]).toContain("People who would use Muster Town know that it exists");
    const session = world.sessions.first("purpose = 'naming'")!;
    expect(session.agentId).toBe(building.managerAgentId);
    expect(session.status).toBe("done");
    expect(session.tokens).toBeGreaterThan(0);
  });

  test("a failed call keeps the goal's short text and records the error", async () => {
    const { world, runtime } = setup(async function* (s) {
      if (!s.agentId) { yield text("Not logged in"); yield { ...result(0, 0, "Not logged in"), subtype: "error_during_execution", is_error: true }; }
    });
    const { building } = goalAndBuilding(world);
    const named = await runtime.nameBuilding(building.id);
    expect(named.name).toBe(building.name);
    expect(world.sessions.first("purpose = 'naming'")!.status).toBe("error");
  });

  test("an unusable answer (a sentence) keeps the goal's short text", async () => {
    const { world, runtime } = setup(async function* (s) {
      if (!s.agentId) { const t = "Sure! A good name for this building would be the Outreach Center of Muster Town."; yield text(t); yield result(30, 0, t); }
    });
    const { building } = goalAndBuilding(world);
    expect((await runtime.nameBuilding(building.id)).name).toBe(building.name);
  });

  test("a Bank that can't run it makes no call and keeps the goal's short text", async () => {
    const { world, seed, runtime, sdk } = setup(async function* (s) {
      if (!s.agentId) { yield text("Outreach"); yield result(30, 0, "Outreach"); }
    });
    world.bank.cancelInput(seed.admin.id, world.bank.subscriptionInput()!.id);
    const { building } = goalAndBuilding(world);
    expect((await runtime.nameBuilding(building.id)).name).toBe(building.name);
    expect(sdk.sessions.filter((s) => !s.agentId)).toHaveLength(0);
  });

  test("cleanBuildingName keeps short place names and refuses the rest", () => {
    expect(cleanBuildingName("Bank Transparency")).toBe("Bank Transparency");
    expect(cleanBuildingName("**Onboarding**\n")).toBe("Onboarding");
    expect(cleanBuildingName("Name: “Prod”.")).toBe("Prod");
    expect(cleanBuildingName("")).toBeNull();
    expect(cleanBuildingName("The Building That Explains Muster Town To Strangers")).toBeNull();
    expect(cleanBuildingName("Outreach? Or maybe Reach")).toBeNull();
  });
});
