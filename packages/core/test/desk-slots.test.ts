/** Manager forks step 3 (dc_mymt27yz25 §2.5): desk slots (table desk_slots) and a chain's soft desk affinity. */
import { describe, expect, it } from "vitest";
import { chainDesk, createBuilding, createResident, deskSlotRow, forkDeskSlot, forkManager, retireFork, setDeskSlot, updateBuilding } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 5, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  world.grantDesk.createKeyResult(s.admin, b.id, { text: "Forks work", howToCheck: "Run the tests" }); // a key result, so the lab isn't blocked
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const queue = async (title: string) => (await world.verbs.assign(world.agents.require(pix.id), { title, description: "d", gap: "test gap" })).assignmentId;
  const names = (bid: string, n: number) => ({ sandboxName: `desk-c-${bid}-${n}`, volumeName: `deskhome-${bid}-${n}` });
  return { world, b, pix, queue, names };
}

describe("desk slots", () => {
  it("a continuation takes its chain's last desk when free, even when a lower desk is free; else the lowest", async () => {
    const { world, b, queue } = lab();
    const a1 = await queue("One"), a2 = await queue("Two");
    const f1 = forkManager(world, b.id, a1), f2 = forkManager(world, b.id, a2);
    expect([f1.desk, f2.desk]).toEqual([2, 3]);
    retireFork(world, f1.fork.id);
    retireFork(world, f2.fork.id);
    expect(chainDesk(world, b.id, a2)).toBe(3);
    // the continuation of chain a2 (a park's follow-up keeps the chainId)
    const c = await queue("Two, continued");
    world.assignments.upsert({ ...world.assignments.require(c), chainId: a2 });
    const fc = forkManager(world, b.id, c);
    expect(fc.desk).toBe(3);
    expect(world.events.recent({ limit: 50 }).find((e) => e.type === "agent.forked" && e.agentId === fc.fork.id)?.payload).toMatchObject({ chainId: a2, chainDesk: 3, sameDesk: true });
    // a fresh chain takes the lowest free desk
    expect(forkManager(world, b.id, await queue("Three")).desk).toBe(2);
    // desk 3 taken: the next hop of a2 falls back to the lowest free desk
    const d = await queue("Two, again");
    world.assignments.upsert({ ...world.assignments.require(d), chainId: a2 });
    expect(forkManager(world, b.id, d).desk).toBe(4);
  });

  it("a fork's slot row is created with the defaults on first use and reused after; residents have none; adoption repoints the volume", async () => {
    const { world, b, pix, queue, names } = lab();
    expect(forkDeskSlot(world, pix.id, names)).toBeNull();
    const f = forkManager(world, b.id, await queue("One"));
    expect(forkDeskSlot(world, f.fork.id, names)).toMatchObject({ buildingId: b.id, n: 2, sandboxName: `desk-c-${b.id}-2`, volumeName: `deskhome-${b.id}-2` });
    retireFork(world, f.fork.id);
    // step 7: desk 2 adopts a resident's home
    setDeskSlot(world, b.id, 2, { sandboxName: `desk-c-${b.id}-2`, volumeName: "deskhome-ag_oycvqt9sa6" });
    const g = forkManager(world, b.id, await queue("Two"));
    expect(g.desk).toBe(2);
    expect(forkDeskSlot(world, g.fork.id, names)?.volumeName).toBe("deskhome-ag_oycvqt9sa6");
    expect(deskSlotRow(world, b.id, 3)).toBeNull();
  });
});
