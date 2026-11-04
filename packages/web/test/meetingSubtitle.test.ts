import { describe, expect, it } from "vitest";
import { MeetingKind } from "@muster-town/schema";
import { MEETING_KIND_WORDS, meetingSubtitle } from "../src/panels/meetingSubtitle";

describe("meetingSubtitle", () => {
  it("says a town-hall meeting in plain words, without repeating Town Hall", () => {
    expect(meetingSubtitle("town-hall", "Town Hall", "Planner")).toBe("Town hall meeting · facilitated by Planner");
  });
  it("names the building for a building meeting", () => {
    expect(meetingSubtitle("standup", "UI / UX", "Teo")).toBe("Standup · UI / UX · facilitated by Teo");
    expect(meetingSubtitle("planning", "Prod", "Cleo")).toBe("Planning meeting · Prod · facilitated by Cleo");
  });
  it("drops an empty building name", () => {
    expect(meetingSubtitle("ad-hoc", undefined, "Pix")).toBe("Meeting · facilitated by Pix");
  });
  it("has plain words for every kind, none a slug", () => {
    for (const k of MeetingKind.options) { expect(MEETING_KIND_WORDS[k]).toBeTruthy(); expect(MEETING_KIND_WORDS[k]).not.toBe(k); expect(MEETING_KIND_WORDS[k]).toMatch(/^[A-Z1]/); }
  });
});
