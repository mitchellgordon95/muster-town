/**
 * Collectives that don't develop Muster Town get none of its redeploy/PR machinery (Mitchell, 1:1 mt_1vs893enaw; findings
 * dc_ogpz8cgzow): `World.repoMode` is none (no repo), own (another repo) or muster (this server's repo), and permissions,
 * waits and prompts follow it. muster.town's own Workshop (muster) is unchanged.
 */
import { describe, expect, it } from "vitest";
import { waitKindsFor, verbToolFor } from "@muster-town/schema";
import { ROOT_GOAL_ID } from "@muster-town/schema";
import { buildingRoleId, createBuilding, createResident, managerIntrayBlock, repoKey, townRoleId, updateBuilding, validateWait } from "../src/index.ts";
import { managerSystemPrompt, workshopPrompt, workSystemPrompt } from "../src/prompts.ts";
import { seededWorld } from "./helpers.ts";

const MUSTER = "git@github.com:mitchellgordon95/agent-town.git";

function lab(mode: "none" | "own" | "muster") {
  const s = seededWorld();
  const { world, seed } = s;
  world.host.repoUrl = MUSTER;
  if (mode !== "none") world.town.set({ workspace: { path: ".", tools: [], branchPrefix: "agent", base: "main", repoUrl: mode === "muster" ? "https://github.com/MitchellGordon95/agent-town" : "https://github.com/someone/their-app.git" } });
  const b = createBuilding(world, { name: "Lab", headcount: 2, dailyTokensPerAgent: 1000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  return { ...s, b: world.buildings.require(b.id), pix: world.agents.require(pix.id) };
}

describe("repoMode", () => {
  it("none without a workspace, muster on this server's repo however it is cloned, own on another repo", () => {
    expect(lab("none").world.repoMode()).toBe("none");
    expect(lab("muster").world.repoMode()).toBe("muster");
    expect(lab("own").world.repoMode()).toBe("own");
    expect(repoKey("git@github.com:O/agent-town.git")).toBe(repoKey("https://github.com/o/agent-town/"));
    expect(repoKey("ssh://git@github.com:22/o/agent-town")).toBe("github.com/o/agent-town");
    // no runtime (host repo unknown) and a workspace: as before, this server's own
    const l = lab("own");
    delete l.world.host.repoUrl;
    expect(l.world.repoMode()).toBe("muster");
    expect(lab("none").world.snapshot().health?.repoMode).toBe("none");
  });
});

describe("town.redeploy follows the repo mode", () => {
  it("muster: a manager holds it without the deployer role; own: only admins and deployers; hosted: nobody, admins included", () => {
    const m = lab("muster");
    expect(m.world.permissions.can(m.pix, "town.redeploy")).toBe(true);
    const o = lab("own");
    expect(o.world.permissions.can(o.pix, "town.redeploy")).toBe(false);
    expect(o.world.permissions.can({ kind: "user", id: o.seed.admin.id }, "town.redeploy")).toBe(true);
    o.world.permissions.grant(o.pix, townRoleId("deployer"));
    expect(o.world.permissions.can(o.pix, "town.redeploy")).toBe(true);
    const n = lab("none");
    n.world.host.hosted = true;
    expect(n.world.permissions.can({ kind: "user", id: n.seed.admin.id }, "town.redeploy")).toBe(false);
    expect(n.world.permissions.isAdmin({ kind: "user", id: n.seed.admin.id })).toBe(true);
  });
});

describe("waits follow the repo mode", () => {
  it("none refuses {deploy} and {pr}; own refuses {deploy}; muster takes both", () => {
    const after = { after: new Date(Date.now() + 60_000).toISOString() };
    const n = lab("none").world;
    expect(() => validateWait(n, { deploy: "next" })).toThrow(/no code repo/);
    expect(() => validateWait(n, { pr: 12 })).toThrow(/no code repo/);
    expect(validateWait(n, after)).toEqual(after);
    const o = lab("own").world;
    expect(() => validateWait(o, { deploy: "next" })).toThrow(/waitFor\.deploy/);
    expect(validateWait(o, { pr: 12 })).toEqual({ pr: 12 });
    const m = lab("muster").world;
    expect(validateWait(m, { deploy: "next" })).toEqual({ deploy: "next" });
    expect(validateWait(m, { pr: 12 })).toEqual({ pr: 12 });
    expect(waitKindsFor("none")).not.toContain("pr");
  });

  it("the tool texts and wait schemas drop what the mode can't use; muster's are unchanged", () => {
    expect(verbToolFor("submit_report", "muster").description).toMatch(/a redeploy/);
    const none = verbToolFor("submit_report", "none");
    expect(none.description).not.toMatch(/redeploy|\{pr/);
    expect(none.input.safeParse({ title: "t", body: "b", verdict: "stop", resumeWhen: { pr: 3 } }).success).toBe(false);
    expect(none.input.safeParse({ title: "t", body: "b", verdict: "stop", resumeWhen: { assignment: "as_x" } }).success).toBe(true);
    const own = verbToolFor("assign", "own");
    expect(own.description).not.toMatch(/redeploy/);
    expect(JSON.stringify((own.input.shape.waitFor as { description?: string }).description)).not.toMatch(/deploy/);
    expect(own.input.safeParse({ title: "t", description: "d", waitFor: { pr: 3 } }).success).toBe(true);
    expect(verbToolFor("meeting", "none").description).not.toMatch(/deploy/);
  });
});

describe("prompts follow the repo mode", () => {
  it("none: no deploy/PR waits, no merge example, no Live line, the rollup trigger is decided reports", () => {
    const { world, b, pix, seed } = lab("none");
    const town = world.town.get();
    const work = workSystemPrompt(pix, b, town, { repo: world.repoMode() });
    expect(work).not.toMatch(/\{deploy|\{pr:|GET \/api\/health|Merge PR/);
    expect(work).toMatch(/"Decide whether X\."/);
    const mgr = managerSystemPrompt(pix, b, town, { repo: world.repoMode() });
    expect(mgr).not.toMatch(/merge rights|"Live:" line/);
    expect(mgr).toMatch(/Roll up when reports were decided since your last rollup/);
    world.host.commit = "fa73e88aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect(managerIntrayBlock(world, b, pix.id)).not.toMatch(/Live:/);
    expect(seed).toBeTruthy();
  });

  it("own: PR waits stay, deploy waits and the redeploy line go", () => {
    const { world, b, pix } = lab("own");
    const work = workSystemPrompt(pix, b, world.town.get(), { repo: world.repoMode() });
    expect(work).toMatch(/\{pr: <number>\}/);
    expect(work).not.toMatch(/\{deploy/);
    expect(workshopPrompt({ dir: "/w", base: "main" }, "their-app", "own")).not.toMatch(/redeploy/);
  });

  it("muster: the Workshop's brief is as today (Live line, deploy and PR waits, the redeploy line)", () => {
    const { world, b, pix } = lab("muster");
    world.host.commit = "fa73e88aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const work = workSystemPrompt(pix, b, world.town.get(), { repo: world.repoMode() });
    expect(work).toMatch(/\{deploy: "<your commit sha>"\}/);
    expect(work).toMatch(/\{pr: <number>\}/);
    expect(work).toMatch(/"Merge PR #12\."/);
    expect(managerIntrayBlock(world, b, pix.id)).toMatch(/Live: fa73e88/);
    expect(managerSystemPrompt(pix, b, world.town.get(), { repo: "muster" })).toMatch(/merge rights/);
    expect(workshopPrompt({ dir: "/w", base: "main" }, "agent-town")).toMatch(/If you call `redeploy`/);
  });
});

describe("the captain the prompts and rollups address (1:1 mt_1vs893enaw decision 5)", () => {
  function hosted() {
    const l = lab("none");
    const root = l.world.goalTree.get(ROOT_GOAL_ID)!;
    const ada = l.world.users.require(root.ownerId!);
    l.world.users.upsert({ ...ada, name: "Ada" });
    return l;
  }

  it("a hosted collective's manager prompt names its root captain, not Mitchell", () => {
    const { world, b, pix } = hosted();
    expect(world.captainName()).toBe("Ada");
    const mgr = managerSystemPrompt(pix, b, world.town.get(), { repo: world.repoMode(), captain: world.captainName() });
    expect(mgr).toMatch(/## Needs from Ada`/);
    expect(mgr).toMatch(/Rollups are how Ada hears from you/);
    expect(mgr).not.toMatch(/Mitchell/);
    expect(managerIntrayBlock(world, b, pix.id)).not.toMatch(/Mitchell/);
    expect(managerIntrayBlock(world, b, pix.id)).toMatch(/you work it; Ada doesn't see these reports/);
  });

  it("a hosted rollup with \"## Needs from Ada\" files; a missing heading is named after Ada", async () => {
    const { world, b, pix } = hosted();
    world.permissions.grant({ kind: "agent", id: pix.id }, buildingRoleId(b.id, "manager"));
    const res = createResident(world, { buildingId: b.id, name: "Res" });
    const r = await world.verbs.submit_report(res, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const prov = { sourceIds: [r.id], urls: [] };
    await expect(world.verbs.submit_report(pix, { title: "x", body: "## Shipped\nx\n## Decided\nx\n## Key results\nx", verdict: "stop", rollup: true, provenance: prov }))
      .rejects.toThrow(/Missing: ## Needs from Ada\./);
    const ok = await world.verbs.submit_report(pix, { title: "R", body: "## Shipped\nNothing.\n## Decided\n- x\n## Key results\nx\n## Needs from Ada\nNothing needed.", verdict: "stop", rollup: true, provenance: prov });
    expect(world.docs.require(ok.id).tags).toContain("rollup");
  });

  it("muster.town keeps Mitchell, word for word", () => {
    const { world, b, pix } = lab("muster");
    world.users.upsert({ ...world.users.require(world.goalTree.get(ROOT_GOAL_ID)!.ownerId!), name: "Ada" });
    expect(world.captainName()).toBe("Mitchell");
    const mgr = managerSystemPrompt(pix, b, world.town.get(), { repo: "muster", captain: world.captainName() });
    expect(mgr).toBe(managerSystemPrompt(pix, b, world.town.get(), { repo: "muster" }));
    expect(mgr).toMatch(/## Needs from Mitchell`/);
    expect(mgr).toMatch(/How he reads one/);
    expect(mgr).toMatch(/reaches him on its own/);
  });
});
