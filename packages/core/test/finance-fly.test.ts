import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { financeFly, flyRate, FLY_PRICES, TOWN_MACHINE, type FlyInputs } from "../src/index.ts";
import { REPO_ROOT, seededWorld } from "./helpers.ts";

// "now" is 06:00Z on 10-29; the window is 10-27 .. 10-29
const NOW = new Date("2026-10-29T06:00:00.000Z");
const H = 3_600_000;
const at = (iso: string) => new Date(iso).toISOString();
const s = (agentId: string, assignmentId: string | null, startedAt: string, o: { wallMs?: number | null; endedAt?: string | null; backend?: "host" | "docker" } = {}) =>
  ({ agentId, assignmentId, backend: o.backend ?? "docker" as const, startedAt: at(startedAt), endedAt: o.endedAt === undefined ? at(startedAt) : o.endedAt, wallMs: o.wallMs ?? null });

const fly: FlyInputs["desks"] = { backend: "fly", cpuKind: "shared", cpus: 2, memoryMb: 2048 };
const base: FlyInputs = {
  sessions: [
    s("ag_a", "a1", "2026-10-28T10:00:00Z", { wallMs: 2 * H }), // measured, Bank, 10-28
    s("ag_a", "a2", "2026-10-28T23:00:00Z", { wallMs: 2 * H }), // spans midnight: 1 h on 10-28, 1 h on 10-29
    s("ag_lab", "a3", "2026-10-29T01:00:00Z", { wallMs: null, endedAt: at("2026-10-29T02:30:00Z") }), // unmeasured: endedAt − startedAt = 1.5 h, Lab
    s("ag_a", null, "2026-10-29T05:00:00Z", { wallMs: null, endedAt: null }), // running manager desk session: 1 h so far, the agent's building
    s("ag_a", "a1", "2026-10-29T03:00:00Z", { wallMs: H, backend: "host" }), // host session: not a Machine
    s("ag_a", "a1", "2026-10-20T03:00:00Z", { wallMs: H }), // before the window
  ],
  assignments: [{ id: "a1", buildingId: "bank" }, { id: "a2", buildingId: "bank" }, { id: "a3", buildingId: "lab" }],
  agents: [{ id: "ag_a", buildingId: "bank" }, { id: "ag_lab", buildingId: "lab" }],
  buildings: [{ id: "bank", name: "Bank Transparency" }, { id: "lab", name: "Lab" }],
  desks: fly, townOnFly: true, windowDays: 3,
};

describe("flyRate (Fly list prices)", () => {
  it("prices the presets and adds $6/GB-month past a preset's RAM", () => {
    expect(flyRate("shared", 2, 2048)).toEqual({ preset: "shared-cpu-2x", memoryMb: 2048, usdPerMonth: 13.39, usdPerHour: 0.018597 });
    expect(flyRate("performance", 1, 2048)).toMatchObject({ preset: "performance-1x", usdPerMonth: 33, usdPerHour: 0.045833 });
    expect(flyRate("shared", 1, 512)).toMatchObject({ preset: "shared-cpu-1x", usdPerMonth: 3.69 });
    expect(flyRate("shared", 8, 2048)).toBeNull();
  });
  it("sizes the town Machine as fly.town.toml does", () => {
    const toml = readFileSync(join(REPO_ROOT, "fly.town.toml"), "utf8");
    const size = /size\s*=\s*"([^"]+)"/.exec(toml)![1]!, mem = /memory\s*=\s*"(\d+)gb"/.exec(toml)![1]!;
    expect(size).toBe(`${(TOWN_MACHINE.cpuKind as string) === "shared" ? "shared-cpu" : "performance"}-${TOWN_MACHINE.cpus}x`);
    expect(Number(mem) * 1024).toBe(TOWN_MACHINE.memoryMb);
    expect(FLY_PRICES.presets[size]).toBeDefined();
  });
});

