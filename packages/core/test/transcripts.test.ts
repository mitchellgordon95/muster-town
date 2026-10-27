import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brotli, createBuilding, createResident } from "../src/index.ts";
import { seededWorld } from "./helpers.ts";

const jsonl = Buffer.from('{"type":"user","n":1}\n{"type":"assistant","n":2}\n');

function setup() {
  const { world, seed } = seededWorld();
  const b = createBuilding(world, { name: "Lab" }, seed.admin.id);
  const agent = createResident(world, { buildingId: b.id, name: "A", title: "t", direction: "d" });
  createResident(world, { buildingId: b.id, name: "B", title: "t", direction: "d" });
  const session = world.ops.startSession(agent.id, { purpose: "work", model: "claude-opus-5-5" });
  return { world, seed, agent, session };
}

describe("transcripts", () => {
  it("stores brotli or raw JSONL, reads it back and records an event", () => {
    const { world, session } = setup();
    const info = world.transcripts.put(session, brotli(jsonl), { compressed: true, source: "desk" });
    expect(info).toMatchObject({ sessionId: session.id, bytes: jsonl.length, lines: 2, source: "desk", url: `/api/sessions/${session.id}/transcript` });
    expect(existsSync(join(world.transcripts.dir, `${session.id}.jsonl.br`))).toBe(true);
    expect(world.transcripts.info(session.id)?.lines).toBe(2);
    expect(Date.parse(info.expiresAt) - Date.parse(info.createdAt)).toBe(90 * 86_400_000);
    world.transcripts.put(session, jsonl, { compressed: false, source: "host" });
    expect(world.transcripts.info(session.id)?.source).toBe("host");
  });

  it("refuses lines that aren't JSON and garbage that isn't brotli", () => {
    const { world, session } = setup();
    expect(() => world.transcripts.put(session, Buffer.from("not json\n"), { compressed: false, source: "host" })).toThrow(/not JSON/);
    expect(() => world.transcripts.put(session, Buffer.from("xx"), { compressed: true, source: "desk" })).toThrow(/brotli/);
  });

  it("prunes after the retention period", () => {
    const { world, session } = setup();
    world.transcripts.put(session, jsonl, { compressed: false, source: "host" });
    world.setDesksConfig({ transcriptDays: 1 });
    expect(world.transcripts.prune(new Date(Date.now() + 2 * 86_400_000), true)).toBe(1);
    expect(world.transcripts.info(session.id)).toBeNull();
    expect(existsSync(join(world.transcripts.dir, `${session.id}.jsonl.br`))).toBe(false);
  });

  it("is readable by the agent itself and an admin, not by another resident", () => {
    const { world, agent, session, seed } = setup();
    const other = world.agents.first("kind = 'resident' AND id != ?", [agent.id]);
    expect(world.transcripts.canRead(agent, session)).toBe(true);
    expect(world.transcripts.canRead(world.ops.ensureAvatar(seed.admin.id), session)).toBe(true);
    if (other && !world.permissions.can(other, "building.manage", agent.homeBuildingId ?? agent.buildingId)) expect(world.transcripts.canRead(other, session)).toBe(false);
    expect(world.transcripts.canRead(null, session)).toBe(false);
  });
});
