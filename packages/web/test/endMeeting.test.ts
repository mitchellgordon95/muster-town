import { describe, expect, it } from "vitest";
import { endMeetingConfirm } from "../src/panels/endMeeting";

describe("endMeetingConfirm", () => {
  it("asks before ending a meeting that is still collecting", () => {
    expect(endMeetingConfirm({ phase: "collecting", startedAt: null })).toMatch(/hasn't started yet; end it anyway\? Summaries collected so far are lost\./);
  });
  it("ends a discussing meeting on one click", () => {
    expect(endMeetingConfirm({ phase: "discussing", startedAt: "2026-10-27T00:00:00Z" })).toBeNull();
  });
});
