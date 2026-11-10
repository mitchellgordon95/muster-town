import { describe, expect, it } from "vitest";
import { hideSecrets } from "../src/meeting-tools.ts";
import { seededWorld } from "./helpers.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("meeting tool calls", () => {
  it("an agent's line keeps its summarized tool calls since its previous line, never raw input", async () => {
    const { world, by, admin } = seededWorld();
    const m = world.ops.createMeeting(admin, { kind: "standup", buildingId: "carbon-cycle", startNow: true });
    world.ops.startMeeting(admin, m.id);
    const noor = by("Noor");
    await sleep(5);
    const tool = (text: string, tool: string, id: string, input: unknown = {}) =>
      world.events.append({ type: "agent.tool", agentId: noor.id, buildingId: "carbon-cycle", text, payload: { sessionId: "se_x", tool, toolUseId: id, input: JSON.stringify(input) } });
    tool("Reading \"Bank fees\"", "mcp__town__read", "t1", { id: "dc_1" });
    world.toolResults.record("se_x", "t1", "# Bank fees\nbody");
    tool("Running: cat .env", "Bash", "t2", { command: "cat .env" });
    world.toolResults.record("se_x", "t2", "GH_TOKEN=ghp_abcdefghijklmnop1234");
    tool("Running: grep x", "Bash", "t3");
    world.toolResults.record("se_x", "t3", "fatal: token=Abc123Def456Ghi789Jkl012Mno", true);
    tool("Listening in the meeting", "mcp__town__meeting", "t4");
    world.ops.meetingSay(admin, m.id, "How are the fees?");
    await world.verbs.meeting(noor, { meetingId: m.id, action: "speak", text: "Fees are 5%." });
    const line = world.meetings.require(m.id).transcript.at(-1)!;
    expect(line.tools).toEqual([
      { what: "Reading \"Bank fees\"", result: "# Bank fees" },
      { what: "Running: cat .env" },
      { what: "Running: grep x", result: "fatal: token=[hidden]", isError: true },
    ]);
    expect(JSON.stringify(line)).not.toContain("ghp_");
    // the next line starts afresh; a human's line carries none
    await sleep(5);
    await world.verbs.meeting(noor, { meetingId: m.id, action: "speak", text: "That's all." });
    const t = world.meetings.require(m.id).transcript;
    expect(t.at(-1)!.tools).toBeUndefined();
    expect(t.find((u) => u.speakerKind === "user")!.tools).toBeUndefined();
  });

  it("hides secret-looking runs and keeps ids and shas", () => {
    expect(hideSecrets("token ghp_abcdefghijklmnop1234 ok")).toBe("token [hidden] ok");
    expect(hideSecrets("API_KEY: sk123")).toBe("API_KEY=[hidden]");
    expect(hideSecrets("dc_q736158pnn at 628dd939aacc9fe677b6b1f1327109bf59aa74b8")).toBe("dc_q736158pnn at 628dd939aacc9fe677b6b1f1327109bf59aa74b8");
  });
});
