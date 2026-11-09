/**
 * Asks read from a rollup's prose take the line's whole first sentence as their title (`proseAskTitle`), never a clause
 * cut before a colon or at 8 words; the boot repair `retitleProseAsks` rewrites the live ones that a rule before it clipped
 * ("A 1", "Optional", "Create one empty repo under dungeonrpg99-ops and give", live on 2026-11-09).
 */
import { proseAskTitle } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId } from "../src/index.ts";
import { backfillAsks, createAsk, retitleProseAsks, setRank } from "../src/asks.ts";
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
