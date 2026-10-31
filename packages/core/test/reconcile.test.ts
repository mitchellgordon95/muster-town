import { describe, expect, it } from "vitest";
import { reconciled, reconcileFunding, utcDay, World } from "../src/index.ts";

const LIMIT_MSG = "You've hit your org's monthly spend limit · resets 8:50pm (UTC)";

/** A seeded world with a subscription input and an api-key input holding their credentials, and one resident. */
function open() {
  const world = World.open(":memory:");
  const seed = world.seedDefaults({ adminName: "T", importDir: new URL("../../../buildings/carbon-cycle", import.meta.url).pathname });
  const noor = world.agents.first("name = ?", ["Noor"])!;
  const sub = world.bank.addInput(seed.admin.id, { label: "sub", source: "subscription", model: "m", tokens: 1_000_000, recurrence: "daily", weeklyCapTokens: 7_000_000, token: "sk-ant-oat01-test-token" });
  const key = world.bank.addInput(seed.admin.id, { label: "key", source: "api-key", model: "m", tokens: 500_000, recurrence: "once", apiKey: "sk-ant-api03-key" });
  const session = (funding: "subscription" | "api-key" | "donor-key", costUsd: number, credentialInputId: string | null) => {
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", funding, credentialInputId });
    return world.ops.endSession(s.id, { status: "done", costUsd, tokens: 100 });
  };
  return { world, seed, noor, sub, key, session, day: utcDay(new Date()) };
}
const alertOf = (world: World) => world.events.list({ types: ["system"], textLike: "Bank reconciliation%" }).at(-1)!;

describe("daily funding reconciliation (post-mortem 2026-10-30: unexplained api-key spend is an in-town alert; the Bank checks only itself, never the Console)", () => {
  it("a day whose sessions all ran on credentials the Bank lists is OK, and the result carries nothing from outside the town", () => {
    const { world, sub, key, session, day } = open();
    session("subscription", 1.5, sub.id);
    session("api-key", 2, key.id);
    const r = reconcileFunding(world, day);
    expect(r).toEqual({ day, sessions: 2, subscriptionUsd: 1.5, apiKeyUsd: 2, donorKeyUsd: 0, unlisted: [], mismatches: 0, ok: true });
    const e = alertOf(world);
    expect(e.text).toBe(`Bank reconciliation for ${day}: 2 sessions, Bank api-key $2.00, subscription $1.50, donor keys $0.00. OK`);
    expect(e.text).not.toMatch(/Console|Admin/);
    expect(e.payload.alert).toBeUndefined();
    expect(reconciled(world, day)).toBe(true);
    world.close();
  });

  it("an api-key session on a key the Bank doesn't list, or a desk's funding claim that didn't match, is an alert", () => {
    const { world, key, session, day, noor } = open();
    session("api-key", 1, key.id); // recording has started: a later api-key session with no input is unlisted
    const bad = session("api-key", 1, null);
    const gone = session("api-key", 1, "bi_nope");
    world.events.append({ type: "system", agentId: noor.id, text: "desk claimed api-key", payload: { alert: "funding-mismatch", sessionId: bad.id } });
    const r = reconcileFunding(world, day);
    expect(r.unlisted).toEqual([bad.id, gone.id]);
    expect(r.mismatches).toBe(1);
    expect(r.ok).toBe(false);
    const e = alertOf(world);
    expect(e.text).toContain(`donor keys $0.00. ALERT: 2 api-key session(s) on a key the Bank does not list; 1 desk(s) claimed a funding they were not handed`);
    expect(e.payload.alert).toBe("funding-reconcile");
    world.close();
  });

  it("a cap death makes the next funding the api-key input's (one credential per session); sessions from before the Bank recorded the credential are not unlisted", () => {
    const { world, seed, key, session, day } = open();
    const old = session("api-key", 1, null); // before recording began: not flagged
    expect(reconcileFunding(world, day)).toMatchObject({ unlisted: [], ok: true });
    expect(alertOf(world).text).toContain("donor keys $0.00. OK");
    const bid = world.agents.require(old.agentId).homeBuildingId!;
    for (const a of world.allocations.where("buildingId = ?", [bid])) world.budget.retire(a.id);
    expect(world.budget.fundingFor(bid).auth).toBe("subscription");
    const s = world.ops.startSession(old.agentId, { purpose: "work", model: "m", funding: "subscription" });
    world.ops.endSession(s.id, { status: "error", error: LIMIT_MSG });
    const f = world.budget.fundingFor(bid);
    expect(f).toMatchObject({ auth: "api-key", credential: { kind: "api-key", inputId: key.id } });
    expect("fallback" in f).toBe(false);
    void seed;
    world.close();
  });
});
