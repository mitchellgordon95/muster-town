import { describe, expect, it } from "vitest";
import { deskDrop } from "../src/world/desk-drop.ts";
import { seededWorld } from "./helpers.ts";

/** Drag a resident on the map (Mitchell's flag dc_mf6oelioq5): the three drop cases, pure and through ops. */
describe("desk drop", () => {
  const roomOf = (world: ReturnType<typeof seededWorld>["world"], id: string) => {
    const b = world.buildings.require(id);
    return { kind: b.kind, name: b.name, lot: b.lot!, side: world.layout.side(id), pieces: world.layout.pieces(id).pieces };
  };
  const nOf = (world: ReturnType<typeof seededWorld>["world"], agentId: string) =>
    (world.db.prepare("SELECT n FROM desks WHERE agentId = ?").get(agentId) as { n: number }).n;

  it("on another desk the two desk pieces swap; on free floor the desk moves under the drop tile; elsewhere it is refused", () => {
    const { world, by } = seededWorld("tree");
    const room = roomOf(world, "carbon-cycle"), lot = room.lot;
    const ravi = by("Ravi"), n = nOf(world, ravi.id);
    const mine = room.pieces.find((p) => p.key === `desk:${n}`)!;
    const other = room.pieces.find((p) => p.key.startsWith("desk:") && p.key !== mine.key)!;
    // (a) the other desk's stand tile or one of its cells: swap
    const stand = { x: lot.x + other.current.x + other.stands[0].x, y: lot.y + other.current.y + other.stands[0].y };
    const cell = { x: lot.x + other.current.x + 1, y: lot.y + other.current.y };
    for (const to of [stand, cell]) {
      expect(deskDrop(room, "Ravi", n, to)).toEqual({ ok: true, kind: "swap", furniture: { [mine.key]: other.current, [other.key]: mine.current }, withAgentN: Number(other.key.slice(5)) });
    }
    // (b) free floor: the desk's anchor goes where its sitter then stands on the drop tile (the room is mirrored: chair above)
    const free = { x: lot.x + 3, y: lot.y + 1 };
    expect(deskDrop(room, "Ravi", n, free)).toEqual({ ok: true, kind: "move", furniture: { [mine.key]: { x: 3, y: 1 - mine.stands[0].y } }, withAgentN: null });
    // a tile where the desk would break the room (on the wall): refused with the rule
    const wall = { x: lot.x, y: lot.y + 3 };
    expect(deskDrop(room, "Ravi", n, wall)).toMatchObject({ ok: false, message: expect.stringMatching(/^Can't put Ravi's desk there: .*inside the room/) });
    // its own desk: nothing to do
    expect(deskDrop(room, "Ravi", n, { x: lot.x + mine.current.x, y: lot.y + mine.current.y })).toMatchObject({ ok: false, message: /already at that desk/ });
    // (c) outside the room, no desk, the Town Hall
    expect(deskDrop(room, "Ravi", n, { x: lot.x - 3, y: lot.y })).toMatchObject({ ok: false, message: /works in .*Drop them inside it/ });
    expect(deskDrop(room, "Ravi", null, free)).toMatchObject({ ok: false, message: /has no desk/ });
    const hall = roomOf(world, "town-hall");
    expect(deskDrop(hall, "Sec", 0, { x: hall.lot.x + 3, y: hall.lot.y + 3 })).toMatchObject({ ok: false, message: /seats are fixed/ });
  });

  it("ops: a human manager swaps two residents' desks; bodies move at once; desk numbers (fork slots) stay; agents are refused", () => {
    const { world, admin, by } = seededWorld("tree");
    const ravi = by("Ravi"), moss = by("Moss");
    const rn = nOf(world, ravi.id), mn = nOf(world, moss.id);
    const rDesk = world.layout.deskOf(ravi.id)!.pos, mDesk = world.layout.deskOf(moss.id)!.pos;
    world.agents.patch(moss.id, { pos: mDesk });
    // Ravi is elsewhere (not at his desk): the drop still puts him at his new desk
    world.agents.patch(ravi.id, { pos: world.layout.door("carbon-cycle")! });
    expect(() => world.ops.dropAgent(moss, ravi.id, mDesk)).toThrow(/Only humans/);
    const r = world.ops.dropAgent(admin, ravi.id, mDesk);
    expect(r).toMatchObject({ kind: "swap", withAgentId: moss.id, pos: mDesk });
    expect(world.layout.deskOf(ravi.id)!.pos).toEqual(mDesk);
    expect(world.layout.deskOf(moss.id)!.pos).toEqual(rDesk);
    expect(world.agents.require(ravi.id).pos).toEqual(mDesk);
    expect(world.agents.require(moss.id).pos).toEqual(rDesk);
    expect([nOf(world, ravi.id), nOf(world, moss.id)]).toEqual([rn, mn]);
    expect(world.events.recent({ limit: 5 }).some((e) => e.type === "building.layout")).toBe(true);
    // refused drops change nothing
    const before = world.buildings.require("carbon-cycle").furniture;
    expect(() => world.ops.dropAgent(admin, ravi.id, { x: -1, y: -1 })).toThrow(/Drop them inside it/);
    expect(world.buildings.require("carbon-cycle").furniture).toEqual(before);
  });
});
