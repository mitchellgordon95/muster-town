import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

describe("agent model: owner, admin or home-building manager picks it; null = building default", () => {
  it("a manager sets and clears a resident's model; a stranger can't", () => {
    const { world, admin } = seededWorld();
    const r = world.agents.where("kind = 'resident' AND homeBuildingId = ?", [LAB])[0];
    const mgr = world.ops.createUser("Mgr").user;
    world.permissions.grant({ kind: "user", id: mgr.id }, buildingRoleId(LAB, "manager"));
    const mgrAvatar = world.ops.ensureAvatar(mgr.id);
    const stranger = world.ops.ensureAvatar(world.ops.createUser("Stranger").user.id);
    expect(world.ops.canSetModel(stranger, r)).toBe(false);
    expect(() => world.ops.setAgentModel(stranger, r.id, "claude-haiku-5-5")).toThrow();
    expect(world.ops.canSetModel(mgrAvatar, r)).toBe(true);
    expect(world.ops.setAgentModel(mgrAvatar, r.id, " claude-sonnet-5-5 ").model).toBe("claude-sonnet-5-5");
    expect(world.agents.require(r.id, "agent").model).toBe("claude-sonnet-5-5");
    expect(world.ops.setAgentModel(admin, r.id, null).model).toBeNull();
  });

  it("a visitor's owner may set its model", () => {
    const { world } = seededWorld();
    const owner = world.ops.createUser("Owner").user;
    const v = world.ops.registerVisitor(owner.id, { name: "V" }).agent;
    expect(world.ops.setAgentModel(world.ops.ensureAvatar(owner.id), v.id, "claude-fable-5-1").model).toBe("claude-fable-5-1");
  });
});
