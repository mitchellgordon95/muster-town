import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

// gr_zak30564zh kr_obykl8yydh: a grant opens on a summary; how-to-check, notes, the plan and history are one click away
const base = grants.find((g) => g.status === "funded" && g.keyResults.length > 0)!;
const closed = { ...base, status: "closed" as const, outcome: "done" as const, history: [], keyResults: base.keyResults.map((k) => ({ ...k, status: "met" as const, statusNote: "Shipped in PR #1." })) };
const STATE = {
  me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never,
  agents: { ag_m: { id: "ag_m", name: "Moss", kind: "resident", status: "idle", homeBuildingId: base.buildingId, buildingId: base.buildingId, forkOf: null } } as never,
  buildings: [{ id: base.buildingId, name: "B", managerAgentId: "ag_m" }] as never,
};
const html = (onPage: boolean) => renderToStaticMarkup(<GrantRow grant={closed} onPage={onPage} onDecided={() => undefined} onOpenDoc={() => undefined} />);

describe("a grant row opens on a summary", () => {
  it("each key result is one line; its how-to-check and note sit in a disclosure; Mark missed stays outside it", () => {
    store.state = { ...store.state, ...STATE };
    const h = html(false);
    const k = closed.keyResults[0]!;
    expect(h).toContain(k.text);
    const fold = h.indexOf('<details class="kr-more"><summary>How to check · note</summary>');
    expect(fold).toBeGreaterThan(h.indexOf(k.text));
    expect(h.indexOf("How to check: ")).toBeGreaterThan(fold);
    expect(h).toContain("met: <span>Shipped in PR #1.</span>");
    expect(h.indexOf(">Mark missed</button>")).toBeGreaterThan(h.indexOf("</details>"));
    expect(h).toContain("Stop when");
    expect(h).toContain(`<div class="doc-row-title">${closed.objective}`);
  });

  it("on the grant's own page the row leaves the objective (the header has it) and the stop condition (Plan has it) out", () => {
    store.state = { ...store.state, ...STATE };
    const h = html(true);
    expect(h).not.toContain("Stop when");
    expect(h).not.toContain("doc-row-title");
    expect(h).toContain(closed.keyResults[0]!.text);
  });
});
