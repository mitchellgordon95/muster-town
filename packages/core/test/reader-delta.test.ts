/**
 * The reader's delta (docs/legible-delegation.md §5 "Diff-first", build step 3): what one human last opened, decided and
 * said about a grant, and which of its reports they have not read, from the seen table, the grant's history and the
 * meeting transcripts; the manager's first message carries it for each open grant of its building.
 */
import { describe, expect, it } from "vitest";
import { buildingRoleId, managerStateBlock, newId, nowIso } from "../src/index.ts";
import { captainUserId, markSeen, readerDelta } from "../src/seen.ts";
import { seededWorld } from "./helpers.ts";

const LAB = "carbon-cycle";
const later = () => new Promise((r) => setTimeout(r, 5));

describe("the reader's delta (docs/legible-delegation.md §5)", () => {
  it("a grant's delta: last opened, last decided, what the human said naming it, and its reports they have not read", async () => {
    const { world, admin, seed, by } = seededWorld();
    const userId = seed.admin.id;
    const mei = by("Mei"), noor = by("Noor");
    world.ops.updateBuilding(admin, LAB, { managerAgentId: mei.id });
    world.permissions.grant({ kind: "agent", id: mei.id }, buildingRoleId(LAB, "manager"));
    const g = world.grantDesk.propose(mei, world.grantDesk.create(mei, LAB, { keyResults: [{ text: "k", howToCheck: "h" }], objective: "Self-host from a published image", steps: [{ title: "Step 1", description: "d" }, { title: "Step 2", description: "d" }], stopCondition: "s", askTokens: 600_000 }).id);

    // nothing yet: never opened, never decided, nothing said, nothing to read
    expect(readerDelta(world, userId, { kind: "grant", id: g.id })).toEqual({ lastSeen: null, lastDecided: null, lastSaid: [], unreadReports: [] });

    world.grantDesk.decide(admin, g.id, { action: "fund", note: "Go, but keep it to two steps" });
    markSeen(world, userId, "grant", g.id);
    const firstSeen = readerDelta(world, userId, { kind: "grant", id: g.id }).lastSeen!;
    await later();
    markSeen(world, userId, "grant", g.id); // a second open moves the time, one row
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM seen").get()).toEqual({ n: 1 });
    // two reports on the grant: step 1's (funding queued it) and the checkpoint card; the human opens one
    const r1 = await world.verbs.submit_report(noor, { title: "Step 1 done", body: "## What I did\nx", verdict: "continue" });
    const r2 = await world.verbs.submit_report(noor, { title: "Checkpoint", body: "## What I did\ny", verdict: "stop" });
    const step = world.assignments.first("grantId = ?", [g.id])!;
    world.assignments.upsert({ ...step, reportId: r1.id });
    world.grants.upsert({ ...world.grants.require(g.id), checkpointDocId: r2.id });
    markSeen(world, userId, "report", r2.id);
    // a 1:1 where the human named the grant by id, then by two words of its objective, and a line about something else
    const at = nowIso();
    world.meetings.upsert({
      id: newId("mt"), kind: "one-on-one", buildingId: LAB, title: "1:1", scheduledAt: at, createdAt: at, withUserId: userId,
      transcript: [
        { speakerId: userId, speakerKind: "user", text: `Keep ${g.id} small.`, at },
        { speakerId: mei.id, speakerKind: "agent", text: `Will do on ${g.id}.`, at },
        { speakerId: userId, speakerKind: "user", text: "The published image is what strangers need for self-host.", at: new Date(Date.now() + 1000).toISOString() },
        { speakerId: userId, speakerKind: "user", text: "Unrelated: the deck colours.", at },
      ],
    } as never);

    const d = readerDelta(world, userId, { kind: "grant", id: g.id });
    expect(d.lastSeen! > firstSeen).toBe(true);
    expect(d.lastDecided).toEqual({ action: "fund", at: expect.any(String), note: "Go, but keep it to two steps" });
    expect(d.lastSaid.map((s) => s.line)).toEqual(["The published image is what strangers need for self-host.", `Keep ${g.id} small.`]);
    expect(d.unreadReports).toEqual([r1.id]);
    // another human's delta is their own: nothing
    expect(readerDelta(world, "us_someoneelse", { kind: "grant", id: g.id })).toMatchObject({ lastSeen: null, lastDecided: null, lastSaid: [] });

    // the manager's first message carries it, for the captain, per open grant of its building
    expect(captainUserId(world)).toBe(userId);
    const block = managerStateBlock(world, mei, world.buildings.require(LAB));
    expect(block).toContain("## What Mitchell has seen");
    expect(block).toMatch(new RegExp(`${g.id} "Self-host from a published image" \\(funded\\): Mitchell last opened it .*last decided "fund" .*noting "Go, but keep it to two steps".*said "Keep ${g.id} small\\." in mt_.*has not read 1 of its reports: ${r1.id}`));
  }, 30_000);
});
