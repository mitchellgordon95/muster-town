import { describe, expect, it } from "vitest";
import { TILE } from "@muster-town/schema";
import { computeLayout } from "../src/mock/layout";
import { buildings, agents } from "../src/mock/fixture";
import { scheduleTipRow, scheduleTipTitle } from "../src/format";

describe("schedule board (flag dc_ym8fjxqjiv part 2)", () => {
  it("the mock town hangs a schedule board on every lab's back wall, with a place below it", () => {
    const { grid, places, lots } = computeLayout(buildings, agents);
    const labs = buildings.filter((b) => b.kind !== "town-hall");
    expect(labs.length).toBeGreaterThan(0);
    for (const b of labs) {
      const p = places.find((x) => x.id === `schedule:${b.id}`);
      expect(p?.kind, b.id).toBe("schedule");
      const lot = lots.get(b.id)!;
      expect(grid.tiles[lot.y * grid.w + p!.pos.x], b.id).toBe(TILE.SCHEDULE_BOARD);
      expect(p!.pos.y).toBe(lot.y + 1);
      expect(places.filter((q) => q.kind === "desk" && q.pos.x === p!.pos.x && q.pos.y === p!.pos.y)).toEqual([]);
    }
  });

  it("the hover lists each schedule's next run, repeat and paused, and says when nothing is scheduled", () => {
    expect(scheduleTipTitle("Town Workshop", 0, "click")).toBe("Town Workshop schedule: nothing scheduled (click to open the Schedule section)");
    expect(scheduleTipTitle("Town Workshop", 2, "click")).toContain("2 timed jobs");
    const row = scheduleTipRow({ title: "Daily Town blockers refresh", nextRunAt: "2026-10-30T19:30:00.000Z", everyMinutes: null, dailyAt: ["19:30"], maxRuns: null, paused: false });
    expect(row).toContain("Daily Town blockers refresh: next ");
    expect(row).toContain("19:30 UTC");
    expect(row).toContain("daily 19:30 UTC");
    expect(scheduleTipRow({ title: "x", nextRunAt: null, everyMinutes: 360, dailyAt: null, paused: true })).toBe("x: paused, next —, every 6 h");
  });
});