describe("financeFly (GET /api/finance/fly)", () => {
  const r = financeFly(base, NOW);
  const rate = r.rates.desk!.usdPerHour;

  it("splits desk sessions across the UTC days they span and prices them at the desk size", () => {
    expect(r.days.map((d) => d.day)).toEqual(["2026-10-29", "2026-10-28", "2026-10-27"]);
    const [d29, d28, d27] = r.days as [typeof r.days[0], typeof r.days[0], typeof r.days[0]];
    expect(d28.deskMs).toBe(3 * H); // 2 h + the hour before midnight
    expect(d29.deskMs).toBe(3.5 * H); // 1 h after midnight + 1.5 h unmeasured + 1 h running so far
    expect(d27.deskMs).toBe(0);
    expect(d28.sessions).toBe(2);
    expect(d29.sessions).toBe(3);
    expect(d28.deskUsd).toBeCloseTo(3 * rate, 6);
  });
  it("counts the town Machine for the hours of each day elapsed", () => {
    const town = r.rates.town!.usdPerHour;
    expect(r.days[0]!.townUsd).toBeCloseTo(6 * town, 6); // today, 6 h in
    expect(r.days[1]!.townUsd).toBeCloseTo(24 * town, 6);
    expect(r.days[2]!.townUsd).toBeCloseTo(24 * town, 6);
    for (const d of r.days) expect(d.totalUsd).toBeCloseTo(d.deskUsd + d.townUsd, 6);
  });
  it("charges each session to its assignment's building, else its agent's, and the buildings sum to the days", () => {
    expect(r.buildings.map((b) => [b.name, b.deskMs, b.sessions])).toEqual([["Bank Transparency", 5 * H, 3], ["Lab", 1.5 * H, 1]]);
    expect(r.totals).toMatchObject({ deskMs: 6.5 * H, deskHours: 6.5, sessions: 4, unmeasuredSessions: 2 });
    expect(r.sumCheck).toMatchObject({ ok: true, diff: 0, daysOk: true, buildingsOk: true });
    expect(r.totals.totalUsd).toBeCloseTo(r.totals.deskUsd + r.totals.townUsd, 6);
    expect(r.from).toBe("2026-10-27");
    expect(r.to).toBe("2026-10-29");
  });
  it("leaves host sessions and sessions before the window out", () => {
    expect(r.days.every((d) => d.buildings.every((b) => b.id !== null))).toBe(true);
    expect(r.totals.sessions).toBe(4);
  });
  it("shows the cap when one is given, and whether today is under it", () => {
    expect(r.today).toMatchObject({ day: "2026-10-29", capUsdPerDay: null, underCap: null });
    const capped = financeFly({ ...base, capUsdPerDay: 10 }, NOW);
    expect(capped.today).toMatchObject({ capUsdPerDay: 10, underCap: true });
    expect(financeFly({ ...base, capUsdPerDay: 0.01 }, NOW).today.underCap).toBe(false);
  });
  it("prices nothing when desks are not on Fly or the server is not on a Fly Machine, but still shows desk time", () => {
    const off = financeFly({ ...base, desks: { backend: "docker" }, townOnFly: false }, NOW);
    expect(off.rates).toMatchObject({ desk: null, town: null });
    expect(off.totals).toMatchObject({ deskMs: 6.5 * H, deskUsd: 0, townUsd: 0, totalUsd: 0 });
    expect(off.assumptions[0]).toContain("not on Fly");
    expect(off.sumCheck.ok).toBe(true);
  });
  it("clamps the window to 1..90 days", () => {
    expect(financeFly({ ...base, windowDays: 0 }, NOW).days).toHaveLength(1);
    expect(financeFly({ ...base, windowDays: 400 }, NOW).days).toHaveLength(90);
    expect(financeFly({ ...base, windowDays: undefined }, NOW).days).toHaveLength(30);
  });
  it("runs over a seeded world", () => {
    const { world } = seededWorld();
    const live = world.bank.fly({ backend: "fly" }, true, { windowDays: 7 });
    expect(live.sumCheck.ok).toBe(true);
    expect(live.days).toHaveLength(7);
    expect(live.rates.desk).toMatchObject({ preset: "performance-1x" });
  });
  it("prices each session at the size it ran on; one without a recorded size at shared-cpu-2x (gr_uhh6u39vv9 step 3)", () => {
    const one = (size: { cpuKind?: "shared" | "performance"; cpus?: number; memoryMb?: number }) =>
      financeFly({ ...base, sessions: [{ ...s("ag_a", "a1", "2026-10-29T01:00:00Z", { wallMs: 2 * H }), ...size }], desks: { backend: "fly" } }, NOW).today.deskUsd;
    expect(one({ cpuKind: "performance", cpus: 1, memoryMb: 2048 })).toBeCloseTo(2 * 0.045833, 5);
    expect(one({ cpuKind: "performance", cpus: 2, memoryMb: 4096 })).toBeCloseTo(2 * 66 / 720, 5);
    expect(one({})).toBeCloseTo(2 * 0.018597, 5);
  });
});
