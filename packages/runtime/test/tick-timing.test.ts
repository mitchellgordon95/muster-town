import { describe, expect, it, vi } from "vitest";
import { slowTickLine, SLOW_TICK_MS, tickTiming } from "../src/index.ts";
import { creditBank, init, result, setup } from "./helpers.ts";

/**
 * One tick on a seeded town must stay under the slow-tick budget (post-mortem 2026-10-31 item 7). On a desk
 * (performance-2x) it takes ~55-65 ms, so 500 ms leaves ~8x for CI. With Bank.debited loading rows again (before
 * 01220ca) it takes ~1,250 ms there, so that regression fails here at PR time; a 2 s bound would not have caught it.
 */
const TICK_BOUND_MS = SLOW_TICK_MS;

describe("tick timing (post-mortem 2026-10-31 item 7)", () => {
  it("tickTiming sums the phases and names the slowest; slowTickLine is one line with the next two", () => {
    const t = tickTiming(new Date("2026-10-31T21:00:00Z"), { bankCredit: 640.4, waits: 3.26, work: 12, explore: 90 });
    expect(t).toMatchObject({ ms: 746, phase: "bankCredit", phaseMs: 640, phases: { waits: 3.3, bankCredit: 640.4 } });
    expect(slowTickLine(t)).toBe("[runtime] slow tick: 746 ms, bankCredit 640 ms (then explore 90 ms, work 12 ms)");
    expect(tickTiming(new Date(), {})).toMatchObject({ ms: 0, phase: null });
  });

  it("a tick records its phases in tickStats; only a tick over 500 ms logs, once, naming the phase", async () => {
    const { world, runtime } = setup(async function* () { yield init(); yield result(10, 0.001); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runtime.tickOnce();
      const fast = runtime.tickStats();
      expect(fast.last?.phases).toHaveProperty("waits");
      expect(fast.last?.phases).toHaveProperty("work");
      expect(fast.slow).toBeNull();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("slow tick"))).toHaveLength(0);
      // make one phase slow: the reorgs pass busy-waits past the budget
      const orig = world.reorgs.tick.bind(world.reorgs);
      world.reorgs.tick = (d: Date) => { const end = performance.now() + SLOW_TICK_MS + 20; while (performance.now() < end) { /* spin */ } return orig(d); };
      await runtime.tickOnce();
      const slow = runtime.tickStats().slow;
      expect(slow?.phase).toBe("reorgs");
      expect(slow!.ms).toBeGreaterThan(SLOW_TICK_MS);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("slow tick"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[runtime\] slow tick: \d+ ms, reorgs \d+ ms/);
    } finally { warn.mockRestore(); await runtime.whenIdle(); }
  });

  it(`one tick on a seeded town (100k events, 5k Bank debits, 50 funded grants) finishes under ${TICK_BOUND_MS} ms`, async () => {
    const { world, seed, runtime, clock, by } = setup(async function* () { yield init(); yield result(10, 0.001); });
    creditBank(world, 1_000_000_000);
    const lab = seed.lab!.id;
    const manager = by("Mei"), admin = world.ops.ensureAvatar(seed.admin.id);
    // 50 funded grants (Bank.debited is summed per grant and lane on every tick)
    const grants: string[] = [];
    for (let i = 0; i < 50; i++) {
      const g = world.grantDesk.create(admin, lab, { keyResults: [{ text: `k${i}`, howToCheck: "h" }], objective: `o${i}`, stopCondition: "s", askTokens: 100_000 });
      world.grantDesk.propose(admin, g.id);
      grants.push(world.grantDesk.decide(admin, g.id, { action: "fund" }).id);
    }
    const credit = (world.db.prepare("SELECT id FROM bank_credits LIMIT 1").get() as { id: string }).id;
    const buildings = world.buildings.all().map((b) => b.id);
    const tx = world.db.transaction(() => {
      const debit = world.db.prepare("INSERT INTO bank_debits (id, buildingId, agentId, creditId, createdAt, poolId, input, output, cacheRead, grantId) VALUES (?, ?, ?, ?, ?, 'general', 10, 20, 70, ?)");
      for (let i = 0; i < 5000; i++) debit.run(`bd_seed_${i}`, buildings[i % buildings.length], manager.id, credit, new Date(clock.t - i * 60_000).toISOString(), i % 2 ? grants[i % 50] : null);
      const ev = world.db.prepare("INSERT INTO events (ts, type, agentId, buildingId, text, payload) VALUES (?, ?, ?, ?, ?, ?)");
      const types = ["agent.tool", "agent.thought", "agent.status", "system", "doc.created"];
      for (let i = 0; i < 100_000; i++) ev.run(new Date(clock.t - i * 5_000).toISOString(), types[i % types.length], manager.id, lab, `seeded event ${i}`, JSON.stringify({ i }));
    });
    tx();
    expect((world.db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number }).n).toBeGreaterThanOrEqual(100_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await runtime.tickOnce(); // the first tick runs the once-a-day and presence passes too
      await runtime.whenIdle();
      const first = runtime.tickStats().last!;
      clock.t += 5_000;
      const t0 = performance.now();
      await runtime.tickOnce();
      const wall = performance.now() - t0;
      const second = runtime.tickStats().last!;
      console.log(`[tick-timing] seeded tick: first ${first.ms} ms (slowest ${first.phase} ${first.phaseMs} ms), second ${second.ms} ms sync / ${Math.round(wall)} ms wall (slowest ${second.phase} ${second.phaseMs} ms)`);
      expect(first.ms).toBeLessThan(TICK_BOUND_MS);
      expect(wall).toBeLessThan(TICK_BOUND_MS);
    } finally { warn.mockRestore(); await runtime.whenIdle(); }
  }, 120_000);
});
