import { describe, expect, it } from "vitest";
import { HOSTED_TICK_CAP, hostedTickCap, TickRotation } from "../src/ticks.ts";

/** A fake clock: setTimer queues (at, fn); run(ms) fires everything due, in order. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let ids = 0;
  return {
    get now() { return now; },
    setTimer: (fn: () => void, ms: number) => { const id = ++ids; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (h: unknown) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
    async run(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
      now = end;
    },
  };
}

function rotation(cap: number) {
  const clock = fakeClock();
  const logs: string[] = [];
  const ticks: { slug: string; at: number }[] = [];
  const r = new TickRotation({ intervalMs: 5000, cap, log: (l) => logs.push(l), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const add = (slug: string) => r.add(slug, () => { ticks.push({ slug, at: clock.now }); });
  return { r, clock, logs, ticks, add };
}

describe("hosted collectives' tick rotation (post-mortem 2026-10-31 item 8)", () => {
  it("staggers: N worlds tick one at a time, interval / N apart, each every interval", async () => {
    const { r, clock, ticks, logs, add } = rotation(10);
    for (const s of ["a", "b", "c", "d"]) add(s);
    expect(r.slotMs()).toBe(1250);
    await clock.run(10_000);
    expect(ticks.map((t) => t.slug)).toEqual(["a", "b", "c", "d", "a", "b", "c", "d"]);
    // never two at the same instant
    expect(new Set(ticks.map((t) => t.at)).size).toBe(ticks.length);
    // each world every 5 s
    const a = ticks.filter((t) => t.slug === "a").map((t) => t.at);
    expect(a[1]! - a[0]!).toBe(5000);
    expect(logs).toEqual([]);
  });

  it("caps: past the cap each world ticks less often, the host never runs more than cap ticks per interval; logged once", async () => {
    const { r, clock, ticks, logs, add } = rotation(2);
    for (const s of ["a", "b", "c", "d"]) add(s);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[hosted\] 3 hosted collectives, over the tick cap of 2: each ticks every 7\.5 s instead of every 5 s/);
    expect(r.slotMs()).toBe(2500);
    expect(r.periodMs()).toBe(10_000);
    await clock.run(20_000);
    expect(ticks).toHaveLength(8); // 2 per 5 s
    const a = ticks.filter((t) => t.slug === "a").map((t) => t.at);
    expect(a[1]! - a[0]!).toBe(10_000);
    // dropping under the cap and going over again logs again, not before
    r.remove("d"); r.remove("c");
    add("c");
    expect(logs).toHaveLength(2);
  });

  it("a world's tick still running is skipped, a removed world stops ticking, the timer stops with none left", async () => {
    const { r, clock, ticks, add } = rotation(10);
    let release!: () => void;
    let slowRuns = 0;
    r.add("slow", () => { slowRuns++; return new Promise<void>((res) => { release = res; }); });
    add("b");
    await clock.run(10_000);
    expect(slowRuns).toBe(1); // still running at its next turn: skipped
    release();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await clock.run(5_000);
    expect(slowRuns).toBe(2);
    r.remove("b");
    const before = ticks.length;
    await clock.run(10_000);
    expect(ticks.length).toBe(before);
    r.remove("slow");
    expect(r.count).toBe(0);
  });

  it("the cap setting: a positive integer, else the default", () => {
    expect(hostedTickCap(undefined)).toBe(HOSTED_TICK_CAP);
    expect(hostedTickCap("3")).toBe(3);
    expect(hostedTickCap("0")).toBe(HOSTED_TICK_CAP);
    expect(hostedTickCap("x")).toBe(HOSTED_TICK_CAP);
  });
});
