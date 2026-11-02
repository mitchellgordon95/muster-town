import { describe, expect, test } from "vitest";
import type { AuthMe, Event } from "@muster-town/schema";
import { accessDecisionToast, isMyAccessDecision, store } from "../src/state";

const ev = (payload: Record<string, unknown>, id = 1): Event =>
  ({ id, ts: "2026-10-29T23:00:00.000Z", type: "system", agentId: null, buildingId: null, text: "x", payload }) as Event;
const me = (canInteract: boolean, status: "pending" | "granted" | "declined" | null): AuthMe =>
  ({ user: { id: "us_me" }, roles: [], avatarAgentId: "ag_me", isAdmin: false, canInteract,
    accessRequest: status ? { status, message: "", decidedAt: status === "pending" ? null : "2026-10-29T23:00:00.000Z" } : null }) as unknown as AuthMe;

describe("a join request decided live (flag dc_1kylouq1l7)", () => {
  test("only the decision on my own request counts; the ask itself and other people's don't", () => {
    expect(isMyAccessDecision(ev({ accessRequestId: "ar_1", userId: "us_me", granted: true }), "us_me")).toBe(true);
    expect(isMyAccessDecision(ev({ accessRequestId: "ar_1", userId: "us_me", granted: false }), "us_me")).toBe(true);
    expect(isMyAccessDecision(ev({ accessRequestId: "ar_1", userId: "us_me" }), "us_me")).toBe(false);
    expect(isMyAccessDecision(ev({ accessRequestId: "ar_2", userId: "us_other", granted: true }), "us_me")).toBe(false);
    expect(isMyAccessDecision(ev({ accessRequestId: "ar_1", userId: "us_me", granted: true }), undefined)).toBe(false);
  });

  test("the event over the socket refetches me; other events don't", () => {
    let calls = 0;
    store.onAccessDecided = () => { calls++; };
    store.set({ me: me(false, "pending") });
    store.receive({ type: "event", event: ev({ accessRequestId: "ar_2", userId: "us_other", granted: true }, 10) });
    expect(calls).toBe(0);
    store.receive({ type: "event", event: ev({ accessRequestId: "ar_1", userId: "us_me", granted: true }, 11) });
    expect(calls).toBe(1);
    store.mergeEvents([ev({ accessRequestId: "ar_1", userId: "us_me", granted: false }, 12)]);
    expect(calls).toBe(2);
  });

  test("toasts only on a decline; being let in is the HUD's You're in card, not a toast", () => {
    expect(accessDecisionToast(me(false, "pending"), me(true, "granted"))).toBeNull();
    expect(accessDecisionToast(me(false, "pending"), me(false, "declined"))?.tone).toBe("info");
    expect(accessDecisionToast(me(true, "granted"), me(true, "granted"))).toBeNull();
    expect(accessDecisionToast(me(false, "declined"), me(false, "declined"))).toBeNull();
  });
});
