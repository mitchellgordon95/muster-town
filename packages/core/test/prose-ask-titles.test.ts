/**
 * Asks read from a rollup's prose take the line's whole first sentence as their title (`proseAskTitle`), never a clause
 * cut before a colon or at 8 words; the boot repair `retitleProseAsks` rewrites the live ones that a rule before it clipped
 * ("A 1", "Optional", "Create one empty repo under dungeonrpg99-ops and give", live on 2026-11-09).
 */
import { proseAskTitle } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { asksFor, backfillAsks, createAsk, foldTwinProseAsks, retitleProseAsks, retypeProseAsks, setRank } from "../src/asks.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const ONE_ON_ONE = "A 1:1 with Juno when you have time, as you said in your 1:1 with Secretary: the one thing to settle is which outreach channel goes first (Show HN, your own long-form post, or GitHub readiness), and whether link previews should land before any post.";
const OPTIONAL = "Optional: give the test account dungeonrpg99-ops (us_u4mzpz4zc7) \"direct work under\" the Onboarding goal (Members table, or POST /api/members/us_u4mzpz4zc7/direct) so a fork can check the stranger's 1:1 path and the You're-in card's manager line. Skip it if you'd rather keep the account a plain member; nothing is blocked on it.";
const REPO = "Create one empty repo under dungeonrpg99-ops (any name) and give MUSTER_TEST_GH_TOKEN Contents read/write on it (or Administration write so the account can create its own): the token is fine-grained and gets 403 on repo creation, so the hosted-collective publish check cannot run until then. Two minutes on github.com; say \"done\" in a reply and the check queues itself.";

describe("proseAskTitle: the whole first sentence of a rollup's call", () => {
  it("reads the three live examples whole: no cut at the colon of 1:1 or after Optional, no cut at 8 words", () => {
    expect(proseAskTitle(ONE_ON_ONE)).toBe("A 1:1 with Juno when you have time, as you said in your 1:1 with Secretary");
    expect(proseAskTitle(OPTIONAL)).toBe("Optional: give the test account dungeonrpg99-ops \"direct work under\" the Onboarding goal so a fork can check the stranger's 1:1 path");
    expect(proseAskTitle(REPO)).toBe("Create one empty repo under dungeonrpg99-ops and give MUSTER_TEST_GH_TOKEN Contents read/write on it");
  });

  it("keeps a short sentence whole, drops markdown, asides and the trailing period, and stays within 160 characters", () => {
    expect(proseAskTitle("**Merge** PR #12 (it is green). Then nothing.")).toBe("Merge PR #12");
    expect(proseAskTitle("Rewrite AGENTS.md rule 1, e.g. the fork rule.")).toBe("Rewrite AGENTS.md rule 1, e.g. the fork rule");
    expect(proseAskTitle("Forks redeploy on green CI, unless you'd rather keep it manual.")).toBe("Forks redeploy on green CI, unless you'd rather keep it manual");
    for (const s of [ONE_ON_ONE, OPTIONAL, REPO, "word ".repeat(80)]) expect(proseAskTitle(s).length).toBeLessThanOrEqual(160);
    expect(proseAskTitle(`${"long ".repeat(50)}tail`)).not.toMatch(/\s$/);
  });
});

