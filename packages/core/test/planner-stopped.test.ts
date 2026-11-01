import { describe, expect, it } from "vitest";
import { createUser } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

/**
 * Mitchell's flag dc_roz7gfvzt2 (2026-11-01): he pressed Stop on the working Planner (2026-10-31 17:37:22Z), and every
 * Town Hall 1:1 after that failed with "Planner can't take a 1:1 and Town Hall has no manager agent". A 1:1 at the
 * Town Hall always reaches the Planner, resuming it; whoever plans with it may Resume it; Stop and Resume say who.
 */
describe("a stopped Planner (flag dc_roz7gfvzt2)", () => {
  it("a Town Hall 1:1 resumes the stopped Planner instead of failing with 'has no manager agent'", () => {
    const { world, admin } = seededWorld();
    const planner = world.reorgs.ensurePlanner();
    world.ops.stopAgent(admin, planner.id);
    expect(world.agents.require(planner.id).status).toBe("stopped");
    // by the building (the 1:1 button), by the Planner's id (its report's "Talk to"), and "Plan with an agent"
    const m = world.ops.openOneOnOne(admin, "town-hall");
    expect(m).toMatchObject({ kind: "one-on-one", buildingId: "town-hall", facilitatorId: planner.id });
    expect(world.agents.require(planner.id).status).toBe("idle");
    world.ops.stopAgent(admin, planner.id);
    expect(world.ops.openOneOnOne(admin, "town-hall", { agentId: planner.id }).id).toBe(m.id);
    expect(world.agents.require(planner.id).status).toBe("idle");
    world.ops.stopAgent(admin, planner.id);
    expect(world.reorgs.openPlanner(admin).id).toBe(m.id);
    expect(world.agents.require(planner.id).status).toBe("idle");
    // still the Planner and the Town Hall's manager: no second Planner
    expect(world.agents.where("homeBuildingId = 'town-hall' AND title = 'Planner'", [])).toHaveLength(1);
    expect(world.buildings.require("town-hall").managerAgentId).toBe(planner.id);
  });

  it("someone who can't plan doesn't resume it by asking for a 1:1", () => {
    const { world, admin } = seededWorld();
    const planner = world.reorgs.ensurePlanner();
    world.ops.stopAgent(admin, planner.id);
    const stranger = world.ops.ensureAvatar(createUser(world, "Stranger").user.id);
    expect(() => world.ops.openOneOnOne(stranger, "town-hall")).toThrow();
    expect(world.agents.require(planner.id).status).toBe("stopped");
    expect(() => world.ops.resumeAgent(stranger, planner.id)).toThrow(/building.assign/);
  });

  it("a goal's captain may Resume the Planner (the Town Hall has no roles); Stop and Resume record who", () => {
    const { world, admin } = seededWorld();
    const planner = world.reorgs.ensurePlanner();
    const cap = createUser(world, "Captain").user;
    const capAvatar = world.ops.ensureAvatar(cap.id);
    const goal = world.goalTree.create(admin, { parentId: "gl_trust", text: "Captained" });
    world.goals.upsert({ ...world.goals.require(goal.id), ownerId: cap.id });
    world.ops.stopAgent(admin, planner.id);
    expect(world.ops.resumeAgent(capAvatar, planner.id).status).toBe("idle");
    const ev = world.events.recent({ agentId: planner.id, limit: 20 }).filter((e) => e.type === "agent.status");
    const stop = ev.find((e) => e.payload.status === "stopped")!;
    const resume = ev.find((e) => e.text.endsWith("was resumed"))!;
    expect(stop.payload.by).toEqual({ kind: "user", id: world.holderOf(admin).id });
    expect(resume.payload.by).toEqual({ kind: "user", id: cap.id });
  });
});
