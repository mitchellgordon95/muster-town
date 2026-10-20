import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importV0, parseFrontmatter } from "../src/index.ts";
import { CARBON_DIR, freshWorld, seededWorld, tempDir } from "./helpers.ts";

describe("importV0", () => {
  it("imports buildings/carbon-cycle: building, 5 residents, sources in library, articles, Ravi's pending report", () => {
    const { world } = freshWorld();
    const u = world.ops.createUser("Mitchell").user;
    const r = importV0(world, CARBON_DIR, { creatorUserId: u.id });
    expect(r.building).toMatchObject({ id: "carbon-cycle", name: "Carbon Cycle Lab", reviewPolicy: "human", maxTurnsPerSession: 40, headcount: 6 });
    expect(r.agents.map((a) => a.name)).toEqual(["Noor", "Tomas", "Mei", "Ravi", "Ingrid"]);
    expect(Object.keys(r.deskAgents)).toEqual(["atmosphere", "land", "ocean", "sources", "feedbacks"]);
    const sources = world.docs.where("type = 'source'");
    expect(sources).toHaveLength(4);
    expect(sources.every((d) => d.state === "library")).toBe(true);
    expect(sources.every((d) => d.authorId === r.deskAgents.sources)).toBe(true); // cited by Ravi's report
    expect(sources.find((d) => d.title.includes("ESSD") || d.body.includes("essd"))?.provenance.urls.length).toBeGreaterThan(0);
    expect(world.docs.where("type = 'article' AND state = 'building'").map((d) => d.title)).toContain("Master article");
    expect(world.docs.count("type = 'article'")).toBe(6);
    const report = world.docs.first("type = 'report'")!;
    expect(report).toMatchObject({ authorId: r.deskAgents.sources, verdict: "continue", decision: "pending", state: "building" });
    expect(report.createdAt).toBe("2026-10-19T22:05:00.000Z");
    expect(report.body).toMatch(/\]\(doc:dc_/); // relative links rewritten
    expect(report.provenance.sourceIds.length).toBe(4);
    expect(world.agents.require(r.deskAgents.sources).status).toBe("idle"); // v1.2: a pending report leaves its author idle
    expect(world.permissions.can({ kind: "user", id: u.id }, "building.manage", "carbon-cycle")).toBe(true);
    expect(() => importV0(world, CARBON_DIR)).toThrow(/already exists/);
  });
});

describe("export", () => {
  it("writes the mirror, commits, skips no-op commits, and round-trips doc count", async () => {
    const { world, by, seed } = seededWorld();
    await world.verbs.write(by("Mei"), { title: "Private draft", body: "secret-ish" });
    await world.verbs.request_human(by("Ingrid"), { title: "Field photo", body: "please" });
    const m = world.ops.createMeeting(null, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.endMeeting(null, m.id);
    const dir = tempDir();
    const r1 = world.export(dir);
    expect(r1.changed).toBe(true);
    expect(r1.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dir, "town.json"))).toBe(true);
    expect(existsSync(join(dir, "buildings/carbon-cycle/building.json"))).toBe(true);
    expect(readdirSync(join(dir, "library/source"))).toHaveLength(4);
    expect(readdirSync(join(dir, "town-hall/outbox"))).toHaveLength(1);
    expect(readdirSync(join(dir, "buildings/carbon-cycle/docs/report"))).toHaveLength(1);
    expect(readdirSync(join(dir, "meetings"))).toHaveLength(1);
    expect(readdirSync(join(dir, "events")).every((f) => f.endsWith(".jsonl"))).toBe(true);
    const reportFile = readdirSync(join(dir, "buildings/carbon-cycle/docs/report"))[0];
    const { data } = parseFrontmatter(readFileSync(join(dir, "buildings/carbon-cycle/docs/report", reportFile), "utf8"));
    expect(data).toMatchObject({ type: "report", decision: "pending" });
    // no secrets / drafts
    const secrets = [seed.adminToken, world.tokens.getOrCreate("agent", by("Mei").id)];
    const tracked = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" }).trim().split("\n");
    for (const f of tracked) {
      const text = readFileSync(join(dir, f), "utf8");
      for (const s of secrets) expect(text.includes(s), f).toBe(false);
    }
    expect(execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" })).not.toContain("private-draft");
    expect(readFileSync(join(dir, "agents.json"), "utf8")).not.toContain("apiKey");

    const r2 = world.export(dir);
    expect(r2.changed).toBe(false);
    expect(r2.commit).toBe(r1.commit);

    const exportedDocs = world.docs.count("state != 'draft'");
    const { world: w2 } = freshWorld();
    const counts = w2.importExport(dir);
    expect(counts.docs).toBe(exportedDocs);
    expect(w2.docs.count()).toBe(exportedDocs);
    expect(w2.agents.count()).toBe(world.agents.count());
    const lots = (w: typeof world) => Object.fromEntries(w.buildings.all().map((b) => [b.id, b.lot]));
    expect(lots(w2)).toEqual(lots(world));
    const before = world.docs.first("type = 'report'")!;
    expect(w2.docs.require(before.id)).toEqual(before);
    expect(w2.layout.deskOf(by("Ravi").id)?.pos).toEqual(world.layout.deskOf(by("Ravi").id)?.pos);
    expect(counts.meetings).toBe(1);
  });
});
