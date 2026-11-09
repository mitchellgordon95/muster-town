import { askLineFor, askVerb, rollupAsksOnly } from "@muster-town/schema";
import { describe, expect, it } from "vitest";
import { buildingRoleId, reviewDeck, townHallIntray } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const rollup = (shipped: string, keyResults: string, needs = "Nothing needed.") => `## Shipped\n${shipped}\n\n## Decided\n- dc_a → approved\n\n## Key results\n${keyResults}\n\n## Needs from Mitchell\n${needs}`;
const ITEM = "**1. Spend chart**\n**What it is:** a chart.\n**What you'd see:** Map → Bank.\n**Your call:** None.";

describe("a rollup's ask folds into the item's own in-tray row (1:1 mt_7b4zc7yja3)", () => {
  it("reads the ask line and tells an ask-only rollup apart", () => {
    const body = `${rollup("Nothing new live.", "- **gr_abc1** proposed: lets a stranger fund a goal.")}\n\n_Already waiting in your in-tray: 1 proposal (gr_zzz9), 0 requests, 0 rollups._`;
    expect(askLineFor("Rollup 9", body, "gr_abc1")).toBe("gr_abc1 proposed: lets a stranger fund a goal.");
    // the generated waiting line is not an ask
    expect(askLineFor("Rollup 9", body, "gr_zzz9")).toBeNull();
    expect(askLineFor("Fund gr_zzz9 please", body, "gr_zzz9")).toBe("Fund gr_zzz9 please");
    expect(rollupAsksOnly(body, ["gr_abc1"])).toBe(true);
    // a Shipped card, or a Needs line that asks something else, is more than the ask
    expect(rollupAsksOnly(rollup(ITEM, "gr_abc1 proposed"), ["gr_abc1"])).toBe(false);
    expect(rollupAsksOnly(rollup("None.", "gr_abc1", "Decide whether forks may redeploy."), ["gr_abc1"])).toBe(false);
    expect(rollupAsksOnly(rollup("None.", "gr_abc1", "- Nothing."), ["gr_abc1"])).toBe(true);
    // a "## Decided" line reports a decision, it asks nothing; the Needs line wins over a Key results line
    const decided = "## Shipped\nNone.\n\n## Decided\n- dc_x → approve (checkpoint for gr_abc1)\n\n## Key results\n- gr_abc1 on track\n\n## Needs from Mitchell\n- Continue gr_abc1: it buys the deck.";
    expect(askLineFor("Rollup 10", decided, "gr_abc1")).toBe("Continue gr_abc1: it buys the deck.");
    expect(askLineFor("Rollup 10", decided.replace(/## Key results[\s\S]*$/, "## Needs from Mitchell\nNothing."), "gr_abc1")).toBeNull();
    // a Key results table row reads as plain text, not markdown pipes
    expect(askLineFor("Rollup 11", rollup("None.", "| Grant | KR | Status |\n|---|---|---|\n| After let-in gr_abc1, 665 / 500 | kr_e1 | at-risk |"), "gr_abc1")).toBe("After let-in gr_abc1, 665 / 500 · kr_e1 · at-risk");
    expect([askVerb("proposed"), askVerb("checkpoint"), askVerb("closed"), askVerb("asked")]).toEqual(["fund", "continue", "mark", "approve"]);
  });

  it("submit_report folds an ask-only rollup; one with Shipped items keeps its card; the grant row and its slide carry the asks", async () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const r = await world.verbs.submit_report(noor, { title: "Done", body: "## What I did\nx", verdict: "stop" });
    const prov = { sourceIds: [r.id], urls: [] };
    const roll = (title: string, body: string) => world.verbs.submit_report(mei, { title, body, verdict: "stop", rollup: true, provenance: prov });
    // nothing waiting: a plain rollup stays a card and nothing is attached
    const plain = await roll("Quiet", rollup("None.", "on track"));
    expect(plain.decision).toBe("pending");
    const g = (await world.verbs.propose_grant(mei, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "o", steps: [{ size: "M", title: "Step 1", description: "Do the work" }], stopCondition: "s", askTokens: 1000 })).grantId;
    // the generated waiting line names g, but a rollup that doesn't is no ask on it
    const other = await roll("Still quiet", rollup("None.", "on track"));
    expect(other.decision).toBe("pending");
    const only = await roll(`Rollup: fund ${g}`, rollup("Nothing new live.", `- ${g} proposed: lets a stranger fund a goal.`));
    expect(only.decision).toBe("approve");
    expect(only.note).toMatch(new RegExp(`folded: its only ask is on ${g}`));
    const doc = world.docs.require(only.id);
    expect(doc.tags).toContain("folded");
    expect(doc.decisionNote).toContain(`Folded into the in-tray row of ${g}`);
    const mixed = await roll("Rollup with a card", rollup(ITEM, `- ${g} waits on you.`));
    expect(mixed.decision).toBe("pending");

    const intray = townHallIntray(world);
    expect(intray.reports.map((d) => d.id)).toEqual(expect.arrayContaining([plain.id, other.id, mixed.id]));
    expect(intray.reports.map((d) => d.id)).not.toContain(only.id);
    const row = intray.grants.find((x) => x.id === g)!;
    expect(row.asks).toEqual([
      expect.objectContaining({ reportId: only.id, line: `${g} proposed: lets a stranger fund a goal.`, folded: true, buildingName: world.buildings.require(LAB).name }),
      expect.objectContaining({ reportId: mixed.id, line: `${g} waits on you.`, folded: false }),
    ]);
    const slide = reviewDeck(world).slides.find((s) => s.grantId === g)!;
    expect(slide.text).toContain(`asks you to fund this:** ${g} proposed: lets a stranger fund a goal. (rollup ${only.id})`);
    // a decided proposal leaves the in-tray with its asks; a later rollup naming it is not folded
    world.grants.upsert({ ...world.grants.require(g), status: "rejected" });
    const after = await roll(`About ${g}`, rollup("None.", `- ${g} was rejected.`));
    expect(after.decision).toBe("pending");

    // a checkpoint row doesn't list its own checkpoint report as an ask (it links it already)
    world.grants.upsert({ ...world.grants.require(g), status: "checkpoint", checkpointDocId: mixed.id, history: [] });
    const cp = townHallIntray(world).grants.find((x) => x.id === g)!;
    expect(cp.asks?.map((a) => a.reportId) ?? []).not.toContain(mixed.id);
  }, 30_000);
});
