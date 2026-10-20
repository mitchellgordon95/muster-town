import { describe, expect, test } from "vitest";
import {
  composeWorkBrief, createDoc, docGist, FALLBACK_REPORT_PREFIX, NOTEBOOK_CAP, notebookBlock, notebookOf, READ_FIRST, recentWorkBlock, sectionOf,
} from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const iso = (minAgo: number, now: number) => new Date(now - minAgo * 60_000).toISOString();

describe("recent-work block", () => {
  test("lists the agent's docs newest first with a gist, skips fallback reports and the notebook, quotes the last report's ask", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    world.db.prepare("DELETE FROM docs WHERE authorId = ?").run(noor.id); // the seed's desk article
    const now = Date.now();
    const base = { authorId: noor.id, authorKind: "agent" as const, buildingId: noor.homeBuildingId };
    createDoc(world, { ...base, type: "note", state: "building", title: "Old note", body: "# Heading\n\nFirst real line of the note.", createdAt: iso(600, now) });
    createDoc(world, { ...base, type: "report", state: "building", title: "Growth rate", decision: "approve", body: "## What I did\nRead NOAA.\n\n## Findings\n2.4 ppm/yr.\n\n## What I need from you\nDecide whether to use the 10-year mean.\nIt changes the dashboard.", createdAt: iso(120, now) });
    createDoc(world, { ...base, type: "article", state: "draft", title: "Airborne fraction", body: "The airborne fraction is " + "x".repeat(300), createdAt: iso(30, now) });
    createDoc(world, { ...base, type: "report", state: "building", title: `${FALLBACK_REPORT_PREFIX} something`, body: "## What I need from you\nNothing needed.", createdAt: iso(5, now) });
    await world.verbs.write(noor.id, { type: "notebook", title: "x", body: "my notes", state: "draft" });
    createDoc(world, { authorId: by("Mei").id, authorKind: "agent", type: "note", title: "Mei's note", body: "not mine" });

    const b = recentWorkBlock(world, noor.id, { now });
    const lines = b.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^- article "Airborne fraction" \(dc_[\w-]+, 30m ago\): The airborne fraction is x+…$/);
    expect(lines[0].length).toBeLessThan(220);
    expect(lines[1]).toMatch(/^- report "Growth rate" \(dc_[\w-]+, 2h ago\): Decide whether to use the 10-year mean\.$/);
    expect(lines[2]).toMatch(/^- note "Old note" \(dc_[\w-]+, 10h ago\): First real line of the note\.$/);
    expect(b).not.toContain(FALLBACK_REPORT_PREFIX);
    expect(b).not.toContain("notebook");
    expect(b).not.toContain("Mei's note");
    expect(b).toContain(`Your last report "Growth rate"`);
    expect(b).toContain("Decide whether to use the 10-year mean.\nIt changes the dashboard.");
    expect(b).toContain(READ_FIRST);

    expect(recentWorkBlock(world, noor.id, { now, limit: 1 }).split("\n").filter((l) => l.startsWith("- "))).toHaveLength(1);
    const short = recentWorkBlock(world, noor.id, { now, short: true, readHint: false });
    expect(short).not.toContain("Your last report");
    expect(short).not.toContain(READ_FIRST);
  });

  test("counts unread mentions and says when nothing is written yet", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    world.db.prepare("DELETE FROM docs WHERE authorId = ?").run(noor.id);
    expect(recentWorkBlock(world, noor.id)).toContain("(you haven't written anything yet)");
    await world.verbs.say(by("Mei").id, { text: `@${noor.name} have a look at the ocean sink` });
    expect(recentWorkBlock(world, noor.id)).toMatch(/You have 1 unread mention: check `inbox`/);
  });

  test("gists and sections", () => {
    const report = { type: "report", body: "## What I did\nx\n\n## What I need from you\n\nMerge PR #12.\n" } as never;
    expect(docGist(report)).toBe("Merge PR #12.");
    expect(sectionOf("## A\na\n## B\nb\n### b2\nmore", "B")).toBe("b\n### b2\nmore");
    expect(sectionOf("## A\na", "B")).toBe("");
  });
});

describe("notebook", () => {
  test("write type notebook upserts one private draft per author, ignoring id/title/state", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    expect(notebookOf(world, noor.id)).toBeUndefined();
    const a = await world.verbs.write(noor.id, { type: "notebook", title: "whatever", body: "v1", state: "building" });
    const other = await world.verbs.write(noor.id, { type: "note", title: "n", body: "b", state: "draft" });
    const b = await world.verbs.write(noor.id, { id: other.id, type: "notebook", title: "ignored", body: "v2", state: "draft" });
    expect(b.id).toBe(a.id);
    expect(world.docs.count("authorId = ? AND type = 'notebook'", [noor.id])).toBe(1);
    expect(notebookOf(world, noor.id)).toMatchObject({ id: a.id, title: `${noor.name}'s notebook`, body: "v2", state: "draft" });
    expect(world.docs.require(other.id).body).toBe("b");
    await expect(world.verbs.write(noor.id, { id: a.id, type: "note", title: "t", body: "b", state: "draft" })).rejects.toThrow(/notebook/);
    // another agent gets its own
    const m = await world.verbs.write(by("Mei").id, { type: "notebook", title: "", body: "mei", state: "draft" });
    expect(m.id).not.toBe(a.id);
    // private: others can't read it
    await expect(world.verbs.read(by("Mei").id, { id: a.id })).rejects.toThrow();
  });

  test("the block caps long notebooks to the last NOTEBOOK_CAP chars with a note", () => {
    const now = Date.now();
    expect(notebookBlock(undefined)).toMatch(/^## Your notebook\n\(empty/);
    const body = "START" + "y".repeat(NOTEBOOK_CAP) + "END";
    const blk = notebookBlock({ id: "dc_nb", body, updatedAt: new Date(now).toISOString() } as never, NOTEBOOK_CAP, now);
    expect(blk).toContain(`only the last ${NOTEBOOK_CAP} are shown`);
    expect(blk).not.toContain("START");
    expect(blk.endsWith("END")).toBe(true);
    expect(blk.length).toBeLessThan(NOTEBOOK_CAP + 200);
    expect(notebookBlock({ id: "dc_nb", body: "short", updatedAt: new Date(now).toISOString() } as never, NOTEBOOK_CAP, now)).toBe("## Your notebook\n(dc_nb, updated just now)\nshort");
  });
});

describe("work brief carries memory", () => {
  test("composeWorkBrief: notebook in system, recent work in prompt, notebook rule in the world rules", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    await world.verbs.write(noor.id, { type: "notebook", title: "", body: "Waiting on Mitchell about 0.44.", state: "draft" });
    await world.verbs.write(noor.id, { type: "article", title: "Airborne fraction", body: "It is 0.44 ± 0.03.", state: "building" });
    const asg = world.ops.createWork(null, noor.id, { title: "Answer Mitchell", description: "What did you find?" });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id, backend: "docker" });
    const b = composeWorkBrief(world, s.id);
    expect(b.system).toContain("## Your notebook");
    expect(b.system).toContain("Waiting on Mitchell about 0.44.");
    expect(b.system).toContain("Your notebook is your memory between sessions");
    expect(b.prompt).toContain("## Your recent work");
    expect(b.prompt).toMatch(/- article "Airborne fraction" \(dc_[\w-]+, just now\): It is 0\.44 ± 0\.03\./);
    expect(b.prompt).toContain(READ_FIRST);
    expect(b.prompt).toContain("What did you find?");
  });
});
