/** v1.2: dismiss, role migration from a v1.1 DB, places, reconcile, collective moderators. */
import Database from "better-sqlite3";
import { BUILTIN_ROLES, Permission } from "@muster-town/schema";
import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildingRoleId, createResident, findPath, TOWN_HALL_ID, townRoleId, World } from "../src/index.ts";
import { migrate } from "../src/db.ts";
import { freshWorld, seededWorld, tempDir } from "./helpers.ts";

describe("dismiss", () => {
  it("frees the desk, revokes tokens, removes memberships, cancels assignments, keeps docs; retired hidden from the snapshot", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const token = world.tokens.getOrCreate("agent", mei.id);
    const { id: docId } = await world.verbs.write(mei, { title: "Kept", body: "b", state: "building" });
    const pending = world.ops.createWork(admin, mei.id, { title: "Queued" });
    const deskPos = world.layout.deskOf(mei.id)!.pos;

    // permission: a member can't dismiss
    expect(() => world.ops.dismissAgent(by("Tomas"), mei.id)).toThrow(/building.manage/);
    const r = world.ops.dismissAgent(admin, mei.id, { purge: true });
    expect(r.agent.status).toBe("retired");
    expect(r.cancelledAssignments).toEqual([pending.id]);
    expect(r.deskFreed).toBe(true);
    expect(world.assignments.require(pending.id).status).toBe("cancelled");
    expect(world.tokens.resolve(token)).toBeUndefined();
    expect(world.memberships.forHolder("agent", mei.id)).toEqual([]);
    expect(world.layout.deskOf(mei.id)).toBeUndefined();
    expect(world.layout.places.find((p) => p.pos.x === deskPos.x && p.pos.y === deskPos.y && p.kind === "desk")!.id).toMatch(/^desk:free:carbon-cycle:/);
    expect(world.docs.require(docId).authorId).toBe(mei.id);
    expect(world.agents.get(mei.id)).toBeDefined();
    expect(world.snapshot().agents.some((a) => a.id === mei.id)).toBe(false);
    const ev = world.events.list({ types: ["agent.retired"] }).at(-1)!;
    expect(ev).toMatchObject({ agentId: mei.id, payload: { purge: true } });
    await expect(world.verbs.look(mei.id, {})).rejects.toMatchObject({ code: "forbidden" });
    expect(() => world.ops.dismissAgent(admin, mei.id)).toThrow(/already dismissed/);
    // the freed desk can be taken by a new resident
    const fresh = createResident(world, { buildingId: "carbon-cycle", name: "Fern", title: "t", direction: "d" });
    expect(world.layout.deskOf(fresh.id)!.pos).toEqual(deskPos);
  });
});

