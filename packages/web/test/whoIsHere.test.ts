import { describe, expect, it } from "vitest";
import type { Agent } from "@muster-town/schema";
import { whoIsHere } from "../src/whoIsHere";

const base = { ownerUserId: null, inheritsOwner: false, deniedPermissions: [], activity: "", model: null, spentTokensToday: 0, spentTokensTotal: 0, spentUsdTotal: 0, currentAssignmentId: null, currentMeetingId: null, createdAt: "2026-10-26T00:00:00Z", lastActiveAt: null, lastSeenAt: null, title: "", direction: "", sprite: 0, pos: { x: 0, y: 0 }, homeBuildingId: null } as const;
const ag = (id: string, kind: Agent["kind"], status: Agent["status"], buildingId: string | null, extra: Partial<Agent> = {}): Agent => ({ ...base, id, name: id, kind, status, buildingId, ...extra });
const now = Date.parse("2026-10-26T12:00:00Z");

describe("whoIsHere", () => {
  it("lists working agents with the busiest building first, counts resting ones and humans active in the last 10 min", () => {
    const agents = Object.fromEntries([
      ag("zed", "resident", "working", "b1"), ag("amy", "resident", "working", "b2"), ag("bob", "resident", "in-meeting", "b2"),
      ag("idle", "resident", "idle", "b1"), ag("walk", "visitor", "walking", null), ag("off", "visitor", "offline", null), ag("stop", "resident", "stopped", "b1"),
      ag("ada", "service", "idle", null),
      ag("mitch", "human", "idle", null, { lastActiveAt: new Date(now - 60_000).toISOString() }),
      ag("gone", "human", "idle", null, { lastActiveAt: new Date(now - 3_600_000).toISOString() }),
      ag("never", "human", "idle", null),
    ].map((a) => [a.id, a]));
    const w = whoIsHere(agents, now);
    expect(w.working.map((a) => a.id)).toEqual(["amy", "bob", "zed"]);
    expect(w.resting).toBe(2);
    expect(w.humans).toBe(1);
  });
  it("is empty for an empty town", () => {
    expect(whoIsHere({}, now)).toEqual({ working: [], resting: 0, humans: 0 });
  });
});
