import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GHOST_AFTER_MS, ghostVisitors, keepsVisitor } from "../src/ghost-visitors.ts";
import { createBuilding, townRoleId } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const NOW = Date.parse("2026-11-16T18:00:00.000Z");
const STATUSES = ["idle", "working", "walking", "offline", "stopped", "banned", "retired", "out-of-budget"] as const;

const agents = fc.array(fc.record({
  kind: fc.constantFrom("visitor", "resident", "fork", "human"),
  status: fc.constantFrom(...STATUSES),
  quietMs: fc.integer({ min: 0, max: 3 * GHOST_AFTER_MS }),
  seen: fc.boolean(),
  manages: fc.boolean(),
  holdsRole: fc.boolean(),
}), { maxLength: 20 }).map((rows) => rows.map((r, i) => {
  const at = new Date(NOW - r.quietMs).toISOString();
  return { ...r, id: `ag_${i}`, lastSeenAt: r.seen ? at : null, createdAt: r.seen ? new Date(NOW - 10 * GHOST_AFTER_MS).toISOString() : at };
}));

describe("ghost visitors: the pure rule", () => {
  it("retires exactly the offline visitors quiet for 7 days or more that manage no building and hold no town role", () => {
    fc.assert(fc.property(agents, (rows) => {
      const managers = new Set(rows.filter((r) => r.manages).map((r) => r.id));
      const roleHolders = new Set(rows.filter((r) => r.holdsRole).map((r) => r.id));
      const out = new Set(ghostVisitors(rows as never, managers, roleHolders, NOW));
      for (const r of rows) {
        const want = r.kind === "visitor" && r.status === "offline" && !r.manages && !r.holdsRole && r.quietMs >= GHOST_AFTER_MS;
        expect(out.has(r.id)).toBe(want);
      }
    }));
  });

  it("is monotone in time: a ghost now is still a ghost later", () => {
    fc.assert(fc.property(agents, fc.integer({ min: 0, max: GHOST_AFTER_MS }), (rows, dt) => {
      const later = new Set(ghostVisitors(rows as never, new Set(), new Set(), NOW + dt));
      for (const id of ghostVisitors(rows as never, new Set(), new Set(), NOW)) expect(later.has(id)).toBe(true);
    }));
  });

  it("only a town role beyond visitor keeps a visitor: deployer and admin do, visitor and building roles do not", () => {
    expect(keepsVisitor("role:deployer")).toBe(true);
    expect(keepsVisitor("role:admin")).toBe(true);
    expect(keepsVisitor("role:visitor")).toBe(false);
    expect(keepsVisitor("role:bl_x:member")).toBe(false);
    expect(keepsVisitor("role:bl_x:manager")).toBe(false);
  });
});

describe("ghost visitors: the presence pass", () => {
  it("a visitor offline for 7 days is retired with its token revoked, homed or not; a younger one and a visitor manager stay", () => {
    const { world, seed } = seededWorld();
    const lab = createBuilding(world, { name: "Roomy", headcount: 2 }, null, { starterResidents: true }).id;
    const benched = world.ops.registerVisitor(seed.admin.id, { name: "Bench Ghost" });
    const homed = world.ops.registerVisitor(seed.admin.id, { name: "Homed Ghost", buildingId: lab });
    const young = world.ops.registerVisitor(seed.admin.id, { name: "Young" });
    const boss = world.ops.registerVisitor(seed.admin.id, { name: "Boss" });
    world.buildings.upsert({ ...world.buildings.require(lab), managerAgentId: boss.agent.id });
    const t0 = Date.now();
    world.presence.sweep(new Date(t0 + 120_000));
    for (const v of [benched, homed, young, boss]) expect(world.agents.require(v.agent.id).status).toBe("offline");
    world.presence.touch(young.agent.id, new Date(t0 + 2 * 24 * 3_600_000));
    world.presence.sweep(new Date(t0 + 2 * 24 * 3_600_000 + 120_000));
    expect(world.presence.retireGhosts(new Date(t0 + GHOST_AFTER_MS - 60_000))).toEqual([]);
    const gone = world.presence.retireGhosts(new Date(t0 + GHOST_AFTER_MS + 60_000));
    expect(gone.sort()).toEqual([benched.agent.id, homed.agent.id].sort());
    for (const id of gone) {
      expect(world.agents.require(id).status).toBe("retired");
      expect(world.tokens.revokeAll("agent", id)).toBe(0);
    }
    expect(world.events.recent({ agentId: benched.agent.id, limit: 5 }).some((e) => e.type === "agent.retired" && e.text === "Bench Ghost was retired: offline for 7 days or more")).toBe(true);
    expect(world.agents.require(young.agent.id).status).toBe("offline");
    expect(world.agents.require(boss.agent.id).status).toBe("offline");
    expect(world.presence.retireGhosts(new Date(t0 + GHOST_AFTER_MS + 120_000))).toEqual([]);
  });

  it("a visitor holding the deployer role (the CI visitor) is never retired, however long it is quiet", () => {
    const { world, seed } = seededWorld();
    const ci = world.ops.registerVisitor(seed.admin.id, { name: "CI" });
    const ghost = world.ops.registerVisitor(seed.admin.id, { name: "Plain Ghost" });
    world.permissions.grant({ kind: "agent", id: ci.agent.id }, townRoleId("deployer"));
    const t0 = Date.now();
    world.presence.sweep(new Date(t0 + 120_000));
    expect(world.agents.require(ci.agent.id).status).toBe("offline");
    expect(world.presence.retireGhosts(new Date(t0 + 3 * GHOST_AFTER_MS))).toEqual([ghost.agent.id]);
    expect(world.agents.require(ci.agent.id).status).toBe("offline");
    expect(world.tokens.resolve(ci.token)).not.toBeNull();
  });

  it("seen stamps lastSeenAt without the back transition, so a REST-only visitor stops looking quiet", () => {
    const { world, seed } = seededWorld();
    const rest = world.ops.registerVisitor(seed.admin.id, { name: "REST only" });
    const t0 = Date.now();
    world.presence.sweep(new Date(t0 + 120_000));
    const at = new Date(t0 + GHOST_AFTER_MS - 3_600_000);
    world.presence.seen(rest.agent.id, at);
    const a = world.agents.require(rest.agent.id);
    expect(a.status).toBe("offline");
    expect(a.lastSeenAt).toBe(at.toISOString());
    expect(world.presence.retireGhosts(new Date(t0 + GHOST_AFTER_MS + 60_000))).toEqual([]);
    world.presence.seen("ag_nobody", at);
  });
});
