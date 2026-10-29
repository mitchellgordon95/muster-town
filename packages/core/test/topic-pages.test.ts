/** Manager forks step 4 (dc_mymt27yz25 §5, §6): topic pages, revisions, `assign … pages`, the fork memory block and the fork's log. */
import { describe, expect, it, vi } from "vitest";
import { createBuilding, createResident, forkManager, logOf, memoryBlock, revisionsOf, sessionMemory, topicIndexBlock, topicPages, updateBuilding, wikiOf, WIKI_TOTAL_CAP } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000 }); // seeding a world is slow on a loaded desk

/** A 3-desk lab with a manager Pix and a resident Ann, forks on. */
function lab() {
  const s = seededWorld();
  const { world, seed } = s;
  const b = createBuilding(world, { name: "Forky", headcount: 3, dailyTokensPerAgent: 100_000, model: "claude-opus-5-5", cheapModel: "claude-haiku-5-5" }, seed.admin.id);
  world.grantDesk.createKeyResult(s.admin, b.id, { text: "Forks work", howToCheck: "Run the tests" }); // a key result, so the lab isn't blocked
  const pix = createResident(world, { buildingId: b.id, name: "Pix" });
  const ann = createResident(world, { buildingId: b.id, name: "Ann" });
  updateBuilding(world, b.id, { managerAgentId: pix.id });
  world.budget.donate(seed.admin.id, { tokens: 1_000_000, buildingId: b.id });
  const agent = (id: string) => world.agents.require(id);
  const write = (who: string, input: { title: string; body: string; type?: "wiki" | "log" | "note"; topicOf?: string; id?: string }) =>
    world.verbs.write(agent(who), { type: "wiki", state: "draft", ...input });
  const queue = async (title: string, pages?: string[]) => (await world.verbs.assign(agent(pix.id), { title, description: "d", gap: "test gap", ...(pages ? { pages } : {}) })).assignmentId;
  const fork = async (title: string, pages?: string[]) => { const id = await queue(title, pages); return { ...forkManager(world, b.id, id), assignmentId: id }; };
  return { ...s, b: world.buildings.require(b.id), pix: agent(pix.id), ann, write, queue, fork, agent };
}

describe("topic pages", () => {
  it("the manager writes one; it is published in the building, found by title, revisioned on rewrite, and not in its private wiki", async () => {
    const { world, b, pix, write } = lab();
    const r1 = await write(pix.id, { title: "The Bank", body: "v1: counts adjusted tokens", topicOf: b.id });
    const doc = world.docs.require(r1.id);
    expect(doc).toMatchObject({ type: "wiki", state: "building", topicOf: b.id, buildingId: b.id, authorId: pix.id });
    const r2 = await write(pix.id, { title: "the bank", body: "v2: also cache writes", topicOf: b.id });
    expect(r2.id).toBe(r1.id);
    expect(world.docs.require(r1.id).body).toBe("v2: also cache writes");
    expect(revisionsOf(world, r1.id)).toMatchObject([{ docId: r1.id, title: "The Bank", body: "v1: counts adjusted tokens", authorId: pix.id, replacedBy: pix.id }]);
    // a private page of the same title is separate; the topic page isn't in the private wiki
    await write(pix.id, { title: "The Bank", body: "private note" });
    expect(wikiOf(world, pix.id).map((p) => p.body)).toEqual(["private note"]);
    expect(topicPages(world, b.id).map((p) => p.id)).toEqual([r1.id]);
  });

  it("anyone can read it (with its revisions); a resident who isn't the manager can't write one; topicOf must be your building", async () => {
    const { world, b, pix, ann, write, agent } = lab();
    const { id } = await write(pix.id, { title: "Wakes", body: "one", topicOf: b.id });
    await write(pix.id, { title: "Wakes", body: "two", topicOf: b.id });
    const read = await world.verbs.read(agent(ann.id), { id }) as { body: string; revisions?: { body: string }[] };
    expect(read.body).toBe("two");
    expect(read.revisions?.map((r) => r.body)).toEqual(["one"]);
    await expect(write(ann.id, { title: "Wakes", body: "mine", topicOf: b.id })).rejects.toThrow(/manager and its forks/);
    await expect(write(ann.id, { title: "Wakes", body: "mine", id })).rejects.toThrow(/manager and its forks/);
    await expect(write(pix.id, { title: "X", body: "y", topicOf: "workshop" })).rejects.toThrow(/your building id/);
    await expect(write(pix.id, { title: "X", body: "y", type: "note", topicOf: b.id })).rejects.toThrow(/only for wiki/);
    expect(world.docs.require(id).body).toBe("two");
  });

  it("the topic index lists every page with id and gist in a resident's prompt; above 50 it shows the 50 newest and a search pointer", async () => {
    const { world, b, pix, ann, write, agent } = lab();
    expect(topicIndexBlock(world, b.id)).toBe("");
    const { id } = await write(pix.id, { title: "Desk image", body: "## State\nThe desk image has ffmpeg since 5b9eec4." , topicOf: b.id });
    const mem = sessionMemory(world, agent(ann.id), b).memory;
    expect(mem).toContain("## Topic pages");
    expect(mem).toMatch(new RegExp(`"Desk image" \\(${id}, just now\\): The desk image has ffmpeg since 5b9eec4\\.`));
    for (let i = 0; i < 51; i++) await write(pix.id, { title: `Topic ${i}`, body: `gist ${i}`, topicOf: b.id });
    const idx = topicIndexBlock(world, b.id);
    expect(idx.split("\n").filter((l) => l.startsWith("- ")).length).toBe(50);
    expect(idx).toContain("2 more: `search` type wiki for the rest");
  });
});

