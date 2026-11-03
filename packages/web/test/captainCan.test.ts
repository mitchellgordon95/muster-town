import { afterEach, describe, expect, test } from "vitest";
import type { AuthMe } from "@muster-town/schema";
import { store } from "../src/state";
import { canOneOnOne } from "../src/panels/oneOnOne";
import { flagTargets } from "../src/panels/flag";

/** A signed-in non-admin member; `captainOf` = the buildings under a goal they captain (GET /api/me, gr_zsm1piyqyx). */
const me = (captainOf?: string[], roles: AuthMe["roles"] = []): AuthMe =>
  ({ user: { id: "us_cap" }, roles, avatarAgentId: "ag_cap", isAdmin: false, canInteract: true, accessRequest: null, direct: [], directDefaultGoalId: null, captainOf }) as unknown as AuthMe;

afterEach(() => store.set({ me: null }));

describe("store.can with captainOf (gr_zsm1piyqyx)", () => {
  test("inside the captained subtree: review, facilitate (1:1 as staff) and flags; never assign or manage", () => {
    store.set({ me: me(["lab-a"]) });
    expect(store.can("building.review", "lab-a")).toBe(true);
    expect(store.can("meeting.facilitate", "lab-a")).toBe(true);
    expect(canOneOnOne("lab-a")).toBe(true);
    expect(store.canFlag("lab-a")).toBe(true);
    expect(store.can("building.assign", "lab-a")).toBe(false);
    expect(store.can("building.manage", "lab-a")).toBe(false);
    expect(store.can("building.fund", "lab-a")).toBe(false);
    expect(store.can("building.review")).toBe(false);
  });

  test("outside the subtree: the member view (no review, no staff 1:1, no flag)", () => {
    store.set({ me: me(["lab-a"]) });
    expect(store.can("building.review", "lab-b")).toBe(false);
    expect(canOneOnOne("lab-b")).toBe(false);
    expect(store.canFlag("lab-b")).toBe(false);
    const bs = [{ id: "town-hall", kind: "town-hall" }, { id: "lab-a", kind: "lab" }, { id: "lab-b", kind: "lab" }];
    expect(flagTargets(bs, (id) => store.canFlag(id)).map((b) => b.id)).toEqual(["lab-a"]);
  });

  test("a plain member (no captainOf, or an older server without it) gets nothing extra; roles still count", () => {
    store.set({ me: me(undefined) });
    expect(store.can("building.review", "lab-a")).toBe(false);
    expect(store.canFlag("lab-a")).toBe(false);
    store.set({ me: me([], [{ id: "r", name: "reviewer", scope: "building", buildingId: "lab-a", permissions: ["building.review", "building.assign"] }] as unknown as AuthMe["roles"]) });
    expect(store.can("building.review", "lab-a")).toBe(true);
    expect(store.canFlag("lab-a")).toBe(true);
    expect(store.can("building.review", "lab-b")).toBe(false);
  });
});
