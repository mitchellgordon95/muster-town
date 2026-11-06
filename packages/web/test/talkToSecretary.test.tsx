import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Agent } from "@muster-town/schema";
import { store } from "../src/state";
import { secretaryOf } from "../src/panels/oneOnOne";
import { TownHallStaff } from "../src/panels/BuildingPanel";
import { DigestLine, ReviewAsDeckButton, TalkToSecretary } from "../src/panels/Places";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const agent = (id: string, name: string, extra: Partial<Agent> = {}) => ({ id, name, kind: "resident", status: "idle", homeBuildingId: "town-hall", buildingId: "town-hall", forkOf: null, ...extra }) as Agent;
const SEC = agent("ag_sec", "Secretary", { title: "Secretary" });
const AGENTS = { ag_plan: agent("ag_plan", "Planner"), ag_sec: SEC, ag_w: agent("ag_w", "Sage", { title: "Secretary", homeBuildingId: "workshop" }) };
const BUILDINGS = [{ id: "town-hall", kind: "town-hall", managerAgentId: "ag_plan" }];
const signIn = (agents: Record<string, Agent>, admin = true) => { store.state = { ...store.state, agents, buildings: BUILDINGS as never, me: { isAdmin: admin, roles: [], user: { id: "us_m" } } as never }; };

describe("Talk to Secretary (1:1 mt_1vs893enaw)", () => {
  it("secretaryOf finds the Town Hall's live Secretary only", () => {
    expect(secretaryOf(AGENTS, "town-hall")?.id).toBe("ag_sec");
    expect(secretaryOf({ ag_w: AGENTS.ag_w }, "town-hall")).toBeNull();
    expect(secretaryOf({ ag_sec: { ...SEC, status: "stopped" } }, "town-hall")).toBeNull();
    expect(secretaryOf({ ag_s1: { ...SEC, id: "ag_s1", forkOf: "ag_sec" } }, "town-hall")).toBeNull();
    expect(secretaryOf(AGENTS, null)).toBeNull();
  });

  it("shows in the in-tray header, not on the digest line (one line like any other item); nothing without a Secretary or permission", () => {
    signIn(AGENTS);
    expect(renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} />)).toContain("Talk to Secretary");
    const card = { doc: { id: "dc_d", title: "Digest", createdAt: "2026-11-04T07:00:00Z", authorId: "ag_sec" }, decisions: [], shipped: "", covered: [] } as never;
    expect(renderToStaticMarkup(<DigestLine card={card} onOpen={() => undefined} />)).not.toContain("Talk to Secretary");
    signIn({ ag_plan: AGENTS.ag_plan });
    expect(renderToStaticMarkup(<TalkToSecretary />)).toBe("");
    signIn(AGENTS, false);
    expect(renderToStaticMarkup(<TalkToSecretary />)).toBe("");
  });

  it("the Town Hall's Staff line: a Talk button per agent, no ★; names only without permission", () => {
    signIn(AGENTS);
    const html = renderToStaticMarkup(<TownHallStaff hallId="town-hall" planner={AGENTS.ag_plan} secretary={SEC} />);
    expect(html).toContain("Talk to Planner");
    expect(html).toContain("Talk to Secretary");
    expect(html).not.toContain("★");
    signIn(AGENTS, false);
    const plain = renderToStaticMarkup(<TownHallStaff hallId="town-hall" planner={AGENTS.ag_plan} secretary={SEC} />);
    expect(plain).not.toContain("Talk to");
    expect(plain).toContain("Secretary (the daily digest)");
  });
});

describe("Daily digest button (1:1 mt_i50xwu4z2t)", () => {
  it("sits in the in-tray header for a human who may press it; disabled with why while a run is live or nothing is new", () => {
    signIn(AGENTS);
    const html = (run: { scheduleId: string; runningId: string | null; refused: string | null } | null) => renderToStaticMarkup(<ReviewAsDeckButton count={2} onOpen={() => undefined} digestRun={run} />);
    expect(html(null)).not.toContain("Daily digest");
    const ready = html({ scheduleId: "sc_d", runningId: null, refused: null });
    expect(ready).toMatch(/<button[^>]*title="Run the Secretary&#x27;s daily digest now[^"]*"[^>]*>Daily digest<\/button>/);
    expect(ready).not.toMatch(/disabled=""[^>]*>Daily digest/);
    expect(html({ scheduleId: "sc_d", runningId: "as_r", refused: "a digest run is under way" })).toMatch(/disabled=""[^>]*title="Not now: a digest run is under way"[^>]*>Digest running…<\/button>/);
  });
});