describe("assign pages", () => {
  it("stores up to 3 topic pages of the building on the assignment; refuses others", async () => {
    const { world, b, pix, ann, write, queue, agent } = lab();
    const ids = [];
    for (const t of ["A", "B", "C", "D"]) ids.push((await write(pix.id, { title: t, body: t, topicOf: b.id })).id);
    const a = await queue("Work", ids.slice(0, 2));
    expect(world.assignments.require(a).pages).toEqual(ids.slice(0, 2));
    await expect(queue("Too many", ids)).rejects.toThrow();
    const priv = (await write(pix.id, { title: "mine", body: "x" })).id;
    await expect(queue("Private", [priv])).rejects.toThrow(/isn't a topic page/);
    // named assignments can carry pages too
    const named = await world.verbs.assign(agent(pix.id), { agentId: ann.id, title: "Named", description: "d", gap: "test gap", pages: [ids[3]] });
    expect(world.assignments.require(named.assignmentId).pages).toEqual([ids[3]]);
  });
});

describe("forks and memory", () => {
  it("a fork rewrites topic pages (revision by the fork) but can't write a private page; its log lines go to the manager's log", async () => {
    const { world, b, pix, write, fork } = lab();
    const { id } = await write(pix.id, { title: "Flags", body: "forks off everywhere", topicOf: b.id });
    const { fork: f } = await fork("Flip the flag");
    await write(f.id, { title: "Flags", body: "forks on in Forky (verified)", topicOf: b.id });
    expect(revisionsOf(world, id).at(-1)).toMatchObject({ authorId: pix.id, replacedBy: f.id });
    await write(pix.id, { title: "Flags", body: "back to Pix", topicOf: b.id });
    expect(revisionsOf(world, id).at(-1)).toMatchObject({ body: "forks on in Forky (verified)", authorId: f.id, replacedBy: pix.id });
    await expect(write(f.id, { title: "My notes", body: "x" })).rejects.toThrow("forks write topic pages (topicOf) or skills");
    expect(wikiOf(world, f.id)).toEqual([]);
    await write(f.id, { type: "log", title: "log", body: "pushed abc123" });
    expect(logOf(world, f.id)).toBeUndefined();
    expect(logOf(world, pix.id)!.body).toMatch(/\[Pix 1\] pushed abc123$/);
  });

  it("a fork keeps the resident permission set: manager verbs are refused", async () => {
    const { world, b, pix, ann, fork, agent } = lab();
    const { fork: f } = await fork("Anything");
    const me = agent(f.id);
    await expect(world.verbs.assign(me, { agentId: ann.id, title: "x", description: "d" })).rejects.toThrow(/building.assign/);
    for (const p of ["building.review", "building.assign", "building.manage", "building.promote"] as const) expect(world.permissions.can(me, p, b.id)).toBe(false);
    expect(world.permissions.can(pix, "building.assign", b.id)).toBe(true);
  });

  it("the fork memory block: the manager's wiki (cut at 3,000), the attached pages, the index if room, under 8,000; the manager's log outside", async () => {
    const { world, b, pix, write, fork, agent } = lab();
    await write(pix.id, { title: "How Mitchell likes things", body: "short answers. ".repeat(300) }); // 4,500 chars
    const big = (await write(pix.id, { title: "The Bank", body: "B".repeat(4000), topicOf: b.id })).id;
    const small = (await write(pix.id, { title: "Wakes", body: "wakes are on main", topicOf: b.id })).id;
    await write(pix.id, { title: "Desk image", body: "ffmpeg is in the image", topicOf: b.id });
    await write(pix.id, { type: "log", title: "log", body: "decided X" });
    const { fork: f, assignmentId } = await fork("Something unrelated", [big, small]);
    const mem = sessionMemory(world, agent(f.id), b, world.assignments.require(assignmentId)).memory;
    const [capped, log] = mem.split("\n## Pix's log");
    expect(capped.length).toBeLessThan(WIKI_TOTAL_CAP + 1500); // bodies under 8,000 plus headings and notes
    expect(capped).toContain("## What Pix knows");
    expect(capped).toContain("cut at 3,000");
    expect(capped).toContain("attached by your manager");
    expect(capped).toContain(`page is 4000 chars; \`read\` ${big} for the rest`);
    expect(capped).toContain("wakes are on main");
    expect(capped).toContain('"Desk image"'); // the index fits
    expect(capped).toContain("You are a fork");
    expect(log).toContain("decided X");
    // the fork's own (empty) wiki and log aren't shown; the resident block isn't either
    expect(mem).not.toContain("## What you know (your wiki)");
    expect(memoryBlock(world, pix.id)).toContain("How Mitchell likes things");
  });

  it("without attached pages a fork loads the 2 topic pages whose titles best match its assignment; a full block points to search", async () => {
    const { world, b, pix, write, fork, agent } = lab();
    await write(pix.id, { title: "Desk image and Fly", body: "image notes", topicOf: b.id });
    await write(pix.id, { title: "The Bank accounting", body: "bank notes", topicOf: b.id });
    await write(pix.id, { title: "Meetings", body: "meeting notes", topicOf: b.id });
    const { fork: f, assignmentId } = await fork("Rebuild the desk image");
    const mem = sessionMemory(world, agent(f.id), b, world.assignments.require(assignmentId)).memory;
    const loaded = mem.split("## Topic pages for this work (best title match)")[1].split("\n## Topic pages (")[0];
    expect(loaded.match(/^### .+ \(/gm)?.length).toBe(2);
    expect(loaded.trim().startsWith("### Desk image and Fly")).toBe(true);
    expect(loaded).not.toContain("### Meetings");
    // with room used up, the index becomes a one-line pointer
    await write(pix.id, { title: "Huge", body: "H".repeat(8000) });
    for (let i = 0; i < 40; i++) await write(pix.id, { title: `Desk ${i}`, body: `${"image ".repeat(500)}`, topicOf: b.id });
    const full = sessionMemory(world, agent(f.id), b, world.assignments.require(assignmentId)).memory;
    expect(full).toContain("`search` type wiki to find them");
    expect(full.split("\n## Pix's log")[0].length).toBeLessThan(WIKI_TOTAL_CAP + 1500);
  });
});
