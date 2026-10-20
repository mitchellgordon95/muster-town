import { describe, expect, it } from "vitest";
import type { Place, SnapshotBuilding } from "@muster-town/schema";
import type { Bank } from "../src/api";
import { flowSource, fitZoom, poolLinks, widthFor } from "../src/map/flow";
import { POOL_COLORS } from "../src/pools";

const hall = { id: "town-hall", kind: "town-hall", name: "Town Hall", lot: { x: 0, y: 0, w: 10, h: 4 } } as unknown as SnapshotBuilding;
const lab = { id: "lab", kind: "lab", name: "Lab", lot: { x: 20, y: 0, w: 10, h: 4 } } as unknown as SnapshotBuilding;
const map: Place = { id: "bank-map", kind: "bank-map", name: "Town map", buildingId: null, pos: { x: 3, y: 9 } };

describe("Bank town map", () => {
  it("streams from the Bank, or the Town Hall when there is no Bank yet", () => {
    expect(flowSource([map], [hall, lab])).toEqual({ at: { x: 3 * 16 + 8, y: 9 * 16 + 8 }, skip: null });
    expect(flowSource([], [lab, hall])).toEqual({ at: { x: 80, y: 32 }, skip: "town-hall" });
  });
  it("fits the whole town in the view, never zooming in past the walking zoom", () => {
    const z = fitZoom(1600, 400, 1000, 800, 3);
    expect(1600 * z).toBeLessThanOrEqual(1000);
    expect(400 * z).toBeLessThanOrEqual(800);
    expect(fitZoom(100, 100, 1000, 800, 3)).toBe(3);
  });
  it("makes a bigger share a wider river", () => {
    expect(widthFor(0)).toBe(2);
    expect(widthFor(10)).toBeLessThan(widthFor(50));
    expect(widthFor(100)).toBe(22);
  });
  it("colours each building by its pool and splits the pool's % between the buildings that draw from it", () => {
    const lab2 = { id: "lab2", kind: "lab", name: "Lab 2" } as unknown as SnapshotBuilding;
    const row = (buildingId: string, poolId: string, poolName: string) => ({ buildingId, name: buildingId, poolId, poolName, pct: 0, explicit: false, expiringTokens: 0, durableTokens: 0, heldTokens: 0 });
    const bank = {
      pools: [
        { id: "general", name: "General", pct: 40, explicit: false, isDefault: true, buildings: [], expiringTokens: 0, durableTokens: 0 },
        { id: "pl_x", name: "Research", pct: 60, explicit: true, isDefault: false, buildings: [], expiringTokens: 0, durableTokens: 0 },
      ],
      buildings: [row("town-hall", "general", "General"), row("lab", "pl_x", "Research"), row("lab2", "pl_x", "Research")],
    } as unknown as Bank;
    const links = poolLinks(bank, [hall, lab, lab2]);
    expect(links.get("town-hall")).toMatchObject({ draws: false, pct: 0, color: POOL_COLORS[0] });
    expect(links.get("lab")).toMatchObject({ draws: true, pct: 30, poolName: "Research", color: POOL_COLORS[1] });
    expect(links.get("lab2")!.pct).toBe(30);
  });
});
