import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { store } from "../src/state";
import { GrantRow } from "../src/panels/Places";
import { ManagingLine, managingLine } from "../src/panels/GrantPanel";
import { LANES, laneHelp, laneLine } from "../src/panels/GoalSpend";
import { MockApi } from "../src/mock/server";
import { grants } from "../src/mock/fixture";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const zero = { grant: 0, exploration: 0, directed: 0, retainer: 0, managing: 0, oneOnOnes: 0, none: 0 };

// gr_064fmkq31s step 2 (kr_hvfgqe89o8, kr_rh6jwxae9r): manager sessions read "managing" and "1:1s"; a grant shows what managing it cost
describe("Spend by goal: managing and 1:1s", () => {
  it("names a manager's sessions managing and 1:1s, each with one plain help line", () => {
    expect(laneLine({ ...zero, grant: 500_000, managing: 300_000, oneOnOnes: 100_000 })).toBe("grant 500k · managing 300k · 1:1s 100k");
    const help = laneHelp({ ...zero, managing: 2, oneOnOnes: 1 });
    expect(help.map((x) => x.label)).toEqual(["managing", "1:1s"]);
    for (const l of LANES) expect(l.help).toMatch(/^[A-Z].*\.$/);
  });
});

describe("the grant page's managing line", () => {
  it("reads 'Managing it: N over M decisions', hidden at 0 or when the server sends none", () => {
    expect(managingLine({ tokens: 120_000, wakes: 3, decisions: 4 })).toBe("Managing it: 120k adj. tokens over 4 decisions");
    expect(managingLine({ tokens: 5_000, wakes: 1, decisions: 1 })).toMatch(/over 1 decision$/);
    expect(managingLine({ tokens: 0, wakes: 0, decisions: 0 })).toBeNull();
    expect(managingLine(undefined)).toBeNull();
    expect(renderToStaticMarkup(<ManagingLine m={undefined} />)).toBe("");
  });

  it("sits right under the spend line and leaves the spend against the ceiling as it was", () => {
    const g = { ...grants.find((x) => x.status === "funded")!, status: "checkpoint" as const, grantTokens: 300_000, spentTokens: 150_000 };
    store.state = { ...store.state, me: { isAdmin: true, roles: [], user: { id: "us_m" } } as never, agents: { ag_m: { id: "ag_m", name: "Moss", kind: "resident", status: "idle", homeBuildingId: g.buildingId, buildingId: g.buildingId, forkOf: null } } as never, buildings: [{ id: g.buildingId, name: "B", managerAgentId: "ag_m" }] as never };
    const h = renderToStaticMarkup(<GrantRow grant={g} onPage onDecided={() => undefined} onOpenDoc={() => undefined} below={<ManagingLine m={{ tokens: 40_000, wakes: 2, decisions: 3 }} />} />);
    const spend = h.indexOf("150k of 300k adj. tokens spent (50%)");
    const managing = h.indexOf("Managing it: 40k adj. tokens over 3 decisions");
    expect(spend).toBeGreaterThan(0);
    expect(managing).toBeGreaterThan(spend);
  });

  it("the mock serves managing beside a grant that spent", async () => {
    const api = new MockApi();
    const spent = grants.find((x) => x.spentTokens > 0)!;
    const g = await api.grant(spent.id);
    expect(g.managing?.tokens).toBeGreaterThan(0);
    expect(g.spentTokens).toBe(spent.spentTokens);
  });
});
