/**
 * The Secretary's digest card over the API (gr_kdlogzzo5s step 3): GET /api/buildings/town-hall/intray carries the
 * latest card as `digest` (decisions live, Shipped lines, covered rollups); the rollups it archived leave `reports`,
 * a rollup with a real call stays; GET /api/review-deck has it as slide 2.
 */
import { buildingRoleId, createDoc } from "@muster-town/core";
import { afterEach, describe, expect, it } from "vitest";
import { json, seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const LAB = "carbon-cycle";
const body = (call: string) => `## Shipped\n**1. A banner**\n**What it is:** a banner\n**What you'd see:** the board\n**Your call:** ${call}\n\n## Decided\n- none\n## Key results\n(none)\n## Needs from Mitchell\nNothing needed.`;

describe("the digest card in the Town Hall in-tray", () => {
  it("comes first as `digest`; its archived rollups leave the list; the deck shows it as slide 2", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const { world, app, auth, by } = s;
    const mei = by("Mei");
    world.permissions.grant(mei, buildingRoleId(LAB, "manager"));
    const sec = world.secretary.ensure()!;
    const rollup = (call: string) => createDoc(world, { type: "report", title: `Rollup: ${call}`, body: body(call), authorId: mei.id, authorKind: "agent", buildingId: LAB, state: "building", tags: ["rollup"], decision: "pending" });
    const quiet = rollup("None");
    const asks = rollup("Merge PR #12?");
    expect((await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body.digest).toBeNull();

    const secAuth = { authorization: `Bearer ${world.tokens.getOrCreate("agent", sec.id)}` };
    const filed = await json(app, "POST", "/api/verbs/digest", { headers: secAuth, body: { shipped: [{ rollupId: quiet.id, line: "A banner shows today's spend", theme: "Bank and speed" }] } });
    expect(filed.status).toBe(200);

    const intray = (await json(app, "GET", "/api/buildings/town-hall/intray", { headers: auth })).body;
    expect(intray.digest).toMatchObject({ doc: { id: filed.body.result.digestId, type: "digest" }, shipped: `**Bank and speed**\n\n- A banner shows today's spend (${quiet.id})` });
    expect(intray.digest.decisions).toEqual([{ heading: "Questions in words (1)", note: null, lines: [expect.stringContaining("Merge PR #12?")] }]);
    expect(intray.digest.covered.map((r: { id: string; pending: boolean }) => [r.id, r.pending])).toEqual([[quiet.id, false], [asks.id, true]]);
    const ids = intray.reports.map((d: { id: string }) => d.id);
    expect(ids).not.toContain(quiet.id);
    expect(ids).toContain(asks.id);

    const deck = (await json(app, "GET", "/api/review-deck", { headers: auth })).body;
    expect(deck.slides.slice(0, 2).map((x: { kind: string }) => x.kind)).toEqual(["town", "digest"]);
  });
});
