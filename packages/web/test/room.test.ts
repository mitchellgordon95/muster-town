import { describe, expect, it } from "vitest";
import type { Meeting } from "@muster-town/schema";
import { buildingMeetings, redirectPanel, roomMeetings } from "../src/panels/room";

const mt = (id: string, phase: Meeting["phase"], createdAt: string, buildingId: string | null = "workshop") => ({ id, phase, createdAt, buildingId }) as Meeting;

describe("roomMeetings", () => {
  it("frees the room once its meeting is done, so a second meeting can be called", () => {
    const first = mt("m1", "done", "2026-10-20T01:00:00Z");
    expect(roomMeetings([first], "workshop", false)).toEqual({ live: null, last: first });
  });
  it("shows the live meeting over finished ones", () => {
    const first = mt("m1", "done", "2026-10-20T01:00:00Z");
    const second = mt("m2", "discussing", "2026-10-20T02:00:00Z");
    const cancelled = mt("m3", "cancelled", "2026-10-20T03:00:00Z");
    expect(roomMeetings([first, second, cancelled], "workshop", false)).toEqual({ live: second, last: cancelled });
  });
  it("only counts this building's meetings; the town hall also takes building-less ones", () => {
    const other = mt("m1", "collecting", "2026-10-20T01:00:00Z", "carbon");
    const hall = mt("m2", "scheduled", "2026-10-20T02:00:00Z", null);
    expect(roomMeetings([other, hall], "workshop", false)).toEqual({ live: null, last: null });
    expect(roomMeetings([other, hall], "town-hall", true)).toEqual({ live: hall, last: hall });
  });
});

describe("buildingMeetings (the meeting table's list)", () => {
  it("splits a building's meetings, 1:1s included, into upcoming and past, newest first", () => {
    const done = mt("m1", "done", "2026-10-20T01:00:00Z");
    const oneOnOne = { ...mt("m2", "discussing", "2026-10-20T02:00:00Z"), kind: "one-on-one" } as Meeting;
    const scheduled = mt("m3", "scheduled", "2026-10-20T03:00:00Z");
    const cancelled = mt("m4", "cancelled", "2026-10-20T04:00:00Z");
    const elsewhere = mt("m5", "scheduled", "2026-10-20T05:00:00Z", "carbon");
    expect(buildingMeetings([done, oneOnOne, scheduled, cancelled, elsewhere], "workshop", false)).toEqual({ upcoming: [scheduled, oneOnOne], past: [cancelled, done] });
  });
});

describe("redirectPanel", () => {
  it("sends a link into the old building Meetings tab to that building's meeting room", () => {
    expect(redirectPanel({ kind: "building", id: "workshop", tab: "Meetings" })).toEqual({ kind: "meeting", id: "room:workshop" });
  });
  it("leaves other panels alone and still maps admin to the planning desk", () => {
    const overview = { kind: "building", id: "workshop", tab: "Overview" } as const;
    expect(redirectPanel(overview)).toBe(overview);
    expect(redirectPanel({ kind: "meeting", id: "mt_1" })).toEqual({ kind: "meeting", id: "mt_1" });
    expect(redirectPanel({ kind: "admin", tab: "System" })).toEqual({ kind: "planning", tab: "System" });
    expect(redirectPanel(null)).toBeNull();
  });
});
