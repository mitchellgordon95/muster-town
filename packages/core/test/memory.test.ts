import { describe, expect, test } from "vitest";
import {
  appendLog, composeWorkBrief, createDoc, docGist, FALLBACK_REPORT_PREFIX, logOf, memoryBlock, READ_FIRST, recentWorkBlock, sectionOf, wikiOf, WIKI_PAGE_CAP,
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
    await world.verbs.write(noor.id, { type: "wiki", title: "notebook topic", body: "my notes", state: "draft" });
    await world.verbs.write(noor.id, { type: "log", title: "", body: "a notebook line", state: "draft" });
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

describe("memory: wiki + log", () => {
  test("write type wiki upserts one private page per topic (by title or id); other types can't overwrite it; others can't read it", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    expect(wikiOf(world, noor.id)).toEqual([]);
    const a = await world.verbs.write(noor.id, { type: "wiki", title: "The Bank", body: "v1", state: "building" });
    const again = await world.verbs.write(noor.id, { type: "wiki", title: "the bank", body: "v2", state: "draft" });
    expect(again.id).toBe(a.id);
    const byId = await world.verbs.write(noor.id, { id: a.id, type: "wiki", title: "Bank (allocations)", body: "v3", state: "draft" });
    expect(byId.id).toBe(a.id);
    const other = await world.verbs.write(noor.id, { type: "wiki", title: "Fly deploys", body: "machines", state: "draft" });
    expect(other.id).not.toBe(a.id);
    expect(wikiOf(world, noor.id).map((p) => [p.title, p.body, p.state])).toEqual([["Fly deploys", "machines", "draft"], ["Bank (allocations)", "v3", "draft"]]);
    await expect(world.verbs.write(noor.id, { id: a.id, type: "note", title: "t", body: "b", state: "draft" })).rejects.toThrow(/wiki/);
    await expect(world.verbs.write(noor.id, { type: "wiki", title: "  ", body: "b", state: "draft" })).rejects.toThrow(/title/);
    await expect(world.verbs.write(noor.id, { type: "notebook", title: "", body: "b", state: "draft" })).rejects.toThrow(/wiki/);
    // another agent gets its own page on the same topic
    const m = await world.verbs.write(by("Mei").id, { type: "wiki", title: "The Bank", body: "mei", state: "draft" });
    expect(m.id).not.toBe(a.id);
    // private: others can't read it
    await expect(world.verbs.read(by("Mei").id, { id: a.id })).rejects.toThrow();
  });

  test("write type log appends dated lines to one private log; appendLog keeps the last lines", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    expect(logOf(world, noor.id)).toBeUndefined();
    const l1 = await world.verbs.write(noor.id, { type: "log", title: "", body: "Decided: NOAA GML", state: "draft" });
    const l2 = await world.verbs.write(noor.id, { type: "log", title: "ignored", body: "Shipped PR #3\nsecond line folded", state: "draft" });
    expect(l2.id).toBe(l1.id);
    const log = logOf(world, noor.id)!;
    expect(log).toMatchObject({ title: `${noor.name}'s log`, state: "draft" });
    expect(log.body.split("\n")).toHaveLength(2);
    expect(log.body).toMatch(/^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Decided: NOAA GML\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} Shipped PR #3 second line folded$/);
    await expect(world.verbs.write(noor.id, { id: log.id, type: "note", title: "t", body: "b", state: "draft" })).rejects.toThrow(/log/);
    const who = { id: noor.id, kind: "agent" as const, name: noor.name, buildingId: noor.homeBuildingId, agentId: noor.id };
    for (let i = 0; i < 600; i++) appendLog(world, who, `line ${i}`);
    const lines = logOf(world, noor.id)!.body.split("\n");
    expect(lines).toHaveLength(500);
    expect(lines.at(-1)).toContain("line 599");
  });

  test("memoryBlock: pages whole up to the caps, then by title and gist; the log's tail; empty states", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    const empty = memoryBlock(world, noor.id);
    expect(empty).toContain("## What you know (your wiki)\n(no pages yet.");
    expect(empty).toContain("## Your log\n(empty)");
    await world.verbs.write(noor.id, { type: "wiki", title: "Small", body: "A short page.\n" + "x".repeat(200), state: "draft" });
    await world.verbs.write(noor.id, { type: "wiki", title: "Huge", body: "H".repeat(WIKI_PAGE_CAP + 100), state: "draft" });
    await world.verbs.write(noor.id, { type: "wiki", title: "Listed", body: "First line of the listed page.\nmore", state: "draft" });
    for (let i = 1; i <= 15; i++) await world.verbs.write(noor.id, { type: "log", title: "", body: `event ${i}`, state: "draft" });
    // budget: Listed (34 chars) + Huge (cut to the page cap) fit; Small (214 chars) doesn't and is listed by gist
    const b = memoryBlock(world, noor.id, { totalCap: WIKI_PAGE_CAP + 100, tail: 3 });
    expect(b.indexOf("### Listed")).toBeGreaterThan(-1);
    expect(b.indexOf("### Listed")).toBeLessThan(b.indexOf("### Huge"));
    expect(b).not.toContain("### Small");
    expect(b).toContain("…(page is " + (WIKI_PAGE_CAP + 100) + " chars");
    expect(b).toMatch(/Other pages \(`read` the ones that matter\):\n- "Small" \(dc_[\w-]+, just now\): A short page\./);
    expect(b).toMatch(/## Your log \(last 3 of 15; `read` dc_[\w-]+ for all\)\n- .* event 13\n- .* event 14\n- .* event 15$/);
  });

});

describe("work brief carries memory", () => {
  test("composeWorkBrief: wiki and log in system, recent work in prompt, the memory rule in the world rules; the manager gets the team", async () => {
    const { world, by } = seededWorld();
    const noor = by("Noor");
    await world.verbs.write(noor.id, { type: "wiki", title: "Dashboard", body: "Waiting on Mitchell about 0.44.", state: "draft" });
    await world.verbs.write(noor.id, { type: "article", title: "Airborne fraction", body: "It is 0.44 ± 0.03.", state: "building" });
    const asg = world.ops.createWork(null, noor.id, { title: "Answer Mitchell", description: "What did you find?" });
    const s = world.ops.startSession(noor.id, { purpose: "work", model: "m", assignmentId: asg.id, backend: "docker" });
    const b = composeWorkBrief(world, s.id);
    expect(b.system).toContain("## What you know (your wiki)");
    expect(b.system).toContain("### Dashboard (dc_");
    expect(b.system).toContain("Waiting on Mitchell about 0.44.");
    expect(b.system).toContain("Your memory between sessions is your wiki and your log");
    expect(b.system).not.toContain("## Your team");
    world.buildings.patch(noor.homeBuildingId!, { managerAgentId: noor.id });
    expect(composeWorkBrief(world, s.id).system).toContain("## Your team (you are the manager");
    expect(b.prompt).toContain("## Your recent work");
    expect(b.prompt).toMatch(/- article "Airborne fraction" \(dc_[\w-]+, just now\): It is 0\.44 ± 0\.03\./);
    expect(b.prompt).toContain(READ_FIRST);
    expect(b.prompt).toContain("What did you find?");
  });
});
