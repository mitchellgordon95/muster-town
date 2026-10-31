import { describe, expect, it } from "vitest";
import { BANK_FIXTURES, BANK_LOT, TILE, bankTabOf } from "@muster-town/schema";
import { World, createBuilding, createResident, updateBuilding, findPath, isWalkable, MAX_HEADCOUNT } from "../src/index.ts";
import { freshWorld, seededWorld, tickUntil } from "./helpers.ts";

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("layout", () => {
  it("the Bank sits below the root plaza, clear of every lot, with its counter reachable from the plaza", () => {
    const { world, seed } = seededWorld("tree");
    for (let i = 0; i < 4; i++) createBuilding(world, { name: `Lab ${i}`, headcount: 6 }, seed.admin.id);
    const { grid } = world.layout;
    // its doorstep is on the root plaza
    expect(grid.tiles[(BANK_LOT.y - 1) * grid.w + BANK_LOT.x + BANK_FIXTURES.door.x]).toBe(TILE.PATH);
    expect(BANK_LOT.x + BANK_LOT.w).toBeLessThanOrEqual(grid.w);
    expect(BANK_LOT.y + BANK_LOT.h).toBeLessThanOrEqual(grid.h);
    for (const b of world.buildings.all()) expect(overlap(b.lot!, BANK_LOT), b.name).toBe(false);
    const bank = world.layout.requirePlace("bank");
    expect(bank.kind).toBe("bank");
    expect(isWalkable(grid, bank.pos.x, bank.pos.y)).toBe(true);
    expect(findPath(grid, world.layout.requirePlace("plaza").pos, bank.pos)).not.toBeNull();
    const at = (x: number, y: number) => grid.tiles[(BANK_LOT.y + y) * grid.w + BANK_LOT.x + x];
    expect(at(8, 8)).toBe(TILE.VAULT);
    expect(bank.pos).toEqual({ x: BANK_LOT.x + 8, y: BANK_LOT.y + 7 }); // in front of the vault
    const map = world.layout.requirePlace("bank-map");
    expect(at(14, 2)).toBe(TILE.BANK_MAP);
    expect(findPath(grid, bank.pos, map.pos)).not.toBeNull();
    // the big counter is gone; every tab of the Bank panel is a station in the room, reachable from the door
    expect(grid.tiles.filter((t, i) => t === TILE.COUNTER && world.layout.buildingAt({ x: i % grid.w, y: Math.floor(i / grid.w) }) === null).length).toBe(0);
    for (const st of BANK_FIXTURES.stations) {
      const p = world.layout.requirePlace(`bank:${st.slug}`);
      expect(p.kind).toBe("bank");
      expect(bankTabOf(p.id)).toBe(st.tab);
      for (const c of st.cells) expect(at(c.x, c.y)).toBe(st.tile);
      expect(findPath(grid, world.layout.requirePlace("plaza").pos, p.pos), st.name).not.toBeNull();
    }
    expect(bankTabOf("bank")).toBe("Overview");
    // outside, not in any building
    expect(world.layout.buildingAt(bank.pos)).toBeNull();
  });

  it("every lab gets a schedule board on its back wall (the bottom one: its door is in the top wall), off the desks, reachable from its door", () => {
    const { world, seed } = seededWorld("tree");
    for (const n of [1, 4, 9, MAX_HEADCOUNT]) createBuilding(world, { name: `Lab ${n}`, headcount: n }, seed.admin.id);
    const { grid, places } = world.layout;
    const at = (x: number, y: number) => grid.tiles[y * grid.w + x];
    for (const b of world.buildings.all().filter((x) => x.kind === "lab")) {
      const p = places.find((x) => x.id === `schedule:${b.id}`)!;
      expect(p, b.name).toBeDefined();
      expect(p.kind).toBe("schedule");
      const l = b.lot!, back = l.y + l.h - 1;
      expect(at(p.pos.x, back), b.name).toBe(TILE.SCHEDULE_BOARD);
      expect(Math.abs(p.pos.y - back)).toBe(1);
      expect(isWalkable(grid, p.pos.x, p.pos.y)).toBe(true);
      // nobody's desk seat, and no other place's spot
      for (const d of world.layout.deskSlots(b.id)) expect(d.pos, b.name).not.toEqual(p.pos);
      for (const q of places) if (q.id !== p.id && q.kind !== "plaza") expect(q.pos, `${b.name}: ${q.id}`).not.toEqual(p.pos);
      expect(findPath(grid, world.layout.door(b.id)!, p.pos), b.name).not.toBeNull();
    }
    // the Town Hall keeps its meeting schedule board (on the floor) and gets no timed-jobs board
    expect(places.find((x) => x.id === "schedule:town-hall")).toBeUndefined();
    expect(places.find((x) => x.id === "schedule-board")?.kind).toBe("schedule");
  });

  it("lots never overlap and stay inside the grid, for many buildings of mixed sizes", () => {
    const { world, seed } = seededWorld("tree");
    for (let i = 0; i < 7; i++) createBuilding(world, { name: `Lab ${i}`, headcount: [1, 4, 9, 12, 6, 2, MAX_HEADCOUNT][i] }, seed.admin.id);
    const bs = world.buildings.all();
    expect(bs).toHaveLength(9);
    for (const b of bs) {
      expect(b.lot).toBeDefined();
      expect(b.lot!.x).toBeGreaterThanOrEqual(0);
      expect(b.lot!.x + b.lot!.w).toBeLessThanOrEqual(world.layout.grid.w);
      expect(b.lot!.y + b.lot!.h).toBeLessThanOrEqual(world.layout.grid.h);
    }
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) expect(overlap(bs[i].lot!, bs[j].lot!), `${bs[i].name} vs ${bs[j].name}`).toBe(false);
    // the Town Hall stands at the root, above every lab
    const th = world.buildings.require("town-hall");
    for (const b of bs) if (b.id !== th.id) expect(b.lot!.y, b.name).toBeGreaterThan(th.lot!.y + th.lot!.h);
  });

  it("every desk (free or taken) is reachable from its building's door, and from the plaza", () => {
    const { world, seed } = seededWorld();
    createBuilding(world, { name: "Big", headcount: 12 }, seed.admin.id);
    const plaza = world.layout.requirePlace("plaza").pos;
    for (const b of world.buildings.where("kind = 'lab'")) {
      const door = world.layout.door(b.id)!;
      expect(world.layout.grid.tiles[door.y * world.layout.grid.w + door.x]).toBe(TILE.DOOR);
      const slots = world.layout.deskSlots(b.id);
      expect(slots).toHaveLength(b.headcount);
      for (const s of slots) {
        expect(isWalkable(world.layout.grid, s.pos.x, s.pos.y)).toBe(true);
        expect(findPath(world.layout.grid, door, s.pos), `${b.name} desk ${s.n}`).not.toBeNull();
      }
      expect(findPath(world.layout.grid, plaza, door)).not.toBeNull();
    }
  });

  it("creates the named places", () => {
    const { world, by } = seededWorld();
    for (const id of ["library", "town-map", "planning-desk", "outbox", "meeting-room:town-hall", "plaza", "door:town-hall", "door:carbon-cycle", "meeting-room:carbon-cycle"]) {
      const p = world.layout.requirePlace(id);
      expect(isWalkable(world.layout.grid, p.pos.x, p.pos.y), id).toBe(true);
    }
    const ravi = by("Ravi");
    expect(world.layout.deskOf(ravi.id)?.pos).toEqual(ravi.pos);
    expect(world.layout.places.some((p) => p.id.startsWith("desk:free:carbon-cycle"))).toBe(false); // 5 residents + Moss = 6 = headcount
  });

  it("lots and desks are stable across reopen, and growing headcount re-lots without overlap", () => {
    const { world, dbPath, seed } = seededWorld();
    const before = world.buildings.all().map((b) => [b.id, b.lot]);
    world.close();
    const w2 = World.open(dbPath);
    expect(w2.buildings.all().map((b) => [b.id, b.lot])).toEqual(before);
    const b = createBuilding(w2, { name: "Small", headcount: 1 }, seed.admin.id);
    createResident(w2, { buildingId: b.id, name: "Solo", title: "t", direction: "d" });
    updateBuilding(w2, b.id, { headcount: 9 }); // Desks sets the size; the tree re-lots it
    const all = w2.buildings.all();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i].lot!, all[j].lot!)).toBe(false);
    createResident(w2, { buildingId: b.id, name: "Extra", title: "t", direction: "d" });
    w2.close();
  });
});

