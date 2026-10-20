import { describe, expect, it } from "vitest";
import type { Agent, Building, Town } from "@agent-town/schema";
import { REPORT_FORMAT, reviewSystemPrompt, summarySystemPrompt, workSystemPrompt } from "../src/prompts.ts";

const agent = { id: "ag_1", name: "Root", title: "Backend", direction: "Core, server, and runtime only." } as Agent;
const building = { id: "workshop", name: "Town Workshop", goal: "Ship PRs", maxTurnsPerSession: 120 } as Building;
const town = { name: "Workshop Collective", goal: "Be trustworthy" } as Town;

describe("prompts carry no titles or job descriptions", () => {
  it("the work prompt names the agent without a title or lane, and says it owns the work end to end", () => {
    const p = workSystemPrompt(agent, building, town);
    expect(p).toContain("You are Root, a resident of the Town Workshop");
    expect(p).toContain("end to end");
    expect(p).not.toContain("Backend");
    expect(p).not.toContain("Core, server, and runtime only.");
    expect(p).not.toMatch(/standing direction/i);
  });
  it("the meeting summary prompt has no title", () => {
    expect(summarySystemPrompt(agent)).not.toContain("Backend");
  });
});

describe("no forced next step", () => {
  it("reports are what I did / findings / what I need from you, and inventing work is discouraged", () => {
    expect(REPORT_FORMAT).toMatch(/## What I did/);
    expect(REPORT_FORMAT).toMatch(/## Findings/);
    expect(REPORT_FORMAT).toMatch(/## What I need from you/);
    expect(REPORT_FORMAT).not.toMatch(/Proposal for next session/);
    expect(REPORT_FORMAT).toMatch(/Never invent follow-up work/);
  });
  it("the reviewer approves finished work by default", () => {
    expect(reviewSystemPrompt(agent, building)).toMatch(/No proposal is fine/);
    expect(reviewSystemPrompt(agent, building)).toMatch(/default for finished work/);
  });
});
