import { describe, expect, it } from "vitest";
import type { Agent } from "@muster-town/schema";
import { canDismiss } from "../src/panels/Dismiss.tsx";

const agent = (o: Partial<Agent>) => ({ id: "ag_root", kind: "resident", status: "idle", forkOf: null, ...o }) as Agent;

describe("Dismiss on the agent panel (admins only; 1:1 mt_lb7tm75jgb)", () => {
  it("shows for an admin on a live resident that isn't the manager", () => {
    expect(canDismiss(agent({}), "ag_pix", true)).toBe(true);
    expect(canDismiss(agent({ status: "out-of-budget" }), "ag_pix", true)).toBe(true);
  });
  it("hides for non-admins, the manager, forks, visitors and agents already gone", () => {
    expect(canDismiss(agent({}), "ag_pix", false)).toBe(false);
    expect(canDismiss(agent({ id: "ag_pix" }), "ag_pix", true)).toBe(false);
    expect(canDismiss(agent({ forkOf: "ag_pix" }), "ag_pix", true)).toBe(false);
    expect(canDismiss(agent({ kind: "visitor" }), "ag_pix", true)).toBe(false);
    expect(canDismiss(agent({ status: "retired" }), "ag_pix", true)).toBe(false);
    expect(canDismiss(agent({ status: "banned" }), "ag_pix", true)).toBe(false);
  });
});