describe("role migration (v1.1 DB)", () => {
  /**
   * A v1.1 DB built forward: a fresh file with only migrations 001–004 applied (the v1.1 schema), then the v1.1 data by SQL.
   * World.open then runs every later migration on it, so adding a migration never needs an edit here.
   */
  function v11Db(): string {
    const dir = tempDir(), dbPath = join(dir, "town.db"), migrations = join(dir, "migrations");
    mkdirSync(migrations);
    const all = join(import.meta.dirname, "..", "migrations");
    for (const f of readdirSync(all).filter((f) => /^00[1-4]_.*\.sql$/.test(f))) copyFileSync(join(all, f), join(migrations, f));
    const db = new Database(dbPath);
    expect(migrate(db, migrations)).toBe(4);
    const now = new Date().toISOString(), pos = JSON.stringify({ x: 1, y: 1 });
    const oldManager = ["building.manage", "building.assign", "building.review", "building.ban", "building.promote", "doc.write_building", "doc.propose_trophy", "doc.request_human", "meeting.facilitate", "meeting.attend"];
    const oldModerator = ["building.review", "building.ban", "building.promote", "building.assign", "doc.write_building", "doc.propose_trophy", "meeting.attend"];
    const oldAdmin = ["town.manage_buildings", "town.manage_roles", "town.allocate_budget", "town.approve_trophy", "town.approve_request", "building.manage", "building.assign", "building.review", "building.ban", "building.promote", "doc.write_building", "doc.propose_trophy", "doc.request_human", "meeting.facilitate", "meeting.attend"];
    db.prepare("INSERT INTO users (id, name, createdAt) VALUES ('us_admin', 'Admin', ?)").run(now);
    const building = db.prepare("INSERT INTO buildings (id, name, kind, headcount, reviewPolicy, createdAt) VALUES (?, ?, ?, ?, ?, ?)");
    building.run(TOWN_HALL_ID, "Town Hall", "town-hall", 1, "human", now);
    building.run("carbon-cycle", "Carbon Cycle Lab", "lab", 3, "moderator", now);
    const role = db.prepare("INSERT INTO roles (id, name, scope, buildingId, permissions, builtin) VALUES (?, ?, ?, ?, ?, 1)");
    role.run("role:admin", "admin", "town", null, JSON.stringify(oldAdmin));
    role.run("role:carbon-cycle:manager", "manager", "building", "carbon-cycle", JSON.stringify(oldManager));
    role.run("role:carbon-cycle:moderator", "moderator", "building", "carbon-cycle", JSON.stringify(oldModerator));
    const agent = db.prepare("INSERT INTO agents (id, name, kind, buildingId, homeBuildingId, title, pos, status, createdAt) VALUES (?, ?, 'resident', 'carbon-cycle', 'carbon-cycle', ?, ?, ?, ?)");
    agent.run("ag_moss", "Moss", "Reviewer", pos, "idle", now);
    agent.run("ag_ravi", "Ravi", "Researcher", pos, "awaiting-review", now);
    const member = db.prepare("INSERT INTO memberships (roleId, holderKind, holderId) VALUES (?, ?, ?)");
    member.run("role:admin", "user", "us_admin");
    member.run("role:carbon-cycle:moderator", "agent", "ag_moss");
    expect((db.prepare("SELECT version FROM schema_version ORDER BY version").all() as { version: number }[]).map((r) => r.version)).toEqual([1, 2, 3, 4]);
    db.close();
    return dbPath;
  }

  it("renames moderator → reviewer, fixes manager/admin permissions, creates the town moderator role, maps statuses and policy", () => {
    const dbPath = v11Db();
    const w = World.open(dbPath);
    try {
      expect(w.roles.get("role:carbon-cycle:moderator")).toBeUndefined();
      const reviewer = w.roles.require(buildingRoleId("carbon-cycle", "reviewer"));
      expect(reviewer).toMatchObject({ name: "reviewer", scope: "building", buildingId: "carbon-cycle", builtin: true, permissions: BUILTIN_ROLES.building.reviewer });
      const moss = w.agents.first("name = 'Moss'")!;
      expect(w.permissions.can(moss, "building.review", "carbon-cycle")).toBe(true);
      const manager = w.roles.require(buildingRoleId("carbon-cycle", "manager")).permissions;
      expect(manager).toContain("building.dismiss");
      expect(manager).not.toContain("building.ban" as never);
      expect(w.roles.require(townRoleId("admin")).permissions.sort()).toEqual([...Permission.options].sort());
      expect(w.roles.require(townRoleId("moderator")).permissions).toEqual(BUILTIN_ROLES.town.moderator);
      expect(w.agents.first("name = 'Ravi'")!.status).toBe("idle");
      // the seed-on-open path creates no moderator agents in an existing DB
      const before = w.agents.count();
      const res = w.seedDefaults({});
      expect(res.created).toBe(false);
      expect(res.moss?.name).toBe("Moss");
      expect(w.agents.count()).toBe(before);
    } finally {
      w.close();
    }
    // idempotent on the next open
    const w2 = World.open(dbPath);
    expect(w2.roles.where("name = 'reviewer' AND buildingId = 'carbon-cycle'")).toHaveLength(1);
    w2.close();
  });
});