describe("asks read from rollup prose, and the boot repair", () => {
  async function filed() {
    const s = seededWorld();
    const { world, by, admin } = s;
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const report = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const item = (n: number, title: string, call: string) => `**${n}. ${title}**\n**What it is:** a change.\n**What you'd see:** a page.\n**Your call:** ${call}\n`;
    const body = `## Shipped\n${item(1, "Outreach", ONE_ON_ONE)}\n${item(2, "Onboarding", OPTIONAL)}\n${item(3, "Publish", REPO)}\n## Decided\n- dc_a → approved\n\n## Key results\non track\n\n## Needs from Mitchell\nNothing needed.`;
    const r = await world.verbs.submit_report(mei, { title: "Rollup 9", body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] } });
    world.db.prepare("DELETE FROM asks").run();
    backfillAsks(world);
    return { ...s, mei, r, asks: () => world.asks.where("sourceDocId = ?", [r.id], "ORDER BY createdAt, rowid") };
  }

  it("files each call under its whole first sentence", async () => {
    const { asks } = await filed();
    expect(asks().map((a) => a.title)).toEqual([proseAskTitle(ONE_ON_ONE), proseAskTitle(OPTIONAL), proseAskTitle(REPO)]);
  }, 30_000);

  it("the repair retitles a live clipped prose ask from its source line, keeps body, rank, sources and status, leaves a manager's ask alone, and the backfill files no twin", async () => {
    const { world, r, asks, mei } = await filed();
    const [a, b, c] = asks();
    // the titles the migration-105 repair left live on 2026-11-09
    for (const [x, t] of [[a!, "A 1"], [b!, "Optional"], [c!, "Create one empty repo under dungeonrpg99-ops and give"]] as const) world.asks.upsert({ ...world.asks.require(x.id), title: t });
    setRank(world, b!.id, 3);
    const mgr = createAsk(world, { type: "click", targetKind: null, targetId: null, buildingId: LAB, sourceDocId: r.id, by: mei.id, title: "Optional", body: "My own card.", branches: [{ label: "Done" }, { label: "Decline" }], recommendation: "Do it" }).ask;
    // a boot before the repair: the backfill must not file the clipped ones again
    backfillAsks(world);
    expect(asks()).toHaveLength(4);
    expect(retitleProseAsks(world)).toBe(3);
    const fixed = world.asks.require(b!.id);
    expect(fixed).toMatchObject({ title: proseAskTitle(OPTIONAL), body: b!.body, sources: b!.sources, rank: 3, status: "open" });
    expect(fixed.history.at(-1)).toMatchObject({ action: "retitled", by: "system", note: "was: Optional" });
    expect(world.asks.require(a!.id).title).toBe("A 1:1 with Juno when you have time, as you said in your 1:1 with Secretary");
    expect(world.asks.require(c!.id).title).toBe("Create one empty repo under dungeonrpg99-ops and give MUSTER_TEST_GH_TOKEN Contents read/write on it");
    expect(world.asks.require(mgr.id).title).toBe("Optional");
    expect(retitleProseAsks(world)).toBe(0);
    backfillAsks(world);
    expect(asks()).toHaveLength(4);
  }, 30_000);
});

