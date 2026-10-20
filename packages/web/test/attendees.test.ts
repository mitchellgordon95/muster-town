import { describe, expect, it } from "vitest";
import type { Agent } from "@muster-town/schema";
import { attendeeInput, inviteCandidates } from "../src/panels/attendees";

const ag = (id: string, name: string, kind: Agent["kind"], homeBuildingId: string | null, status: Agent["status"] = "idle") => ({ id, name, kind, homeBuildingId, status }) as Agent;

describe("inviteCandidates", () => {
  const agents = [
    ag("a1", "Root", "resident", "workshop"), ag("a2", "Lena", "resident", "workshop"),
    ag("a3", "Moss", "resident", "carbon"), ag("v1", "Guest", "visitor", null),
    ag("h1", "Mitchell", "human", null), ag("s1", "Librarian", "service", null),
    ag("a4", "Gone", "resident", "workshop", "stopped"), ag("a5", "Banned", "resident", "carbon", "banned"),
  ];
  it("splits this building's residents from everyone else who can attend, by name", () => {
    const { home, others } = inviteCandidates(agents, "workshop");
    expect(home.map((a) => a.id)).toEqual(["a2", "a1"]);
    expect(others.map((a) => a.id)).toEqual(["v1", "a3"]);
  });
  it("lists this building's stopped residents as unavailable instead of dropping them", () => {
    expect(inviteCandidates(agents, "workshop").unavailable.map((a) => a.id)).toEqual(["a4"]);
    expect(inviteCandidates([...agents, ag("a6", "Old", "resident", "workshop", "retired")], "workshop").unavailable.map((a) => a.id)).toEqual(["a4"]);
    expect(inviteCandidates(agents, null).unavailable).toEqual([]);
  });
  it("has no home group for the town hall", () => {
    const { home, others } = inviteCandidates(agents, null);
    expect(home).toEqual([]);
    expect(others.map((a) => a.name)).toEqual(["Guest", "Lena", "Moss", "Root"]);
  });
});

describe("attendeeInput", () => {
  it("omits attendeeIds when nobody is picked, so the server invites its defaults", () => {
    expect(attendeeInput(new Set())).toEqual({});
    expect(attendeeInput(new Set(["a1", "a3"]))).toEqual({ attendeeIds: ["a1", "a3"] });
  });
});
