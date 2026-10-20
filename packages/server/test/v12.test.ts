/** v1.2 server: in-tray route, DELETE agent (dismiss), town.ban, snapshot excludes retired + carries intray. */
import { createTownModerator } from "@agent-town/core";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeHooks } from "../src/context.ts";
import { json, seededApp } from "./helpers.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });
async function setup(runtime: RuntimeHooks | null = null) {
  const s = await seededApp({ runtime });
  closers.push(s.close);
  return s;
}
const REPORT = { title: "Run", verdict: "continue", body: "## Summary\nx\n\n## Proposal for next session\nNext?\n" } as const;

describe("in-tray", () => {
  it("GET /api/buildings/:id/intray lists pending reports oldest first; snapshot carries the count", async () => {
    const { app, world, by } = await setup();
    const a = await world.verbs.submit_report(by("Mei"), REPORT);
    const b = await world.verbs.submit_report(by("Noor"), REPORT);
    const r = await json(app, "GET", "/api/buildings/carbon-cycle/intray");
    expect(r.status).toBe(200);
    const ids = r.body.reports.map((d: any) => d.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(r.body.reports.every((d: any) => d.decision === "pending" && d.type === "report")).toBe(true);
    const town = await json(app, "GET", "/api/town");
    expect(town.body.buildings.find((x: any) => x.id === "carbon-cycle").intray).toBe(ids.length);
    expect(town.body.buildings.find((x: any) => x.id === "town-hall").intray).toBe(0);
    expect((await json(app, "GET", "/api/buildings/nope/intray")).status).toBe(404);
  });
});

describe("DELETE /api/agents/:id", () => {
  it("needs building.manage; dismisses, calls the runtime hook, hides the agent from the snapshot", async () => {
    const retired: { id: string; purge?: boolean }[] = [];
    const runtime: RuntimeHooks = { chat: async () => "", interrupt: () => false, onAgentRetired: (id, o) => { retired.push({ id, purge: o?.purge }); } };
    const { app, auth, world, by } = await setup(runtime);
    const mei = by("Mei");
    const meiToken = world.tokens.getOrCreate("agent", mei.id);
    const tomasToken = world.tokens.getOrCreate("agent", by("Tomas").id);
    expect((await json(app, "DELETE", `/api/agents/${mei.id}`, { headers: { authorization: `Bearer ${tomasToken}` } })).status).toBe(403);
    const r = await json(app, "DELETE", `/api/agents/${mei.id}?purge=1`, { headers: auth });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ agent: { id: mei.id, status: "retired" }, purge: true, deskFreed: true });
    expect(retired).toEqual([{ id: mei.id, purge: true }]);
    // token revoked
    expect((await json(app, "GET", "/api/me", { headers: { authorization: `Bearer ${meiToken}` } })).status).toBe(401);
    const town = await json(app, "GET", "/api/town");
    expect(town.body.agents.some((a: any) => a.id === mei.id)).toBe(false);
    const one = await json(app, "GET", `/api/agents/${mei.id}`);
    expect(one.status).toBe(200);
    expect(one.body.agent.status).toBe("retired");
    expect((await json(app, "DELETE", `/api/agents/${mei.id}`, { headers: auth })).status).toBe(409);
  });
});

describe("ban", () => {
  it("POST /api/agents/:id/ban needs town.ban (reviewer: 403; town moderator: ok)", async () => {
    const { app, world, by } = await setup();
    const tomas = by("Tomas");
    const moss = world.tokens.getOrCreate("agent", by("Moss").id);
    const forbidden = await json(app, "POST", `/api/agents/${tomas.id}/ban`, { headers: { authorization: `Bearer ${moss}` }, body: { reason: "spam" } });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toMatch(/town.ban/);
    const wren = createTownModerator(world, { name: "Wren" });
    const ok = await json(app, "POST", `/api/agents/${tomas.id}/ban`, { headers: { authorization: `Bearer ${world.tokens.getOrCreate("agent", wren.id)}` }, body: { reason: "spam" } });
    expect(ok.status).toBe(200);
    expect(ok.body.agent.status).toBe("banned");
  });
});
