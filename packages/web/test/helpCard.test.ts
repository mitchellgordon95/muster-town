import { describe, expect, it } from "vitest";
import type { Agent, Place } from "@muster-town/schema";
import { helpCard } from "../src/panels/helpCard";

const lab = { id: "bl_a", name: "Onboarding", kind: "lab" as const, goal: "Minimize confusion when joining", managerAgentId: "ag_k" };
const place = (id: string, kind: Place["kind"]): Place => ({ id, kind, name: id, buildingId: "bl_a", pos: { x: 0, y: 0 } });
const places = [place("board:bl_a", "board"), place("cabinet:bl_a", "cabinet"), place("intray:bl_a", "intray"), place("schedule:bl_a", "schedule"),
  place("meeting-room:bl_a", "meeting-room"), place("desk:free:bl_a:1", "desk"), place("desk:ag_k", "desk"), place("help:bl_a", "help"), place("door:bl_a", "door")];
const agent = (id: string, name: string, status: Agent["status"]) => ({ id, name, status, kind: "resident", buildingId: "bl_a" }) as Agent;
const agents = { ag_k: agent("ag_k", "Kelly", "working"), ag_1: agent("ag_1", "Kelly 1", "idle") };
const can = { talk: false, flag: false, touch: false };

describe("a building's help sign (flag dc_8dwch9z5pi)", () => {
  it("names the building, its goal, its manager and who is here, from live data", () => {
    const c = helpCard(lab, places, agents, "guest", can);
    expect(c).toMatchObject({ title: "Onboarding", goal: "Minimize confusion when joining", resting: 1 });
    expect(c.manager?.name).toBe("Kelly");
    expect(c.working.map((a) => a.name)).toEqual(["Kelly"]);
  });

  it("lists each thing in the room once, desks pointing at an occupied one, never the sign or the door", () => {
    const c = helpCard(lab, places, agents, "guest", can);
    expect(c.things.map((t) => t.name)).toEqual(["Board", "Filing cabinet", "In-tray", "Schedule board", "Meeting table", "Desks"]);
    expect(c.things.find((t) => t.name === "Desks")!.placeId).toBe("desk:ag_k");
  });

  it("tells a stranger to read and ask to join, a member to talk and flag, a reviewer to work the in-tray", () => {
    expect(helpCard(lab, places, agents, "guest", can).todo.join(" ")).toMatch(/sign in with GitHub, then Ask to join/);
    expect(helpCard(lab, places, agents, "pending", can).todo.join(" ")).toMatch(/Ask to join on your card/);
    const member = helpCard(lab, places, agents, "member", { talk: true, flag: true, touch: false }).todo;
    expect(member[0]).toBe("Talk to the manager: click ★ Kelly, then Talk.");
    expect(member.join(" ")).toMatch(/Plant a flag \(F\)/);
    expect(helpCard(lab, places, agents, "member", can).todo.join(" ")).not.toMatch(/Talk|flag/);
    expect(helpCard(lab, places, agents, "reviewer", can).todo[0]).toMatch(/^Review reports in the in-tray/);
  });

  it("says tap on a touch screen, and the Town Hall lists its own things", () => {
    expect(helpCard(lab, places, agents, "guest", { ...can, touch: true }).todo.join(" ")).toMatch(/Tap an agent/);
    const hall = { ...lab, id: "town-hall", name: "Town Hall", kind: "town-hall" as const };
    const hp = ["board", "hydrant", "goal-tree", "library", "outbox", "stats", "planning", "mod-station"].map((k) => ({ ...place(`${k}:x`, k as Place["kind"]), buildingId: "town-hall" }));
    expect(helpCard(hall, hp, {}, "guest", can).things.map((t) => t.name)).toEqual(["Board", "Hydrant", "Goal tree", "Library", "Outbox", "User stats", "Planning desk", "Mod station"]);
  });
});
