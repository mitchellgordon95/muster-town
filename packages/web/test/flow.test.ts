import { describe, expect, it } from "vitest";
import type { SnapshotBuilding } from "@muster-town/schema";
import { bankBuilding, fitZoom, widthFor } from "../src/map/flow";

const b = (id: string, kind: string) => ({ id, kind, name: id }) as unknown as SnapshotBuilding;

describe("Bank town map", () => {
  it("streams from the Bank, or the Town Hall when there is no Bank yet", () => {
    expect(bankBuilding([b("town-hall", "town-hall"), b("bank", "bank"), b("lab", "lab")])?.id).toBe("bank");
    expect(bankBuilding([b("lab", "lab"), b("town-hall", "town-hall")])?.id).toBe("town-hall");
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
});
