import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeWorkBrief, deskWorkspace, originUrl } from "../src/index.ts";
import { freshWorld, REPO_ROOT, seededWorld } from "./helpers.ts";

describe("interrupt queue", () => {
  test("enqueue binds to the running work session; pending filters by session; ack marks delivered", () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const early = world.ops.enqueueInterrupt(noor.id, "before any session", "Mitchell");
    expect(early.sessionId).toBeNull();
    const asg = world.ops.createWork(null, noor.id, {});
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id, backend: "docker" });
    expect(s.backend).toBe("docker");
    const it = world.ops.enqueueInterrupt(noor.id, "Focus on 13C", "Mitchell");
    expect(it).toMatchObject({ agentId: noor.id, sessionId: s.id, text: "Focus on 13C", from: "Mitchell", deliveredAt: null });
    world.interrupts.upsert({ ...it, id: "in_other", sessionId: "se_other" });
    expect(world.ops.pendingInterrupts(noor.id, s.id).map((i) => i.id)).toEqual([early.id, it.id]);
    expect(world.ops.pendingInterrupts(noor.id)).toHaveLength(3);
    expect(world.ops.ackInterrupts([it.id, early.id], noor.id)).toBe(2);
    expect(world.ops.ackInterrupts([it.id])).toBe(0);
    expect(world.interrupts.require(it.id).deliveredAt).toBeTruthy();
    expect(world.ops.pendingInterrupts(noor.id, s.id)).toEqual([]);
    expect(world.events.list({ agentId: noor.id, types: ["system"] }).some((e) => e.payload.queued)).toBe(true);
  });

  test("sessions default to the host backend", () => {
    const { world, by } = seededWorld();
    const s = world.ops.startSession(by("Mei").id, { purpose: "review", model: "m" });
    expect(world.sessions.require(s.id).backend).toBe("host");
  });
});

describe("work brief", () => {
  test("composes system/prompt for the session's agent, assignment and building", () => {
    const { world, by, seed } = seededWorld();
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Measure the growth rate", description: "Use NOAA." });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id, backend: "docker" });
    const b = composeWorkBrief(world, s.id);
    expect(b.agent.id).toBe(noor.id);
    expect(b.building.id).toBe(seed.lab!.id);
    expect(b.assignment?.id).toBe(asg.id);
    expect(b.session.id).toBe(s.id);
    expect(b.town.name).toBe(world.town.get().name);
    expect(b.system).toContain(`You are ${noor.name}`);
    expect(b.system).toContain("own desk");
    expect(b.prompt).toContain("Measure the growth rate");
    expect(b.workspace).toBeUndefined();
  });

  test("buildings with code access get the collective repo's repoUrl/base/branch/dir", () => {
    const { world, by, seed } = seededWorld();
    world.town.set({ workspace: { path: REPO_ROOT, repoUrl: "git@github.com:me/agent-town.git", base: "main", branchPrefix: "agent", tools: [] } });
    const noor = by("Noor");
    expect(deskWorkspace(world.town.get(), seed.lab!, noor, null)).toBeUndefined(); // a collective repo alone grants nothing
    world.ops.updateBuilding(null, seed.lab!.id, { codeAccess: true });
    const asg = world.ops.createWork(null, noor.id, { title: "Fix the HUD!" });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id });
    const b = composeWorkBrief(world, s.id);
    expect(b.workspace).toEqual({ repoUrl: "https://github.com/me/agent-town.git", base: "main", branchPrefix: "agent", branch: "agent/noor/fix-the-hud", dir: "/home/agent/work/agent-town" });
    expect(b.system).toContain("/home/agent/work/agent-town");
  });
});

describe("seed", () => {
  test("the collective repo gets repoUrl from origin; buildings opt in with codeAccess; desks config is stored", () => {
    const { world, dir } = freshWorld();
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({
      name: "T", goal: "", desks: { backend: "host" }, workspace: { path: REPO_ROOT },
      buildings: [
        { id: "ws", name: "WS", codeAccess: true, residents: [{ name: "Pix", title: "x", direction: "y" }] },
        { id: "research", name: "Research", codeAccess: false },
        { id: "later", name: "Later" },
      ],
    }));
    world.seedDefaults({ collectivePath: cfg });
    expect(world.town.get().workspace?.repoUrl).toBe(originUrl(REPO_ROOT));
    expect(world.buildings.require("ws").codeAccess).toBe(true);
    expect(world.buildings.require("research").codeAccess).toBe(false);
    expect(world.buildings.require("later").codeAccess).toBe(true); // inherits the collective repo by default
    expect(world.buildings.first("kind = 'town-hall'")!.codeAccess).toBe(false);
    expect(world.desksConfig()).toEqual({ backend: "host", image: "muster-town-desk", ghToken: "gh-cli", snapshot: "muster-town-desk", maxRunning: 20 });
  });

  test("on a later boot, the desks keys collective.json spells out win; the ones it leaves out keep their stored value", () => {
    const { world, dir } = freshWorld();
    const cfg = join(dir, "collective.json");
    const write = (desks: object) => writeFileSync(cfg, JSON.stringify({ name: "T", goal: "", desks, buildings: [{ id: "ws", name: "WS" }] }));
    write({ backend: "host" });
    world.seedDefaults({ collectivePath: cfg });
    world.setDesksConfig({ maxRunning: 7 }); // set live, as PUT /api/town/desks does
    write({ backend: "fly", townUrl: "https://t.example" });
    world.seedDefaults({ collectivePath: cfg }); // existing town: the seed's early-return path
    expect(world.desksConfig()).toMatchObject({ backend: "fly", townUrl: "https://t.example", maxRunning: 7 });
  });

  test("an ssh origin is stored as-is and handed to desks as https", () => {
    const { world, dir } = freshWorld();
    const repo = join(dir, "repo");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:me/agent-town.git"]);
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({
      name: "T", goal: "", workspace: { path: repo },
      buildings: [{ id: "ws", name: "WS", codeAccess: true, residents: [{ name: "Pix", title: "x", direction: "y" }] }],
    }));
    world.seedDefaults({ collectivePath: cfg });
    expect(world.town.get().workspace?.repoUrl).toBe("git@github.com:me/agent-town.git");
    const pix = world.agents.first("name = ?", ["Pix"])!;
    const asg = world.ops.createWork(null, pix.id, { title: "Fix it" });
    const s = world.ops.startSession(pix.id, { purpose: "work", model: "m", assignmentId: asg.id });
    const b = composeWorkBrief(world, s.id);
    expect(b.workspace?.repoUrl).toBe("https://github.com/me/agent-town.git");
    expect(b.workspace?.dir).toBe("/home/agent/work/agent-town");
  });

  test("desks config defaults to auto", () => {
    const { world } = freshWorld();
    expect(world.desksConfig().backend).toBe("auto");
  });
});

describe("seed backfill", () => {
  test("re-opening a seeded DB fills the collective repo's repoUrl from origin", () => {
    const { world } = seededWorld();
    world.town.set({ workspace: { path: REPO_ROOT, base: "main", branchPrefix: "agent", tools: [] } });
    world.seedDefaults({});
    expect(world.town.get().workspace?.repoUrl).toBe(originUrl(REPO_ROOT));
  });

  test("re-opening a seeded DB without a collective repo takes collective.json's", () => {
    const { world, dir } = seededWorld();
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({ name: "T", goal: "", workspace: { path: REPO_ROOT } }));
    world.seedDefaults({ collectivePath: cfg });
    expect(world.town.get().workspace?.path).toBe(REPO_ROOT);
  });
});
