/**
 * A red main gets one fixer (gr_7op2v8fjcl step 2, kr_hsfxuz8tnx). On 2026-11-02 one red main was fixed four times by
 * three agents in 17 minutes, because nothing told them main was red or who was on it. Now the runtime's main poller
 * (runtime/pr-checks.ts) calls `queueMainFix` on every red read: the first read of a red sha queues exactly one fix
 * assignment, to the building of the red commit's author (else the fallback, Code Legibility), and records it on the
 * `mainCi` record (meta, so a restart never queues it twice). While main is red every desk brief and `look` carry
 * `mainRedLine`: what failed and who holds the fix, so everyone else leaves it to them.
 */
import type { Agent, Assignment, Building } from "@muster-town/schema";
import { createAssignment, forkableManagerOf } from "./domain.ts";
import { AppError } from "./errors.ts";
import { whenFor } from "./time.ts";
import type { MainCi, World } from "./world.ts";

/** Where a red main's fix goes when its author maps to no building with a manager the town can fork: Code Legibility. */
const MAIN_FIX_FALLBACK = "bl_vd69s5a1nh";
/** The red-main grant: a fix landing in its building runs on it (lane grant) while it is funded, else as directed work. */
const RED_MAIN_GRANT = "gr_7op2v8fjcl";

/** The git identity slug of an agent name, as the desk writes it (`Pix 3` → `pix-3`, in `pix-3@muster-town.local` and `agent/pix-3/…`). */
function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
}

/** The red commit, as the runtime read it from GitHub: its author's agent slug (null = not an agent) and how to name it. */
export interface RedCommit {
  slug: string | null;
  /** "Pix 3 <pix-3@muster-town.local>", or "Mitchell Gordon (PR #315 from agent/kelly/…)" */
  author: string;
  /** the failed check runs' pages on GitHub */
  runUrls: string[];
}

/** The agent behind a slug: a resident (or visitor) whose name slugs to it; forks map to their manager. */
function agentOfSlug(world: World, slug: string): Agent | undefined {
  const a = world.agents.where("kind != 'human'").find((x) => agentSlug(x.name) === slug);
  return a?.forkOf ? world.agents.get(a.forkOf) ?? a : a;
}

/** The building a red commit's fix goes to (its author's, if the town can fork its manager), and whether that was the fallback. */
function fixBuildingOf(world: World, slug: string | null, fallbackId: string): { building: Building; fallback: boolean } | null {
  const agent = slug ? agentOfSlug(world, slug) : undefined;
  const bid = agent ? agent.homeBuildingId ?? agent.buildingId : null;
  const own = bid ? world.buildings.get(bid) : undefined;
  if (own && forkableManagerOf(world, own)) return { building: own, fallback: false };
  const fb = world.buildings.get(fallbackId);
  return fb && forkableManagerOf(world, fb) ? { building: fb, fallback: true } : null;
}

const OPEN = new Set(["pending", "active"]);

/**
 * On a red read: queue the one fix assignment for this sha, unless one was queued for it already (`fixSha`) or the
 * episode's fix assignment is still open (it then covers the new sha too: one fixer per red episode, never a race).
 * Returns the record, updated and saved when it changed. Anything but red comes back as is.
 */
export function queueMainFix(world: World, ci: MainCi, commit: RedCommit, opts: { fallbackBuildingId?: string; grantId?: string } = {}): MainCi {
  const grantId = opts.grantId ?? RED_MAIN_GRANT;
  if (ci.state !== "red" || ci.fixSha === ci.sha) return ci;
  const open = ci.fixAssignmentId ? world.assignments.get(ci.fixAssignmentId) : undefined;
  if (open && OPEN.has(open.status)) {
    const next = { ...ci, fixSha: ci.sha };
    world.town.setMainCi(next);
    return next;
  }
  const to = fixBuildingOf(world, commit.slug, opts.fallbackBuildingId ?? MAIN_FIX_FALLBACK);
  if (!to) return ci; // no building to take it: try again next poll
  const { building, fallback } = to;
  const manager = forkableManagerOf(world, building)!;
  const short = ci.sha.slice(0, 7);
  const title = `Main is red at ${short} (${ci.failedStep ?? "a check failed"}): fix it, you are the one fixer`;
  const description = [
    `Main's CI failed on ${ci.sha} (${commit.author}). Failed: ${ci.failedStep ?? "a check suite"}.`,
    commit.runUrls.length ? `CI runs: ${commit.runUrls.join(" ")}` : "",
    `Queued by the town to ${building.name}${fallback ? " (the commit's author maps to no building the town can run, so it falls back here)" : " (the red commit's author's building)"}. You are the only fixer: every desk brief and \`look\` names you while main is red, and tells everyone else not to push a fix.`,
    "Start from origin/main: if it is green again, say so and stop. Else reproduce the failure, fix it on main (a small PR you merge once green, under the merge rules), and report the fixing commit.",
  ].filter(Boolean).join("\n\n");
  const lane = (): Assignment => {
    const g = world.grants.get(grantId);
    const make = (grant: boolean) => createAssignment(world, {
      agentId: manager.id, title, description, buildingId: building.id, createdBy: { kind: "system", id: "main-ci" },
      lane: grant ? { lane: "grant", grantId } : { lane: "directed" },
    });
    if (g?.buildingId === building.id && g.status === "funded") {
      try { return make(true); } catch (e) { if (!(e instanceof AppError)) throw e; }
    }
    return make(false);
  };
  const a = world.transaction(lane);
  const next: MainCi = { ...ci, fixer: manager.id, fixSha: ci.sha, fixAssignmentId: a.id };
  world.town.setMainCi(next);
  world.events.append({ type: "system", buildingId: building.id, text: `Main is red at ${short} (${ci.failedStep ?? "a check failed"}): one fix assignment queued to ${building.name}`, payload: { mainCi: "fix", sha: ci.sha, assignmentId: a.id, fallback } });
  return next;
}

/**
 * The line every desk brief and `look` carry while main is red (null otherwise): what failed, since when, and who
 * holds the fix assignment, so nobody else races them.
 */
export function mainRedLine(world: World, now: number | Date = Date.now()): string | null {
  const ci = world.host.mainCi?.() ?? world.town.mainCi();
  if (!ci || ci.state !== "red") return null;
  const a = ci.fixAssignmentId ? world.assignments.get(ci.fixAssignmentId) : undefined;
  const where = a ? world.buildings.get(a.buildingId)?.name ?? a.buildingId : "";
  const fixer = !a ? "none yet (the town queues one fix assignment within a minute)"
    : a.status === "active" ? `${world.nameOf(a.agentId)} of ${where} (${a.id})`
    : a.status === "pending" ? `${where}, queued (${a.id})`
    : `${where}'s ${a.id} ended (${a.status}) with main still red; the next red commit gets a new fixer`;
  return `Main is red: CI failed on ${ci.sha.slice(0, 7)} (${ci.failedStep ?? "a check failed"}) since ${whenFor(ci.since, "agent", now)}. Fixer: ${fixer}. Unless you are the fixer, don't push a fix for it: tell the fixer what you know.`;
}
