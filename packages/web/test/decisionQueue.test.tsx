// @vitest-environment happy-dom
/**
 * The decision queue at the Town Hall hydrant (2026-11-09; docs/legible-delegation.md §3): the Town Hall has no in-tray;
 * the queue shows one item at a time, the front by rank; deciding it pops the next; items no ask is about join the end;
 * "Look at the queue" lists one line per item; the Secretary's 1:1 opens beside it for a human allowed to talk at the
 * Town Hall (once, reused), never for a guest; the links that opened the Town Hall in-tray open the queue.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { AccessRequestView, Agent, GrantView, Meeting } from "@muster-town/schema";
import { api, getApi, type AskView, type Intray } from "../src/api";
import { asks, buildings, grants, notices } from "../src/mock/fixture";
import { MockApi } from "../src/mock/server";
import { store } from "../src/state";
import { DecisionQueueView, FOCUS_DEBOUNCE_MS, goToQueue, useSecretaryChat } from "../src/panels/DecisionQueue";
import { askedIds, currentItem, focusOf, mineAsks, queueItems, stepFrom } from "../src/panels/queueOrder";
import { GrantPanel } from "../src/panels/GrantPanel";
import { redirectPanel } from "../src/panels/room";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ask = (id: string) => asks.find((a) => a.id === id)!;
const SEC = { id: "ag_sec", name: "Secretary", title: "Secretary", kind: "resident", status: "idle", homeBuildingId: "bl_townhall", buildingId: "bl_townhall", forkOf: null } as unknown as Agent;
const signIn = (isAdmin = true) => { store.state = { ...store.state, panel: null, buildings: buildings as never, agents: { ag_sec: SEC }, meetings: {}, me: { isAdmin, roles: [], user: { id: "us_mitchell", name: "Mitchell" } } as never }; };
const guest = () => { store.state = { ...store.state, panel: null, buildings: buildings as never, agents: { ag_sec: SEC }, meetings: {}, me: null }; };
const join = (id: string, createdAt: string): AccessRequestView => ({ id, name: "Ada", githubLogin: "ada", avatarUrl: null, message: "let me help", createdAt, status: "pending" }) as unknown as AccessRequestView;
const read = (x: Partial<Intray>): Intray => ({ reports: [], grants: [], ...x });

let roots: Root[] = [];
async function mount(el: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(el); });
  return root;
}
afterEach(async () => { for (const r of roots) await act(async () => r.unmount()); roots = []; document.body.innerHTML = ""; vi.restoreAllMocks(); });
const buttons = () => [...document.body.querySelectorAll("button")];
const button = (text: string) => buttons().find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const cards = () => [...document.body.querySelectorAll(".ask-card")].map((c) => c.getAttribute("aria-label"));
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

const mock = new MockApi();
beforeAll(async () => { await getApi(); });

describe("the queue's order (queueOrder.ts)", () => {
  it("live asks by rank, then oldest, deferred last; then items no ask is about, oldest first; an ask's own items are its record", () => {
    const decided = { ...ask("ak_ocean"), id: "ak_done", status: "decided" } as AskView;
    const items = queueItems({
      asks: [...asks, decided], reports: [], blocked: [], goalProposals: [], captains: [],
      grants: grants.filter((g) => g.id === "gr_ocean" || g.status === "countered"),
      retainers: [{ id: "sc_a", retainer: "funded" }, { id: "sc_b", retainer: "asked", updatedAt: "2026-11-01T00:00:00Z" }] as never,
      access: [join("ar_new", "2026-11-02T00:00:00Z"), join("ar_octo", "2026-11-01T00:00:00Z")],
    });
    expect(items.map((x) => x.id)).toEqual(["ak_hud", "ak_ocean", "ak_land", "ak_weekly", "ak_captain", "ak_req", "ak_policy", "ak_access", "ak_meet", "sc_b", "ar_new"]);
    expect(askedIds(asks).has("ar_octo")).toBe(true);
    expect(currentItem(items, null)?.id).toBe("ak_hud");
    expect(currentItem(items, "ar_new")?.id).toBe("ar_new");
    expect(currentItem(items, "gone")?.id).toBe("ak_hud");
    expect(currentItem([], null)).toBeNull();
    expect(stepFrom(items, "ak_hud", 1)).toBe("ak_ocean");
    expect(stepFrom(items, "ak_hud", -1)).toBe("ak_hud");
    expect(stepFrom(items, "ar_new", 1)).toBe("ar_new");
    expect(mineAsks(asks, { gr_hud: { mine: false } as never }, true).some((a) => a.id === "ak_hud")).toBe(false);
  });
});

describe("the decision queue sheet", () => {
  it("shows exactly one item, the front by rank, with its buttons and N waiting", async () => {
    signIn();
    await mount(<DecisionQueueView data={read({ asks, grants, notices })} onReload={() => undefined} onClose={() => undefined} />);
    expect(cards()).toEqual([ask("ak_hud").title]);
    expect(document.body.querySelector(".sheet")?.getAttribute("aria-label")).toBe("Decision queue");
    expect(document.body.querySelector(".who-sub")?.textContent).toBe("9 waiting");
    expect(document.body.textContent).toContain("Front of the queue");
    expect(button("Adjust…")).toBeTruthy();
    // light links, not buttons-as-buttons: the list, the funding slate, what shipped
    for (const t of ["Look at the queue (9)", "What shipped"]) expect(button(t)?.className).toContain("link");
    expect(buttons().find((b) => b.textContent?.startsWith("Funding"))?.className).toContain("link");
    expect(document.body.textContent).not.toContain("Review as deck");
  });

  it("deciding the front pops the next one in; an item with no ask comes after the asks", async () => {
    signIn();
    const decide = vi.spyOn(api(), "decideAsk").mockResolvedValue({} as AskView);
    const reload = vi.fn();
    const first = { ...ask("ak_policy"), rank: 1 }, second = { ...ask("ak_ocean"), rank: 2 };
    await mount(<DecisionQueueView data={read({ asks: [second, first], grants: grants.filter((g) => g.id === "gr_ocean"), access: [join("ar_new", "2026-11-02T00:00:00Z")] })} onReload={reload} onClose={() => undefined} />);
    expect(cards()).toEqual([first.title]);
    await act(async () => button("Add").click());
    expect(decide).toHaveBeenCalledWith("ak_policy", "Add", "");
    expect(reload).toHaveBeenCalled();
    expect(cards()).toEqual([second.title]);
    expect(document.body.querySelector(".who-sub")?.textContent).toBe("2 waiting");
    // the ask that is left is decided too (K / J only peek): the join ask with no ask on it is next, with its own row
    vi.spyOn(api(), "decideGrant").mockResolvedValue({} as GrantView);
    await act(async () => button("Reject").click());
    expect(cards()).toEqual([]);
    expect(document.body.querySelector(".queue-item")?.textContent).toContain("asks to join");
    expect(button("Let in")).toBeTruthy();
  });

  it("J and K peek at the next and previous item without deciding", async () => {
    signIn();
    await mount(<DecisionQueueView data={read({ asks, grants })} onReload={() => undefined} onClose={() => undefined} />);
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "j" })); });
    expect(cards()).toEqual([ask("ak_ocean").title]);
    expect(document.body.textContent).toContain("2 of 9");
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "k" })); });
    expect(cards()).toEqual([ask("ak_hud").title]);
  });

  it("Look at the queue lists one line per item; a line becomes the current item; ← One at a time goes back", async () => {
    signIn();
    await mount(<DecisionQueueView data={read({ asks, grants, access: [join("ar_new", "2026-11-02T00:00:00Z")] })} onReload={() => undefined} onClose={() => undefined} />);
    await act(async () => button("Look at the queue (10)").click());
    const lines = [...document.body.querySelectorAll(".intray-line")];
    expect(lines).toHaveLength(10);
    expect(cards()).toEqual([]);
    expect(lines[0]!.textContent).toContain(ask("ak_hud").title);
    expect(lines[0]!.textContent).toContain("money");
    expect(lines[9]!.textContent).toContain("@ada asks to join");
    await act(async () => (lines[2] as HTMLButtonElement).click());
    expect(cards()).toEqual([ask("ak_land").title]);
    await act(async () => button("Look at the queue (10)").click());
    await act(async () => button("← One at a time").click());
    expect(cards()).toEqual([ask("ak_land").title]);
  });

  it("an empty queue says so, with the closed loops", async () => {
    signIn();
    await mount(<DecisionQueueView data={read({ asks: [], notices })} onReload={() => undefined} onClose={() => undefined} />);
    expect(document.body.textContent).toContain("Nothing waiting. The firehose is quiet.");
    expect(document.body.textContent).toContain("Your decisions paying off");
  });

  it("the head: Rank now for who may run it, the Mine / All select, Funded by me only for a funder", async () => {
    signIn();
    const run = { scheduleId: "sc_d", runningId: null, refused: null };
    const routes = { gr_hud: { mine: false } as never };
    await mount(<DecisionQueueView data={read({ asks, grants, routes, defaultView: "mine", digestRun: run })} onReload={() => undefined} onClose={() => undefined} />);
    expect(button("Rank now")).toBeTruthy();
    const select = document.body.querySelector("select[aria-label='Show']") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["mine", "all"]);
    expect(document.body.textContent).toContain("1 more under All");
    expect(cards()).toEqual([ask("ak_ocean").title]);
    for (const r of roots) await act(async () => r.unmount());
    roots = [];
    await mount(<DecisionQueueView data={read({ asks, grants, digestRun: { ...run, runningId: "as_r", refused: "a ranking run is under way" } })} funder={{ streams: [{}], goalIds: [], everything: true } as never} onReload={() => undefined} onClose={() => undefined} />);
    expect(button("Ranking…").disabled).toBe(true);
    expect([...(document.body.querySelector("select[aria-label='Show']") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["mine", "all", "funded"]);
  });

  it("a guest sees the queue with no buttons that decide", async () => {
    guest();
    await mount(<DecisionQueueView data={read({ asks, grants })} onReload={() => undefined} onClose={() => undefined} />);
    expect(cards()).toHaveLength(1);
    expect(document.body.textContent).toContain("Sign in to decide.");
    expect(document.body.querySelector("select[aria-label='Show']")).toBeNull();
  });
});

describe("the Secretary's 1:1 beside the queue", () => {
  const meeting = { id: "mt_sec", kind: "one-on-one", facilitatorId: "ag_sec", phase: "discussing", buildingId: "bl_townhall" } as unknown as Meeting;
  function Chat() { useSecretaryChat("bl_townhall"); return null; }

  it("opens in the side panel for an allowed human, and opening the queue again reuses it", async () => {
    signIn();
    const open = vi.spyOn(api(), "openOneOnOne").mockResolvedValue(meeting);
    await mount(<Chat />);
    await flush();
    expect(open).toHaveBeenCalledWith("bl_townhall", { agentId: "ag_sec" });
    expect(store.state.panel).toEqual({ kind: "meeting", id: "mt_sec" });
    for (const r of roots) await act(async () => r.unmount());
    roots = [];
    await mount(<Chat />);
    await flush();
    expect(open).toHaveBeenCalledTimes(1);
    expect(store.state.panel).toEqual({ kind: "meeting", id: "mt_sec" });
  });

  it("gives the queue the live 1:1's id to tell what is open; none for a guest, and none once the 1:1 ended", async () => {
    let got: string | null | undefined;
    function Id() { got = useSecretaryChat("bl_townhall"); return null; }
    guest();
    await mount(<Id />);
    await flush();
    expect(got).toBeNull();
    signIn();
    vi.spyOn(api(), "openOneOnOne").mockResolvedValue(meeting);
    await mount(<Id />);
    await flush();
    expect(got).toBe("mt_sec");
    await act(async () => store.putMeeting({ ...meeting, phase: "done" }));
    expect(got).toBeNull();
  });

  it("not for a guest, a human without the permission, or with no live Secretary", async () => {
    const open = vi.spyOn(api(), "openOneOnOne").mockResolvedValue(meeting);
    guest();
    await mount(<Chat />);
    signIn(false);
    await mount(<Chat />);
    signIn();
    store.state = { ...store.state, agents: {} };
    await mount(<Chat />);
    await flush();
    expect(open).not.toHaveBeenCalled();
    expect(store.state.panel).toBeNull();
  });
});

describe("the Secretary knows what is open (the 1:1's focus)", () => {
  const settle = () => act(async () => { await new Promise((r) => setTimeout(r, FOCUS_DEBOUNCE_MS + 60)); });
  const key = (j: number) => act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: j > 0 ? "j" : "k" })); });

  it("PUTs the item on screen on open, after J / K (debounced: one PUT for a quick J J) and for a picked line; clears it when the queue closes", async () => {
    signIn();
    const put = vi.spyOn(api(), "meetingFocus").mockResolvedValue({} as Meeting);
    const root = await mount(<DecisionQueueView data={read({ asks, grants })} onReload={() => undefined} onClose={() => undefined} chatId="mt_sec" />);
    expect(put).not.toHaveBeenCalled();
    await settle();
    expect(put.mock.calls).toEqual([["mt_sec", { kind: "ask", id: "ak_hud" }]]);
    await key(1);
    await key(1);
    await settle();
    expect(put.mock.calls.slice(1)).toEqual([["mt_sec", { kind: "ask", id: "ak_land" }]]);
    await act(async () => button("Look at the queue (9)").click());
    await act(async () => ([...document.body.querySelectorAll(".intray-line")][1] as HTMLButtonElement).click());
    await settle();
    expect(put.mock.calls.slice(2)).toEqual([["mt_sec", { kind: "ask", id: "ak_ocean" }]]);
    // J then K back to the same item before the debounce: nothing new is sent
    await key(1);
    await key(-1);
    await settle();
    expect(put).toHaveBeenCalledTimes(3);
    await act(async () => root.unmount());
    roots = roots.filter((r) => r !== root);
    expect(put.mock.calls.at(-1)).toEqual(["mt_sec", null]);
    expect(put).toHaveBeenCalledTimes(4);
  });

  it("nothing is sent without a 1:1 (a guest, no permission, no Secretary)", async () => {
    guest();
    const put = vi.spyOn(api(), "meetingFocus").mockResolvedValue({} as Meeting);
    await mount(<DecisionQueueView data={read({ asks, grants })} onReload={() => undefined} onClose={() => undefined} />);
    await settle();
    await key(1);
    await settle();
    for (const r of roots) await act(async () => r.unmount());
    roots = [];
    expect(put).not.toHaveBeenCalled();
  });

  it("the queue's kinds in the town's words: a report is a doc, a goal proposal a goalProposal", () => {
    expect(focusOf(null)).toBeNull();
    expect(focusOf({ kind: "report", id: "dc_r", doc: {} as never })).toEqual({ kind: "doc", id: "dc_r" });
    expect(focusOf({ kind: "goal", id: "gp_1", proposal: {} as never })).toEqual({ kind: "goalProposal", id: "gp_1" });
    expect(focusOf({ kind: "blocked", id: "blocked:bl_x", blocked: {} as never })).toEqual({ kind: "blocked", id: "blocked:bl_x" });
  });
});

describe("links to the Town Hall in-tray open the queue", () => {
  it("the old intray:<town hall> panel, the hud's go (walk to the hydrant, else open) and the grant page's button", async () => {
    signIn();
    expect(redirectPanel({ kind: "intray", id: "bl_townhall" }, "bl_townhall")).toEqual({ kind: "queue" });
    expect(redirectPanel({ kind: "intray", id: "bl_workshop" }, "bl_townhall")).toEqual({ kind: "intray", id: "bl_workshop" });
    store.open({ kind: "intray", id: "bl_townhall" });
    expect(store.state.panel).toEqual({ kind: "queue" });
    store.open(null);
    const walked: unknown[] = [];
    store.walkTo = (placeId, panel) => { walked.push([placeId, panel]); return false; };
    goToQueue();
    expect(walked).toEqual([["hydrant:bl_townhall", { kind: "queue" }]]);
    expect(store.state.panel).toEqual({ kind: "queue" });
    store.walkTo = () => false;
    store.open(null);
    const client = api() as unknown as Record<string, (...a: unknown[]) => unknown>, server = mock as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(mock))) if (k !== "constructor" && typeof client[k] === "function") vi.spyOn(client, k).mockImplementation((...a: unknown[]) => server[k]!(...a));
    await mount(<GrantPanel id="gr_ocean" />);
    await flush();
    await act(async () => button("Decision queue").click());
    expect(store.state.panel?.kind).toBe("queue");
  });
});
