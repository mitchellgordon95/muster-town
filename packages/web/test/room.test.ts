import { describe, expect, it } from "vitest";
import type { Meeting } from "@muster-town/schema";
import { roomMeetings } from "../src/panels/room";

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
