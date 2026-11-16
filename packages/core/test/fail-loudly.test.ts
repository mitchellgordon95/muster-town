/**
 * Fail loudly in the ask and card paths (decision-5 audit dc_0h2p8oiwy6 ranks 1-4, grant gr_eztubyh7nf step 1; Mitchell's
 * rule in 1:1 mt_dwsxo7oms8: an unexpected case fails and says what failed, and no ask is written by code without an LM).
 */
import { describe, expect, it } from "vitest";
import { appendEntry, buildingRoleId, entryOf, jobThread } from "../src/index.ts";
import { passUpWithAsk } from "../src/ask-verb.ts";
import { creditBank, renderNeeds, seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";

function setup() {
  const s = seededWorld();
  const { world } = s;
  creditBank(world, 10_000_000);
  const manager = world.agents.first("homeBuildingId = ? AND kind != 'human'", [LAB])!;
  world.permissions.grant(manager, buildingRoleId(LAB, "manager"));
  world.buildings.patch(LAB, { managerAgentId: manager.id });
  return { ...s, world, manager };
}

const plan = (title: string) => ({
  title, keyResults: [{ text: "Banner shows Usage", howToCheck: "Open the lab banner" }], objective: "A banner", approach: "a banner line",
  steps: [{ size: "M" as const, title: "Step 1", description: "Do the work" }], stopCondition: "two failed tries", askTokens: 300_000, findingsDocIds: [], note: "",
});

describe("fail loudly: threads and cards", () => {
  it("appendEntry on a job that does not exist throws naming it; the same id twice is null and writes nothing", () => {
    const { world } = setup();
    expect(() => appendEntry(world, { jobId: "jb_nope", authorKind: "code", authorId: "system", level: "human", note: "A need nobody would see", body: "" }))
      .toThrow(/No job jb_nope to write on: the entry "A need nobody would see" was not written/);
    const first = appendEntry(world, { id: "en_once", jobId: `jb_${LAB}`, authorKind: "code", authorId: "system", level: "none", note: "once", body: "" });
    expect(first?.id).toBe("en_once");
    expect(appendEntry(world, { id: "en_once", jobId: `jb_${LAB}`, authorKind: "code", authorId: "system", level: "none", note: "twice", body: "" })).toBeNull();
    expect(jobThread(world, `jb_${LAB}`)!.entries.filter((e) => e.id === "en_once").map((e) => e.note)).toEqual(["once"]);
  });

  it("propose_grant's card carries the author's own title, not a template", async () => {
    const { world, manager } = setup();
    const card = {
      title: "Fund the banner that shows usage",
      body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.\nIf you fund: the banner ships.\nIf you reject: nothing runs.",
      recommendation: "Fund: one session does it.", claims: [{ text: "The banner builds", check: { kind: "manual" as const } }],
    };
    const r = await world.verbs.propose_grant(manager, { ...plan("Show usage on the banner"), ask: card });
    const ask = world.asks.first("targetId = ? AND status = 'open'", [r.grantId])!;
    expect(ask).toMatchObject({ title: card.title, body: card.body, recommendation: card.recommendation });
    // no template title: the card's title is what its author wrote, not "Fund \"Usage banner\" at 300k"
    expect(ask.title).not.toMatch(/at 300k/);
  });

  it("passing up an entry that already has a live card fails, names the card and writes nothing", () => {
    const { world, manager } = setup();
    const g = world.grantDesk.propose(manager, world.grantDesk.create(manager, LAB, plan("Show usage on the banner")).id);
    renderNeeds(world, manager.id);
    const live = world.asks.first("targetId = ? AND status = 'open'", [g.id])!;
    const entry = entryOf(world, live.sourceEntryId!)!;
    const card = { type: "money" as const, targetId: g.id, title: "Fund it, passed up", body: "This is a new proposal. You have not decided on it before.\nNothing is spent yet. It has one step, and none is done yet.", branches: [{ label: "Fund" }, { label: "Reject" }], recommendation: "Fund it.", claims: [{ text: "The banner builds", check: { kind: "manual" as const } }] };
    const before = world.asks.count();
    // the `review` verb runs this in a transaction: the throw rolls back the thread entry it would have written
    expect(() => world.transaction(() => passUpWithAsk(world, manager, entry, LAB, card, ""))).toThrow(new RegExp(`live card, ask ${live.id}[\\s\\S]*Nothing was written`));
    expect(world.asks.count()).toBe(before);
    expect(jobThread(world, entry.jobId)!.entries.some((e) => e.moved.kind === "ask-refused")).toBe(false);
    expect(world.asks.require(live.id)).toMatchObject({ title: live.title, body: live.body });
  });
});
