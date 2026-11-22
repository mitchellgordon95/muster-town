import { describe, expect, it } from "vitest";
import { createBuilding, createResident, worldGoalSpend } from "../src/index.ts";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { seededWorld } from "./helpers.ts";

const OPUS = "claude-opus-5-5";

// gr_ouc0w8us88 step 2: the finance and goal spend reads take a few agent columns, not every parsed agent row
// (agents.all() was ~390 ms per call at 15,000 retired forks). Their output must not change by a byte.
describe("finance and goal spend read agents by column", () => {
  it("bank.spend, bank.fly and worldGoalSpend are byte-identical to the full-row read", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Scans" }, seed.admin.id);
    const a = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
    const done = (agentId: string, purpose: "manage" | "work", output: number, assignmentId?: string) => {
      const s = world.ops.startSession(agentId, { purpose, model: OPUS, assignmentId });
      world.ops.endSession(s.id, { status: "done", counts: { input: 1_000, output, cacheRead: 10_000, cacheWrite5m: 0, cacheWrite1h: 0 } });
      return s.id;
    };
    done(a.id, "manage", 500);
    const w = world.ops.createWork(null, a.id, { title: "scan work" });
    done(a.id, "work", 700, w.id);
    // retired forks: one in the building, one with no building; each ran a session with no assignment (the agent's building books it)
    const cols = (world.db.prepare("PRAGMA table_xinfo(agents)").all() as { name: string; hidden: number }[]).filter((c) => c.hidden === 0).map((c) => c.name);
    const tpl = world.db.prepare("SELECT * FROM agents WHERE id = ?").get(a.id) as Record<string, unknown>;
    const ins = world.db.prepare(`INSERT INTO agents (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    const forks = [{ id: "ag_ret_in", buildingId: b.id }, { id: "ag_ret_none", buildingId: null, homeBuildingId: null }];
    for (const f of forks) ins.run(...cols.map((c) => ({ ...tpl, name: f.id, forkOf: a.id, status: "retired", ...f } as Record<string, unknown>)[c]));
    for (const f of forks) { const id = done(a.id, "work", 300); world.db.prepare("UPDATE sessions SET agentId = ? WHERE id = ?").run(f.id, id); }
    // a visitor of the building with no current building: worldGoalSpend counts it by its home building
    ins.run(...cols.map((c) => ({ ...tpl, id: "ag_vis", name: "Vis", kind: "visitor", status: "idle", buildingId: null, homeBuildingId: b.id } as Record<string, unknown>)[c]));

    const T0 = new Date(Date.now() + 1_000);
    const read = () => JSON.stringify([
      world.bank.spend(T0, "7d"),
      world.bank.spend(T0, "today"),
      world.bank.fly({ backend: "fly" }, true, { windowDays: 7 }, T0),
      worldGoalSpend(world, ROOT_GOAL_ID, 7, T0),
    ]);
    const byColumn = read();
    // the old read: every agent parsed through the schema, in rowid order
    const columns = world.agents.columns.bind(world.agents);
    world.agents.columns = ((c: string[], where?: string, params?: unknown[], tail?: string) =>
      where === undefined ? world.agents.all() : columns(c, where, params, tail)) as typeof world.agents.columns;
    const fullRows = read();
    expect(byColumn).toBe(fullRows);
    // the world was not empty: the retired forks' sessions and the visitor are in the numbers
    const goal = worldGoalSpend(world, ROOT_GOAL_ID, 7, T0);
    expect(goal.visitors).toBe(1);
    expect(goal.sessions).toBe(3); // manage, work, the in-building fork; the fork with no building is under no goal
  });
});