describe("pathfinding and movement", () => {
  it("BFS finds shortest 4-neighbour paths and refuses walls", () => {
    const grid = { w: 5, h: 3, tiles: [0, 0, 0, 0, 0, 0, 3, 3, 3, 0, 0, 0, 0, 0, 0] };
    const p = findPath(grid, { x: 0, y: 1 }, { x: 4, y: 1 })!;
    expect(p.at(-1)).toEqual({ x: 4, y: 1 });
    expect(p).toHaveLength(6); // around the wall
    expect(findPath(grid, { x: 0, y: 0 }, { x: 0, y: 0 })).toEqual([]);
    const boxed = { w: 3, h: 3, tiles: [3, 3, 3, 3, 0, 3, 3, 3, 3] };
    expect(findPath(boxed, { x: 1, y: 1 }, { x: 5, y: 5 })).toBeNull();
  });

  it("`go` walks via tick, resolves on arrival, and restores status", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const positions: number[] = [];
    world.changes.subscribe((m) => { if (m.type === "agents.pos") positions.push(m.positions.length); });
    const p = world.verbs.go(noor, { to: "library" });
    await Promise.resolve();
    expect(world.agents.require(noor.id).status).toBe("walking");
    const res = await tickUntil(world, p);
    expect(res.arrived).toBe(true);
    const after = world.agents.require(noor.id);
    expect(after.pos).toEqual(world.layout.requirePlace("library").pos);
    expect(after.status).toBe("idle");
    expect(after.buildingId).toBe("carbon-cycle"); // residents keep their building
    expect(positions.length).toBeGreaterThan(3);
    expect(world.events.list({ agentId: noor.id, types: ["agent.moved"] })).toHaveLength(1);
    // back to desk
    await tickUntil(world, world.verbs.go(noor, { to: `desk:${noor.id}` }));
    expect(world.agents.require(noor.id).pos).toEqual(world.layout.deskOf(noor.id)!.pos);
  });

  it("meeting tables have a seat per attendee, and `go` to a meeting room picks a free one", async () => {
    const { world, seed } = seededWorld();
    for (const id of ["meeting-room:town-hall", "meeting-room:carbon-cycle"]) {
      const room = world.layout.requirePlace(id), seats = world.layout.seatsOf(id);
      expect(seats[0]).toEqual(room.pos);
      expect(seats.length, id).toBeGreaterThanOrEqual(6);
      expect(new Set(seats.map((s) => `${s.x},${s.y}`)).size).toBe(seats.length);
      for (const s of seats) {
        expect(isWalkable(world.layout.grid, s.x, s.y)).toBe(true);
        expect(world.layout.placeAt(s)?.id, `${s.x},${s.y}`).toBe(id);
      }
    }
    const room = "meeting-room:carbon-cycle";
    const visitors = [1, 2, 3, 4].map((i) => world.ops.registerVisitor(seed.admin.id, { name: `V${i}` }).agent);
    // all walk at once: a seat counts as taken as soon as someone is headed for it
    const res = await tickUntil(world, Promise.all(visitors.map((v) => world.verbs.go(v, { to: room }))));
    expect(res.every((r) => r.place === room)).toBe(true);
    const spots = visitors.map((v) => world.agents.require(v.id).pos);
    expect(new Set(spots.map((p) => `${p.x},${p.y}`)).size).toBe(4);
    expect(spots).toEqual(world.layout.seatsOf(room).slice(0, 4));
    // going again keeps your seat
    await tickUntil(world, world.verbs.go(visitors[2], { to: room }));
    expect(world.agents.require(visitors[2].id).pos).toEqual(spots[2]);
  });

  it("visitors' buildingId follows their body; unknown targets fail", async () => {
    const { world, seed } = seededWorld();
    const { agent } = world.ops.registerVisitor(seed.admin.id, { name: "Visitor" });
    expect(agent.buildingId).toBe("town-hall"); // v1.4: a visitor without a building waits at the Town Hall bench
    await tickUntil(world, world.verbs.go(agent, { to: "plaza" }));
    expect(world.agents.require(agent.id).buildingId).toBeNull();
    await tickUntil(world, world.verbs.go(agent, { to: "library" }));
    expect(world.agents.require(agent.id).buildingId).toBe("town-hall");
    await expect(world.verbs.go(agent, { to: "nowhere" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("moveHuman validates walkability", () => {
    const { world, admin } = seededWorld();
    const th = world.buildings.require("town-hall").lot!;
    expect(world.moveHuman(admin.id, th.x, th.y)).toBe(false); // wall corner
    const lib = world.layout.requirePlace("library").pos;
    expect(world.moveHuman(admin.id, lib.x, lib.y)).toBe(true);
    expect(world.agents.require(admin.id).buildingId).toBe("town-hall");
  });

  it("freshWorld with no buildings still has a grid", () => {
    const { world } = freshWorld();
    expect(world.layout.grid.w * world.layout.grid.h).toBe(world.layout.grid.tiles.length);
  });
});

describe("a desk per resident", () => {
  it("a full lab grows by a desk for a new resident (re-lotting when it no longer fits); visitors still wait on the bench", () => {
    const { world, seed } = seededWorld();
    const b = createBuilding(world, { name: "Small", headcount: 1 }, seed.admin.id);
    const ids = ["A", "B", "C", "D"].map((name) => createResident(world, { buildingId: b.id, name, title: "t", direction: "d" }).id);
    expect(world.buildings.require(b.id).headcount).toBe(4);
    const tiles = ids.map((id) => world.layout.deskOf(id)!.pos).map((p) => `${p.x},${p.y}`);
    expect(new Set(tiles).size).toBe(4);
    for (const id of ids) expect(world.agents.require(id).pos).toEqual(world.layout.deskOf(id)!.pos);
    const all = world.buildings.all();
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlap(all[i].lot!, all[j].lot!)).toBe(false);
    const { agent } = world.ops.registerVisitor(seed.admin.id, { name: "V", buildingId: b.id });
    expect(world.layout.deskOf(agent.id)).toBeUndefined();
  });

  it("on reopen, a resident left without a desk gets its own and steps off the desk it shared", () => {
    const { world, dbPath, seed } = seededWorld();
    const b = createBuilding(world, { name: "Shared", headcount: 2 }, seed.admin.id);
    const lena = createResident(world, { buildingId: b.id, name: "Lena", title: "t", direction: "d" });
    const keel = createResident(world, { buildingId: b.id, name: "Keel", title: "t", direction: "d" });
    // legacy data: Keel's desk row is gone, headcount is one short, and Keel stands on Lena's desk
    world.db.prepare("DELETE FROM desks WHERE agentId = ?").run(keel.id);
    world.db.prepare("UPDATE buildings SET headcount = 1 WHERE id = ?").run(b.id);
    world.agents.patch(keel.id, { pos: world.layout.deskOf(lena.id)!.pos });
    world.close();
    const w2 = World.open(dbPath);
    const desk = w2.layout.deskOf(keel.id)!;
    expect(desk).toBeDefined();
    expect(desk.pos).not.toEqual(w2.layout.deskOf(lena.id)!.pos);
    expect(w2.agents.require(keel.id).pos).toEqual(desk.pos);
    expect(w2.buildings.require(b.id).headcount).toBe(2);
    expect(w2.events.list({ types: ["system"] }).some((e) => e.payload.deskRepair && e.agentId === keel.id)).toBe(true);
    w2.close();
    const w3 = World.open(dbPath); // idempotent
    expect(w3.layout.deskOf(keel.id)!.pos).toEqual(desk.pos);
    w3.close();
  });
});
