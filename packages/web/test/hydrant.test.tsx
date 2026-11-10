/**
 * The Town Hall hydrant (docs/legible-delegation.md §3, UI / UX A): its place in the Town Hall (which has no in-tray:
 * the hydrant opens the decision queue), its numbers, and the stream's dots (capped, none under reduced motion).
 */
import { describe, expect, it } from "vitest";
import { TILE, type Notice } from "@muster-town/schema";
import { computeLayout } from "../src/mock/layout";
import { agents, asks, buildings, notices } from "../src/mock/fixture";
import { MAX_PARTICLES, hydrantCounts, streamParticles } from "../src/map/hydrant";


const notice = (id: string, kind: Notice["kind"], createdAt: string): Notice => ({ ...notices[0], id, kind, createdAt });

describe("the Town Hall hydrant", () => {
  it("the Town Hall layout has the hydrant place and no in-tray: its tile right of the planning desk, open floor where the tray was", () => {
    const { grid, places } = computeLayout(buildings, agents);
    const hall = buildings.find((b) => b.kind === "town-hall")!;
    const p = places.find((x) => x.id === `hydrant:${hall.id}`)!;
    expect(p).toMatchObject({ kind: "hydrant", buildingId: hall.id });
    const at = (x: number, y: number) => grid.tiles[y * grid.w + x];
    expect(at(p.pos.x, p.pos.y + 1)).toBe(TILE.HYDRANT);
    expect(at(p.pos.x - 1, p.pos.y + 1)).toBe(TILE.FLOOR);
    expect(places.some((x) => x.buildingId === hall.id && x.kind === "intray")).toBe(false);
  });

  it("counts live asks (a deferred one too), today's notices and the last slate as the ranking time", () => {
    const now = new Date("2026-11-08T15:00:00");
    const c = hydrantCounts({
      asks: [{ ...asks[0], status: "open" }, { ...asks[0], id: "ak_b", status: "open" }, { ...asks[0], id: "ak_c", status: "deferred" }],
      notices: [notice("nt_a", "shipped", new Date("2026-11-08T09:00:00").toISOString()), notice("nt_s", "slate", new Date("2026-11-08T08:00:00").toISOString()), notice("nt_old", "slate", new Date("2026-11-06T08:00:00").toISOString())],
    }, now);
    expect(c).toEqual({ asks: 3, noticesToday: 2, rankedAt: new Date("2026-11-08T08:00:00").toISOString() });
    expect(hydrantCounts(null)).toEqual({ asks: 0, noticesToday: 0, rankedAt: null });
  });

  it("the stream: a dot per ask and notice, at most a dozen, none under reduced motion or without a target", () => {
    const from = { x: 0, y: 0 }, to = { ask: { x: 32, y: 0 }, notice: { x: -64, y: 0 } };
    const few = streamParticles(from, to, { asks: 2, noticesToday: 3 }, 1000, false);
    expect(few.filter((d) => d.kind === "ask")).toHaveLength(2);
    expect(few.filter((d) => d.kind === "notice")).toHaveLength(3);
    expect(streamParticles(from, to, { asks: 40, noticesToday: 40 }, 1000, false)).toHaveLength(MAX_PARTICLES);
    expect(streamParticles(from, to, { asks: 40, noticesToday: 0 }, 1000, false)).toHaveLength(MAX_PARTICLES);
    expect(streamParticles(from, to, { asks: 2, noticesToday: 3 }, 1000, true)).toEqual([]);
    expect(streamParticles(from, { ask: null, notice: null }, { asks: 2, noticesToday: 3 }, 1000, false)).toEqual([]);
    for (const d of few) {
      expect(d.x).toBeGreaterThanOrEqual(-64);
      expect(d.x).toBeLessThanOrEqual(32);
    }
  });
});
