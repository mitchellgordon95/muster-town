import { describe, expect, it } from "vitest";
import { clockLine, fromNow, guessedTimes, guessedTimesWarning, stamp, waitedFor, whenFor } from "../src/time.ts";
import { oneOnOnePrompt, oneOnOneUtterance, workSystemPrompt } from "../src/prompts.ts";
import { seededWorld } from "./helpers.ts";

const NOW = Date.parse("2026-10-31T20:30:00Z");
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

describe("time in words (core/time.ts, 1:1 mt_3jtclcoxl2)", () => {
  it("stamp is the one server-read form: YYYY-MM-DD HH:MM UTC", () => {
    expect(stamp("2026-10-31T20:26:08.642Z")).toBe("2026-10-31 20:26 UTC");
    expect(stamp(NOW)).toBe("2026-10-31 20:30 UTC");
  });
  it("fromNow is a duration in both directions, in min / h / d", () => {
    expect(fromNow(at(0), NOW)).toBe("just now");
    expect(fromNow(at(-0.5), NOW)).toBe("just now");
    expect(fromNow(at(-5), NOW)).toBe("5 min ago");
    expect(fromNow(at(10), NOW)).toBe("in 10 min");
    expect(fromNow(at(-185), NOW)).toBe("3 h ago");
    expect(fromNow(at(26 * 60), NOW)).toBe("in 1 d");
    expect(fromNow(at(-3 * 24 * 60), NOW)).toBe("3 d ago");
  });
  it("whenFor gives a human the duration and an agent the stamp with the duration beside it", () => {
    expect(whenFor(at(-25), "human", NOW)).toBe("25 min ago");
    expect(whenFor(at(-25), "agent", NOW)).toBe("2026-10-31 20:05 UTC (25 min ago)");
  });
  it("waitedFor keeps the deck's form", () => {
    expect(waitedFor(null, new Date(NOW))).toBe("");
    expect(waitedFor(at(-12), new Date(NOW))).toBe("12 min");
    expect(waitedFor(at(-4.1 * 60), new Date(NOW))).toBe("4.1 h");
    expect(waitedFor(at(-2.3 * 24 * 60), new Date(NOW))).toBe("2.3 d");
  });
  it("clockLine carries the server's clock and the rule", () => {
    const line = clockLine(NOW);
    expect(line).toContain("Clock: it is 2026-10-31 20:30 UTC as this starts");
    expect(line).toMatch(/never a guessed "~HH:MM UTC"/);
    expect(guessedTimes(line)).toEqual([]);
  });
  it("guessedTimes finds hand-written approximate stamps and nothing else", () => {
    expect(guessedTimes('My page says "~21:25 UTC" and my log narrates "~20:40Z" on entries stamped 19:56; it is ~now.'))
      .toEqual(["~21:25 UTC", "~20:40Z", "~now"]);
    expect(guessedTimes("about 20:40Z, around 9:05 UTC, ≈ 20:50:30Z")).toEqual(["about 20:40Z", "around 9:05 UTC", "≈ 20:50:30Z"]);
    expect(guessedTimes("Live e41f375 since 2026-10-31 20:26 UTC (4 min ago); the 1:1 opened at 20:16:23Z; resets 8:50pm (UTC); ~12 min of CI; ~2 h ago"))
      .toEqual([]);
  });
  it("the warning names what was found and the rule; null when clean", () => {
    expect(guessedTimesWarning("stamped 2026-10-31 20:26 UTC")).toBeNull();
    const w = guessedTimesWarning("done ~20:50Z, rollup ~21:55Z")!;
    expect(w).toMatch(/^Guessed times "~20:50Z", "~21:55Z": you have no clock/);
    expect(w).toContain('"YYYY-MM-DD HH:MM UTC"');
  });
  it("write (wiki, log) and submit_report file the doc and warn on guessed times", async () => {
    const { world, by } = seededWorld();
    const mei = by("Mei");
    const page = await world.verbs.write(mei, { type: "wiki", title: "Rollup materials", body: "Rollup 32 note due ~21:25 UTC.", state: "draft" });
    expect(world.docs.get(page.id)?.body).toBe("Rollup 32 note due ~21:25 UTC.");
    expect(page.warnings).toEqual([expect.stringMatching(/^Guessed time "~21:25 UTC"/)]);
    expect((page as { note?: string }).note).toMatch(/Wiki page "Rollup materials" created/);
    const clean = await world.verbs.write(mei, { type: "wiki", title: "Rollup materials", body: "Rollup 32 note filed 2026-10-31 19:56 UTC.", state: "draft" });
    expect(clean).not.toHaveProperty("warnings");
    const log = await world.verbs.write(mei, { type: "log", title: "", body: "~20:40Z merged #179", state: "draft" });
    expect(log.warnings).toHaveLength(1);
    const r = await world.verbs.submit_report(mei, { title: "x", body: "## What I did\nmerged ~20:40Z\n## Findings\nx\n## What I need from you\nNothing needed.", verdict: "stop" });
    expect(world.docs.get(r.id)?.type).toBe("report");
    expect(r.warnings).toEqual([expect.stringMatching(/^Guessed time "~20:40Z"/)]);
    expect(r.note).toMatch(/Report submitted/);
  });
  it("every work brief and 1:1 opens with the server's clock; 1:1 lines carry their stamp", () => {
    const { world, by, admin } = seededWorld();
    const mei = by("Mei");
    const building = world.buildings.require("carbon-cycle", "building");
    expect(workSystemPrompt(mei, building, world.town.get(), { now: NOW })).toContain("Clock: it is 2026-10-31 20:30 UTC as this starts");
    world.ops.updateBuilding(admin, "carbon-cycle", { managerAgentId: mei.id });
    const m = world.ops.openOneOnOne(admin, "carbon-cycle");
    world.ops.meetingSay(admin, m.id, "wait what time is it right now");
    const p = oneOnOnePrompt(world.meetings.require(m.id), (id) => world.nameOf(id), undefined, NOW);
    expect(p).toContain("Clock: it is 2026-10-31 20:30 UTC as this starts");
    expect(p).toMatch(/\n- \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \\w+: wait what time is it right now/);
    expect(oneOnOneUtterance(m, "Mitchell", "and now?", "2026-10-31T20:22:40.589Z")).toMatch(/^Mitchell said in the 1:1 \(mt_[\w-]+\) at 2026-10-31 20:22 UTC: and now\?/);
  });
});
