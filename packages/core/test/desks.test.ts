import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { composeWorkBrief, originUrl } from "../src/index.ts";
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

  test("workspace buildings get repoUrl/base/branch/dir", () => {
    const { world, by, seed } = seededWorld();
    world.ops.updateBuilding(null, seed.lab!.id, { workspace: { path: REPO_ROOT, repoUrl: "git@github.com:me/agent-town.git", base: "main", branchPrefix: "agent", tools: [], merge: "human", checks: [] } });
    const noor = by("Noor");
    const asg = world.ops.createWork(null, noor.id, { title: "Fix the HUD!" });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id });
    const b = composeWorkBrief(world, s.id);
    expect(b.workspace).toEqual({ repoUrl: "https://github.com/me/agent-town.git", base: "main", branchPrefix: "agent", branch: "agent/noor/fix-the-hud", dir: "/home/agent/work/agent-town", merge: "human", checks: [] });
    expect(b.system).toContain("/home/agent/work/agent-town");
  });
});

describe("seed", () => {
  test("collective workspace path gets repoUrl from origin; desks config is stored", () => {
    const { world, dir } = freshWorld();
    const cfg = join(dir, "collective.json");
    writeFileSync(cfg, JSON.stringify({
      name: "T", goal: "", desks: { backend: "host" },
      buildings: [
        { id: "ws", name: "WS", workspace: { path: REPO_ROOT }, residents: [{ name: "Pix", title: "x", direction: "y" }] },
        { id: "nogit", name: "No git", workspace: { path: dir } },
      ],
    }));
    world.seedDefaults({ collectivePath: cfg });
    const expected = originUrl(REPO_ROOT);
    expect(world.buildings.require("ws").workspace?.repoUrl).toBe(expected);
    expect(world.buildings.require("nogit").workspace?.repoUrl).toBeUndefined();
    expect(world.desksConfig()).toEqual({ backend: "host", image: "agent-town-desk", ghToken: "gh-cli" });
  });

  test("desks config defaults to auto", () => {
    const { world } = freshWorld();
    expect(world.desksConfig().backend).toBe("auto");
  });
});

describe("seed backfill", () => {
  test("re-opening a seeded DB fills workspace.repoUrl from origin", () => {
    const { world, seed } = seededWorld();
    world.buildings.patch(seed.lab!.id, { workspace: { path: REPO_ROOT, base: "main", branchPrefix: "agent", tools: [], merge: "human", checks: [] } });
    world.seedDefaults({});
    expect(world.buildings.require(seed.lab!.id).workspace?.repoUrl).toBe(originUrl(REPO_ROOT));
  });
});