describe("a prose call that only mentions a grant is a click, not a money ask on it", () => {
  async function rolled() {
    const s = seededWorld();
    const { world, by, admin } = s;
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const g = await world.verbs.propose_grant(mei, { title: "Publish docs to GitHub", objective: "Publish docs", stopCondition: "done", keyResults: [{ text: "pushes", howToCheck: "open the repo" }], steps: [{ title: "s", size: "S", description: "d" }] }) as { grantId: string };
    const kr = world.grantDesk.keyResultsOf(g.grantId)[0]!;
    const report = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    // the two live lines of 2026-11-09 (ak_964oxnm14w, ak_4nc6kwr1wt), with this town's ids
    const repo = REPO.replace("so the hosted-collective publish check", `so the hosted-collective publish check (KR3 of ${g.grantId})`);
    const krLine = `One key result (${kr.id}, the admin HUD notice) is met on code evidence only: you were the only admin online and no fork can see your HUD. Flip it to missed on the grant if you want a live sighting first; otherwise nothing.`;
    const gate = `Continue ${g.grantId} at its gate or cut it.`;
    const item = (n: number, title: string, call: string) => `**${n}. ${title}**\n**What it is:** a change.\n**What you'd see:** a page.\n**Your call:** ${call}\n`;
    const body = `## Shipped\n${item(1, "Publish", repo)}\n${item(2, `Join path done: grant ${g.grantId} closed as done`, krLine)}\n${item(3, "Gate", gate)}\n## Decided\n- dc_a → approved\n\n## Key results\non track\n\n## Needs from Mitchell\nNothing needed.`;
    const r = await world.verbs.submit_report(mei, { title: "Rollup 9", body, verdict: "stop", rollup: true, provenance: { sourceIds: [report.id], urls: [] } });
    world.db.prepare("DELETE FROM asks").run();
    return { ...s, r: world.docs.require(r.id), g: world.grants.require(g.grantId), kr, repo, krLine, gate };
  }

  /** The live ask carrying this line of the rollup as a source. */
  const carrying = (world: ReturnType<typeof seededWorld>["world"], docId: string, line: string) => world.asks.where("1 = 1").find((a) => a.sources.some((s) => s.docId === docId && s.line === line));

  it("files the repo line untargeted and the key result line on its key result as Done / Decline clicks; a gate call stays money on its grant", async () => {
    const { world, r, g, kr, repo, krLine, gate } = await rolled();
    backfillAsks(world);
    const clicks = [{ label: "Done" }, { label: "Decline" }];
    expect(carrying(world, r.id, repo)).toMatchObject({ type: "click", targetKind: null, targetId: null, branches: clicks });
    expect(carrying(world, r.id, krLine)).toMatchObject({ type: "click", targetKind: "keyResult", targetId: kr.id, branches: clicks });
    // the gate call folds into the proposal's own money ask on the grant
    expect(carrying(world, r.id, gate)).toMatchObject({ type: "money", targetKind: "grant", targetId: g.id });
  }, 30_000);

  it("the repair retypes the live mis-typed ones, keeps title, body, sources and rank, leaves a call for tokens alone, and the backfill files no twin", async () => {
    const { world, r, g, kr, repo, krLine, gate } = await rolled();
    // as the rule before this one filed them: money on the grant the line names, Yes / No (one live ask per target, so set after)
    const old = (line: string, targetId: string) => {
      const a = createAsk(world, { type: "money", targetKind: null, targetId: null, buildingId: LAB, sourceDocId: r.id, by: "ag_x", title: proseAskTitle(line), line, body: `From the rollup "${r.title}".`, branches: [{ label: "Yes" }, { label: "No" }] }).ask;
      return world.asks.upsert({ ...a, targetKind: "grant", targetId });
    };
    const a = old(repo, g.id), b = old(krLine, g.id), keep = old(gate, g.id);
    setRank(world, b.id, 2);
    expect(retypeProseAsks(world)).toBe(2);
    const fa = world.asks.require(a.id), fb = world.asks.require(b.id);
    expect(fa).toMatchObject({ type: "click", targetKind: null, targetId: null, title: a.title, body: a.body, sources: a.sources, status: "open", branches: [{ label: "Done" }, { label: "Decline" }] });
    expect(fa.history.find((h) => h.action === "retyped")).toMatchObject({ by: "system", note: `was: money on grant ${g.id} (Yes / No)` });
    expect(fb).toMatchObject({ type: "click", targetKind: "keyResult", targetId: kr.id, rank: 2, branches: [{ label: "Done" }, { label: "Decline" }] });
    expect(world.asks.require(keep.id)).toMatchObject({ type: "money", targetKind: "grant", targetId: g.id, branches: [{ label: "Yes" }, { label: "No" }] });
    expect(retypeProseAsks(world)).toBe(0);
    backfillAsks(world);
    expect(world.asks.where("sourceDocId = ?", [r.id])).toHaveLength(3);
  }, 30_000);
  it("at boot the backfill runs before the retype and still files no twin of a mis-typed line; the twins an older boot made fold into one", async () => {
    const { world, r, g, kr, repo, krLine } = await rolled();
    const old = (line: string) => {
      const a = createAsk(world, { type: "money", targetKind: null, targetId: null, buildingId: LAB, sourceDocId: r.id, by: "ag_x", title: proseAskTitle(line), line, body: `From the rollup "${r.title}".`, branches: [{ label: "Yes" }, { label: "No" }] }).ask;
      return world.asks.upsert({ ...a, targetKind: "grant", targetId: g.id });
    };
    const a = old(repo), b = old(krLine);
    // the boot order (world.ts): backfill, then retype; dca8e0e9 made ak_mpfdm8kjj5 and ak_3nakbll1su here
    backfillAsks(world);
    expect(retypeProseAsks(world)).toBe(2);
    const live = () => world.asks.where("sourceDocId = ? AND status IN ('open', 'deferred')", [r.id], "ORDER BY createdAt, rowid");
    expect(live().filter((x) => x.title === a.title)).toHaveLength(1);
    expect(live().filter((x) => x.title === b.title)).toHaveLength(1);
    expect(foldTwinProseAsks(world)).toBe(0);

    // twins as live after dca8e0e9: the old one retyped untargeted, a new click on the key result
    world.asks.upsert({ ...world.asks.require(b.id), targetKind: null, targetId: null });
    const twin = createAsk(world, { type: "click", targetKind: "keyResult", targetId: kr.id, buildingId: LAB, sourceDocId: r.id, by: "ag_x", title: proseAskTitle(krLine), line: krLine, body: `From the rollup "${r.title}".`, branches: [{ label: "Done" }, { label: "Decline" }] }).ask;
    const repoTwin = createAsk(world, { type: "click", targetKind: null, targetId: null, buildingId: LAB, sourceDocId: r.id, by: "ag_x", title: proseAskTitle(repo), line: repo, body: `From the rollup "${r.title}".`, branches: [{ label: "Done" }, { label: "Decline" }] }).ask;
    expect(foldTwinProseAsks(world)).toBe(2);
    // the one with a target stays; else the oldest
    expect(world.asks.require(b.id)).toMatchObject({ status: "folded", foldedInto: twin.id });
    expect(world.asks.require(twin.id).status).toBe("open");
    expect(world.asks.require(repoTwin.id)).toMatchObject({ status: "folded", foldedInto: a.id });
    expect(world.asks.require(a.id).status).toBe("open");
    expect(foldTwinProseAsks(world)).toBe(0);
    backfillAsks(world);
    // the repo line and the key result line (the gate call folds into the proposal's own ask on the grant)
    expect(live().map((x) => x.id).sort()).toEqual([a.id, twin.id].sort());
  }, 30_000);
});
