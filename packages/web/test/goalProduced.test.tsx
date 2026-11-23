// @vitest-environment happy-dom
/** The goal detail's "What it produced" block (gr_6kangldj4t step 2): the count line, the newest shipped items linking their grant, See all opens the feed filtered to the goal's subtree. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, getApi } from "../src/api";
import { MockApi } from "../src/mock/server";
import { store } from "../src/state";
import { producedLine, shippedLink } from "../src/panels/goalTree";
import { ProducedBlock } from "../src/panels/GoalTreePanel";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/panels/Markdown", async (orig) => ({ ...(await orig<object>()), Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, openDocLink: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLDivElement | null = null;
async function mount(el: React.ReactElement) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  return host;
}
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; vi.restoreAllMocks(); });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 250)); });
const mock = new MockApi();
beforeAll(async () => { await getApi(); });

const counts = { shipped: 3, grantsClosed: 2, keyResultsMet: 5, keyResultsUnverified: 1, keyResultsMissed: 0, tokens: 1_234_000 };

describe("What it produced (gr_6kangldj4t)", () => {
  it("the count line names shipped, grants closed, key results met (unverified apart), missed only when any, and tokens", () => {
    expect(producedLine({ days: 30, counts })).toBe("Last 30 days: 3 shipped, 2 grants closed, 5 key results met (1 unverified), 1.2M tokens");
    expect(producedLine({ days: 30, counts: { ...counts, grantsClosed: 1, keyResultsMet: 1, keyResultsUnverified: 0, keyResultsMissed: 2, tokens: 0 } }))
      .toBe("Last 30 days: 3 shipped, 1 grant closed, 1 key result met, 2 missed, 0 tokens");
  });

  it("a shipped item links its grant, else the report it cites, else nothing", () => {
    expect(shippedLink(["gr_a"])).toEqual({ kind: "grant", id: "gr_a" });
    expect(shippedLink(["dc_r", "gr_b"])).toEqual({ kind: "grant", id: "gr_b" });
    expect(shippedLink(["dc_r", "ms_x"])).toEqual({ kind: "doc", id: "dc_r" });
    expect(shippedLink([])).toBeNull();
  });

  it("the mock answers for the subtree: the root sees a child goal's shipped item, a sibling does not", async () => {
    const town = await mock.goalProduced("gl_town");
    expect(town.shipped.map((n) => n.id)).toContain("nt_ship_fund");
    expect((await mock.goalProduced("gl_fund")).shipped.map((n) => n.id)).toEqual(["nt_ship_fund"]);
    expect((await mock.goalProduced("gl_join")).counts.shipped).toBe(0);
    expect((await mock.notices({ goal: "gl_fund" })).map((n) => n.id)).toEqual(["nt_ship_fund"]);
    expect((await mock.notices({ goal: "gl_town" })).some((n) => n.goalId === null)).toBe(true);
  });

  it("renders the line and the items; a grant item opens the grant; See all opens the feed filtered to this goal", async () => {
    vi.spyOn(api(), "goalProduced").mockImplementation((id, days, limit) => mock.goalProduced(id, days, limit));
    const notices = vi.spyOn(api(), "notices").mockImplementation((q) => mock.notices(q));
    const open = vi.spyOn(store, "open").mockImplementation(() => undefined);
    const el = await mount(<ProducedBlock node={{ id: "gl_fund", text: "Fund" }} />);
    await flush();
    expect(el.querySelector(".goal-produced-line")?.textContent).toMatch(/^Last 30 days: 1 shipped, 0 grants closed, 0 key results met, \d+k tokens$/);
    const item = [...el.querySelectorAll(".goal-produced button")].find((b) => b.textContent === "Spend by goal shows managing cost") as HTMLButtonElement;
    await act(async () => { item.click(); });
    expect(open).toHaveBeenCalledWith({ kind: "grant", id: "gr_stress" });
    const all = [...el.querySelectorAll("button")].find((b) => b.textContent === "See all") as HTMLButtonElement;
    await act(async () => { all.click(); });
    await flush();
    expect(notices).toHaveBeenLastCalledWith(expect.objectContaining({ goal: "gl_fund" }));
    expect(document.body.querySelectorAll(".notice")).toHaveLength(1);
  });

  it("an empty window says so and offers no See all", async () => {
    vi.spyOn(api(), "goalProduced").mockImplementation((id, days, limit) => mock.goalProduced(id, days, limit));
    const el = await mount(<ProducedBlock node={{ id: "gl_join", text: "Join" }} />);
    await flush();
    expect(el.textContent).toContain("Nothing shipped under this goal in the last 30 days.");
    expect([...el.querySelectorAll("button")].some((b) => b.textContent === "See all")).toBe(false);
  });
});