describe("v1.2 places", () => {
  it("each lab has a board, a filing cabinet and an in-tray; Town Hall has the mod station, planning desk, its in-tray, schedule board (no donation box: donating is at the Bank); all reachable", () => {
    const { world, by } = seededWorld();
    const door = world.layout.requirePlace("door:carbon-cycle").pos;
    const plaza = world.layout.requirePlace("plaza").pos;
    const expected = {
      "board:carbon-cycle": "board", "cabinet:carbon-cycle": "cabinet", "intray:carbon-cycle": "intray",
      "mod-station": "mod-station", "planning-desk": "planning", "schedule-board": "schedule", "intray:town-hall": "intray",
    } as const;
    for (const [id, kind] of Object.entries(expected)) {
      const p = world.layout.requirePlace(id);
      expect(p.kind, id).toBe(kind);
      expect(findPath(world.layout.grid, door, p.pos), `${id} from lab door`).not.toBeNull();
      expect(findPath(world.layout.grid, plaza, p.pos), `${id} from plaza`).not.toBeNull();
      expect(world.snapshot().places.some((x) => x.id === id)).toBe(true);
    }
    const g = world.layout.grid, tile = (x: number, y: number) => g.tiles[y * g.w + x];
    const lab = world.buildings.require("carbon-cycle").lot!;
    const board = world.layout.requirePlace("board:carbon-cycle").pos;
    expect(tile(board.x, lab.y + lab.h - 1)).toBe(12); // TILE.BOARD on the back wall (the bottom one: the door is in the top wall)
    const cabinet = world.layout.requirePlace("cabinet:carbon-cycle").pos;
    expect(tile(cabinet.x + 1, cabinet.y)).toBe(15); // TILE.CABINET to the right of where you stand...
    expect(tile(cabinet.x + 2, cabinet.y)).toBe(3); // ...against the right wall (TILE.WALL)
    const seats = world.layout.seatsOf("meeting-room:carbon-cycle");
    for (const p of [board, world.layout.requirePlace("intray:carbon-cycle").pos, ...seats, ...world.layout.deskSlots("carbon-cycle").map((d) => d.pos)]) {
      expect(p, "cabinet tile overlaps a standing tile").not.toEqual({ x: cabinet.x + 1, y: cabinet.y });
      expect(p, "cabinet stand shared with another fixture").not.toEqual(cabinet);
    }
    const intray = world.layout.requirePlace("intray:carbon-cycle").pos;
    expect(tile(intray.x, intray.y + 1)).toBe(11); // TILE.MANAGER_DESK (below where you stand: the room is mirrored)
    expect(g.tiles).not.toContain(13); // DONATION: the box is gone
    expect(world.layout.places.some((p) => p.kind === "donation")).toBe(false);
    expect(g.tiles).toContain(14); // SCHEDULE
    // `look` lists them (in my building: board + in-tray; Town Hall stations anywhere)
    return world.verbs.look(by("Ravi"), {}).then((l) => {
      const ids = l.places.map((p) => p.id);
      for (const id of Object.keys(expected)) expect(ids, id).toContain(id);
    });
  });
});

describe("reconcile", () => {
  it("ends orphaned running sessions and puts their active assignments back to pending", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    const a1 = world.ops.createWork(admin, mei.id, { title: "One" });
    const s1 = world.ops.startSession(mei.id, { purpose: "work", model: "m", assignmentId: a1.id });
    const a2 = world.ops.createWork(admin, noor.id, { title: "Two" });
    const s2 = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: a2.id });
    const r = world.ops.reconcile([noor.id]); // Noor's child is live, Mei's isn't
    expect(r.orphanedSessions).toEqual([s1.id]);
    expect(world.sessions.require(s1.id)).toMatchObject({ status: "interrupted", error: "cut by restart" });
    expect(world.assignments.require(a1.id).status).toBe("pending");
    expect(world.agents.require(mei.id)).toMatchObject({ status: "idle", currentAssignmentId: null });
    expect(world.sessions.require(s2.id).status).toBe("running");
    expect(world.assignments.require(a2.id).status).toBe("active");
  });
});

describe("collective moderators and reviewers", () => {
  it("seeds town moderators at the mod station with the town moderator role; building reviewer gets the reviewer role", () => {
    const { world } = freshWorld();
    const dir = tempDir();
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({
      name: "T", goal: "", moderators: [{ name: "Wren", sprite: 6 }],
      buildings: [{ id: "lab", name: "Lab", residents: [{ name: "A", title: "x", direction: "y" }], reviewer: { name: "Keel" } }],
    }));
    const seed = world.seedDefaults({ collectivePath: cfg, townJsonPath: cfg });
    const wren = seed.moderators[0]!;
    expect(wren).toMatchObject({ name: "Wren", kind: "resident", homeBuildingId: TOWN_HALL_ID, sprite: 6, title: "Moderator" });
    expect(world.permissions.can(wren, "town.ban")).toBe(true);
    expect(world.permissions.can(wren, "town.moderate")).toBe(true);
    const seat = world.layout.deskOf(wren.id)!;
    expect(seat.buildingId).toBe(TOWN_HALL_ID);
    expect(wren.pos).toEqual(seat.pos);
    const stand = world.layout.requirePlace("mod-station").pos;
    expect(Math.abs(seat.pos.x - stand.x) + Math.abs(seat.pos.y - stand.y)).toBeLessThanOrEqual(4);
    const keel = world.agents.first("name = 'Keel'")!;
    expect(world.memberships.forRole(buildingRoleId("lab", "reviewer")).map((m) => m.holderId)).toEqual([keel.id]);
  });
});
