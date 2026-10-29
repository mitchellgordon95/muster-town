import { describe, expect, test } from "vitest";
import { stayReason, walkIdleHome } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

/** Run walks to the end (8 tiles/s; 100 ms ticks). */
function settle(world: ReturnType<typeof seededWorld>["world"]): void {
  for (let i = 0; i < 300; i++) world.tick(100);
}

/** Put `id`'s body at the Town Hall meeting room, idle (where a finished meeting leaves it today). */
function atTownHall(s: ReturnType<typeof seededWorld>, id: string) {
  const room = s.world.layout.place("meeting-room:town-hall")!;
  s.world.agents.patch(id, { pos: room.pos, status: "idle", currentMeetingId: null });
  return room.pos;
}

describe("bodies go home (flag dc_ihwq7bfi4o)", () => {
  test("a meeting's end walks its attendees back to their desks; an attendee still in a session stays", () => {
    const s = seededWorld();
    const { world, admin } = s;
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    const [a, b] = m.attendeeIds;
    for (const id of [a, b]) atTownHall(s, id);
    world.ops.setMeetingPhase(m.id, "discussing");
    expect(world.agents.require(a).status).toBe("in-meeting");
    world.ops.startSession(b, { purpose: "manage", model: "m" });
    world.ops.endMeeting(admin, m.id);
    settle(world);
    const desk = world.layout.deskOf(a)!;
    expect(world.agents.require(a)).toMatchObject({ pos: desk.pos, status: "idle" });
    expect(world.agents.require(b).pos).not.toEqual(world.layout.deskOf(b)!.pos);
    expect(stayReason(world, b)).toBe("in a session");
  });

  test("a session's end walks the body home", () => {
    const s = seededWorld();
    const noor = s.by("Noor");
    atTownHall(s, noor.id);
    const se = s.world.ops.startSession(noor.id, { purpose: "manage", model: "m" });
    expect(walkIdleHome(s.world)).not.toContain(noor.id); // in a session: the tick leaves it alone
    s.world.ops.endSession(se.id, { status: "done" });
    settle(s.world);
    expect(s.world.agents.require(noor.id).pos).toEqual(s.world.layout.deskOf(noor.id)!.pos);
  });

  test("talking keeps a body where it is for TALK_MS; then the tick walks it home", async () => {
    const s = seededWorld();
    const noor = s.by("Noor");
    atTownHall(s, noor.id);
    await s.world.verbs.say(noor.id, { text: "Over here" });
    expect(stayReason(s.world, noor.id)).toBe("talking");
    expect(walkIdleHome(s.world)).toEqual([]);
    expect(walkIdleHome(s.world, Date.now() + 3 * 60_000)).toEqual([noor.id]);
    settle(s.world);
    expect(s.world.agents.require(noor.id).pos).toEqual(s.world.layout.deskOf(noor.id)!.pos);
  });

  test("a `go` to another agent counts as talking; agents without a desk are left alone", async () => {
    const s = seededWorld();
    const noor = s.by("Noor"), mei = s.by("Mei");
    atTownHall(s, mei.id);
    s.world.agents.patch(mei.id, { status: "working" });
    const walk = s.world.verbs.go(noor.id, { to: mei.id });
    settle(s.world);
    await walk;
    s.world.agents.patch(mei.id, { status: "idle" });
    expect(stayReason(s.world, noor.id)).toBe("talking");
    expect(stayReason(s.world, s.admin.id)).toBe("no body to move");
    const visitor = s.world.agents.first("kind = 'visitor'") ?? s.world.agents.first("kind = 'service'");
    if (visitor) expect(["no desk", "no body to move", "offline"].includes(stayReason(s.world, visitor.id) ?? "")).toBe(true);
  });
});
