import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBuilding, createUser, townRoleId, World } from "../src/index.ts";
import { freshWorld, REPO_ROOT } from "./helpers.ts";

/** A hosted collective's collective.json as hub.create writes it (the Start form's name and goal, no buildings). */
function startJson(dir: string): string {
  const p = join(dir, "collective.json");
  writeFileSync(p, JSON.stringify({ name: "Hollyville", goal: "Make money", buildings: [] }, null, 2) + "\n");
  return p;
}

/** The founder signs in with GitHub and is made admin, as hub.open does. */
function founderOf(world: World) {
  const u = createUser(world, "Edward Li").user;
  world.users.upsert({ ...u, githubId: 777, githubLogin: "edwadli" });
  world.permissions.grant({ kind: "user", id: u.id }, townRoleId("admin"));
  world.goalTree.ensureRootCaptain();
  return u;
}

const kids = (world: World) => world.goalTree.children("gl_town").map((g) => g.id);

describe("a hosted collective's goal tree is the founder's (gr_5ltmbf3a2f, kr_n2zh7s6s2s)", () => {
  it("a hosted seed: root = the Start form's goal, the founder captains it, no Fund/Join/Trust pillars", () => {
    const { world, dir } = freshWorld();
    world.host.hosted = true;
    const json = startJson(dir);
    world.seedDefaults({ adminName: "admin", townJsonPath: json, collectivePath: json, dataDir: dir });
    const founder = founderOf(world);
    const root = world.goalTree.require("gl_town");
    expect(root.text).toBe("Make money");
    expect(root.ownerId).toBe(founder.id);
    expect(kids(world)).toEqual([]);
    expect(world.goalTree.tree().children).toEqual([]);
  });

  it("a hub seed (the Workshop's town.json) keeps its pillars", () => {
    const { world, dir } = freshWorld();
    const json = join(REPO_ROOT, "town.json");
    world.seedDefaults({ townJsonPath: json, collectivePath: json, dataDir: dir });
    expect(kids(world)).toEqual(expect.arrayContaining(["gl_fund", "gl_join", "gl_trust"]));
  });

  it("an existing hosted DB (Hollyville, seeded with the pillars) retires the empty ones on its next boot; a used one stays", () => {
    const { world, dir, dbPath } = freshWorld();
    const json = startJson(dir);
    // seeded before this change: the pillars are there
    const seed = world.seedDefaults({ adminName: "admin", townJsonPath: json, collectivePath: json, dataDir: dir });
    founderOf(world);
    expect(kids(world)).toEqual(["gl_fund", "gl_join", "gl_trust"]);
    // the founder put a building under Join: that pillar is theirs now
    createBuilding(world, { name: "Lab", goal: "", description: "", headcount: 1 }, seed.admin.id);
    const lab = world.buildings.first("kind = 'lab'")!;
    world.buildings.upsert({ ...lab, goalId: "gl_join" });
    world.close();
    // the next boot, as hub.open does it
    const again = World.open(dbPath);
    again.host.hosted = true;
    again.seedDefaults({ adminName: "admin", townJsonPath: json, collectivePath: json, dataDir: dir });
    expect(kids(again)).toEqual(["gl_join"]);
    expect(again.goalTree.require("gl_town").text).toBe("Make money");
    // idempotent
    expect(again.goalTree.dropPlaceholderPillars()).toEqual([]);
    again.close();
  });
});
