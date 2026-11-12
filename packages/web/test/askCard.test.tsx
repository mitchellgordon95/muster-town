// @vitest-environment happy-dom
/**
 * Legible delegation UI / UX B-E (docs/legible-delegation.md §11): the ask card renders every type with its buttons and
 * wires each branch to the real action (a held grant's Adjust to POST /api/grants/:id/decide with the new ceiling), the
 * funding view's live line follows the toggles, the step strip, the feed's filter, the planning desk's step-size table
 * save, and the review deck's ask slide.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { GrantView, ReviewSlide } from "@muster-town/schema";
import { api, getApi } from "../src/api";
import { asks, buildings, grants, notices, stepCalibration } from "../src/mock/fixture";
import { MockApi } from "../src/mock/server";
import { store } from "../src/state";
import { AskCard } from "../src/panels/AskCard";
import { askedIds, mineAsks } from "../src/panels/queueOrder";
import { branchCall, claimMark, deltaOf, expectedSpend, openAskCount, retainerCounter, slateAsks, slateLine, sortAsks } from "../src/panels/asks";
import { FundingView } from "../src/panels/FundingView";
import { GrantPanel } from "../src/panels/GrantPanel";
import { NoticesFeed, pictureSrc } from "../src/panels/NoticesPanel";
import { PricingTab } from "../src/panels/PricingTab";
import { SlideDecision } from "../src/panels/ReviewDeck";
import { StepStrip } from "../src/panels/StepStrip";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const ask = (id: string) => asks.find((a) => a.id === id)!;
const grant = (id: string) => grants.find((g) => g.id === id)!;
const signIn = (isAdmin = true) => { store.state = { ...store.state, buildings: buildings as never, me: { isAdmin, roles: [], user: { id: "us_mitchell", name: "Mitchell" } } as never }; };

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
const button = (el: HTMLElement, text: string) => [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
// the mock server answers after a short wait (60-150 ms)
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 200)); });

// the client in tests is the HTTP one: each test routes the calls it makes to the mock server (the same Api)
const mock = new MockApi();
beforeAll(async () => { await getApi(); });

describe("the ask card", () => {
  it("renders each type with its branches as the buttons", () => {
    signIn();
    const html = (id: string, g?: GrantView) => renderToStaticMarkup(<AskCard ask={ask(id)} grant={g} onDecided={() => undefined} onOpenRecord={() => undefined} />);
    const held = html("ak_hud", grant("gr_hud"));
    expect(held).toContain("Adjust…");
    expect(held).toContain(">Cut<");
    expect(held).not.toContain("Continue");
    const proposal = html("ak_ocean", grant("gr_ocean"));
    for (const b of [">Fund<", "Counter…", ">Reject<"]) expect(proposal).toContain(b);
    expect(html("ak_weekly")).toContain(">Approve<");
    expect(html("ak_captain")).toContain(">Accept<");
    expect(html("ak_access")).toContain(">Let in<");
    expect(html("ak_req")).toContain(">Done…<");
    const policy = html("ak_policy");
    expect(policy).toContain(">Add<");
    expect(policy).toContain(">Skip<");
    expect(html("ak_meet")).toContain("Deferred until the HUD grant is decided");
  });

  it("shows the delta line, the recommendation, the claims with their check, the lint badge, and names not ids", () => {
    signIn();
    const held = renderToStaticMarkup(<AskCard ask={ask("ak_hud")} grant={grant("gr_hud")} onDecided={() => undefined} onOpenRecord={() => undefined} />);
    expect(held).toContain("<b>Workshop</b>");
    expect(held).toContain("You funded this at 2M");
    expect(held).toContain("Keel recommends adjust");
    expect(held).toContain("✓");
    expect(held).toContain("check by hand");
    expect(held).toContain("Asked in 2 places");
    expect(held).toContain("The full record →");
    expect(held).not.toContain(">gr_hud<");
    expect(renderToStaticMarkup(<AskCard ask={ask("ak_ocean")} onDecided={() => undefined} />)).toContain("✗");
    // 1:1 mt_ewxnhs90cq decision 5: style rules are warnings in the history, never a pill on the card
    expect(renderToStaticMarkup(<AskCard ask={ask("ak_land")} onDecided={() => undefined} />)).not.toContain("lint-failed");
  });

  it("maps each branch to its API call by target", () => {
    expect(branchCall({ targetKind: "grant" }, { label: "Adjust" })).toEqual({ kind: "grant", action: "adjust", form: "tokens" });
    expect(branchCall({ targetKind: "grant" }, { label: "Continue" })).toEqual({ kind: "none" });
    expect(branchCall({ targetKind: "grant" }, { label: "Counter" })).toEqual({ kind: "grant", action: "counter", form: "counter" });
    expect(branchCall({ targetKind: "retainer" }, { label: "Approve" })).toEqual({ kind: "retainer", action: "approve" });
    expect(branchCall({ targetKind: "retainer" }, { label: "Counter" })).toEqual({ kind: "retainer", action: "counter", form: "retainer" });
    expect(branchCall({ targetKind: "captain" }, { label: "Accept" })).toEqual({ kind: "captain", action: "accept" });
    expect(branchCall({ targetKind: "access" }, { label: "Let in", action: "grant" })).toEqual({ kind: "access", grant: true });
    expect(branchCall({ targetKind: "request" }, { label: "Decline" })).toEqual({ kind: "request", action: "decline", form: "note" });
    expect(branchCall({ targetKind: "rule" }, { label: "Add" })).toEqual({ kind: "ask", decision: "Add" });
    expect(branchCall({ targetKind: null }, { label: "Bar" })).toEqual({ kind: "ask", decision: "Bar" });
    // a money ask on a grant never records a bare label: Yes / No act on the grant by its status, else nothing is drawn
    const money = { targetKind: "grant" as const, type: "money" as const };
    expect(branchCall(money, { label: "Yes" })).toEqual({ kind: "none" });
    expect(branchCall(money, { label: "Yes" }, { status: "funded" })).toEqual({ kind: "grant", action: "adjust", form: "tokens" });
    expect(branchCall(money, { label: "No" }, { status: "checkpoint" })).toEqual({ kind: "grant", action: "cut" });
    expect(branchCall(money, { label: "Yes" }, { status: "proposed" })).toEqual({ kind: "grant", action: "fund" });
    expect(branchCall(money, { label: "No" }, { status: "proposed" })).toEqual({ kind: "grant", action: "reject" });
    expect(branchCall(money, { label: "Maybe" }, { status: "funded" })).toEqual({ kind: "none" });
    expect(branchCall(money, { label: "Cut" })).toEqual({ kind: "grant", action: "cut" });
  });

  it("a held grant's Adjust asks for the new ceiling and sends it to decideGrant", async () => {
    signIn();
    const decide = vi.spyOn(api(), "decideGrant").mockResolvedValue(grant("gr_hud"));
    const onDecided = vi.fn();
    const el = await mount(<AskCard ask={ask("ak_hud")} grant={grant("gr_hud")} onDecided={onDecided} />);
    await act(async () => button(el, "Adjust…").click());
    const field = el.querySelector("input[aria-label='New ceiling']") as HTMLInputElement;
    // prefilled at the ceiling plus the forecast's shortfall
    expect(field.value).toBe("2.19");
    await act(async () => typeInto(field, "2.25"));
    await act(async () => button(el, "Adjust").click());
    await flush();
    expect(decide).toHaveBeenCalledWith("gr_hud", expect.objectContaining({ action: "adjust", tokens: 2_250_000 }));
    expect(onDecided).toHaveBeenCalled();
  });

  it("a policy branch records the label through POST /api/asks/:id/decide", async () => {
    signIn();
    const decide = vi.spyOn(api(), "decideAsk").mockResolvedValue(ask("ak_policy"));
    const el = await mount(<AskCard ask={ask("ak_policy")} onDecided={() => undefined} />);
    await act(async () => button(el, "Add").click());
    await flush();
    expect(decide).toHaveBeenCalledWith("ak_policy", "Add", "");
  });

  it("a click ask's Add a note sends the human's words with the branch", async () => {
    signIn();
    const decide = vi.spyOn(api(), "decideAsk").mockResolvedValue(ask("ak_policy"));
    const el = await mount(<AskCard ask={ask("ak_policy")} onDecided={() => undefined} />);
    expect(el.querySelector("textarea[aria-label='Note']")).toBeNull();
    await act(async () => button(el, "Add a note").click());
    const field = el.querySelector("textarea[aria-label='Note']") as HTMLTextAreaElement;
    await act(async () => typeInto(field, "I edited the token instead."));
    await act(async () => button(el, "Add").click());
    await flush();
    expect(decide).toHaveBeenCalledWith("ak_policy", "Add", "I edited the token instead.");
  });

  it("a request (a do ask) has no Claim: Done waits for the report back and sends it; Decline waits for a note", async () => {
    signIn();
    const req = vi.spyOn(api(), "request").mockResolvedValue(null);
    const el = await mount(<AskCard ask={ask("ak_req")} onDecided={() => undefined} />);
    // Decline opens its note and stays disabled until the human says why (the server refuses a bare decline)
    await act(async () => button(el, "Decline…").click());
    const declineAct = () => [...el.querySelectorAll(".ask-form button")].find((b) => b.textContent?.trim() === "Decline") as HTMLButtonElement;
    expect(declineAct().disabled).toBe(true);
    await act(async () => typeInto(el.querySelector("input[aria-label='Note']") as HTMLInputElement, "no monitor here"));
    expect(declineAct().disabled).toBe(false);
    // Done's note is the report back: required, and it goes with the press
    expect(el.textContent).not.toContain("Claim");
    await act(async () => button(el, "Done…").click());
    const doneAct = () => [...el.querySelectorAll(".ask-form button")].find((b) => b.textContent?.trim() === "Done") as HTMLButtonElement;
    const field = el.querySelector("input[aria-label='Note']") as HTMLInputElement;
    await act(async () => typeInto(field, ""));
    expect(doneAct().disabled).toBe(true);
    await act(async () => typeInto(field, "Signed up; the monitor is live."));
    await act(async () => doneAct().click());
    await flush();
    expect(req).toHaveBeenCalledWith("dc_req_ml", "done", "Signed up; the monitor is live.");
  });

  it("a retainer's Counter takes tokens per run, an end date and a note, like a grant's counter", async () => {
    signIn();
    const decide = vi.spyOn(api(), "decideRetainer").mockResolvedValue(null as never);
    const el = await mount(<AskCard ask={ask("ak_weekly")} retainer={{ tokensPerRun: 40_000, endsAt: "2026-12-01T00:00:00.000Z" }} onDecided={() => undefined} />);
    await act(async () => button(el, "Counter…").click());
    const perRun = el.querySelector("input[aria-label='Tokens per run']") as HTMLInputElement;
    const counterAct = () => [...el.querySelectorAll(".ask-form button")].find((b) => b.textContent?.trim() === "Counter") as HTMLButtonElement;
    // starts at the asked amount: nothing changed yet, so Counter waits (the server refuses an empty counter)
    expect(perRun.value).toBe("0.04");
    expect(counterAct().disabled).toBe(true);
    await act(async () => typeInto(perRun, "0.025"));
    await act(async () => typeInto(el.querySelector("input[aria-label='End date']") as HTMLInputElement, "2026-11-20"));
    await act(async () => typeInto(el.querySelector("input[aria-label='Note']") as HTMLInputElement, "half the runs"));
    expect(counterAct().disabled).toBe(false);
    await act(async () => counterAct().click());
    await flush();
    expect(decide).toHaveBeenCalledWith("sc_weekly", expect.objectContaining({ action: "counter", note: "half the runs", tokensPerRun: 25_000, until: "2026-11-20T23:59:59.000Z" }));
  });

  it("a retainer counter's body: only what changes", () => {
    expect(retainerCounter("0.04", "", "", 40_000)).toBeNull();
    expect(retainerCounter("0.04", "", "why", 40_000)).toEqual({});
    expect(retainerCounter("0.05", "", "", 40_000)).toEqual({ tokensPerRun: 50_000 });
    expect(retainerCounter("", "2026-12-24", "", 40_000)).toEqual({ until: "2026-12-24T23:59:59.000Z" });
    expect(retainerCounter("abc", "", "", 40_000)).toBeNull();
  });

  it("the ask order, records and helpers", () => {
    expect(sortAsks(asks).map((a) => a.id)).toEqual(["ak_hud", "ak_ocean", "ak_land", "ak_weekly", "ak_captain", "ak_req", "ak_policy", "ak_access", "ak_meet"]);
    expect(openAskCount(asks)).toBe(9); // a deferred ask still counts: it waits on a human
    const ids = askedIds(asks);
    expect(ids.has("gr_hud") && ids.has("dc_keel_cp") && ids.has("cr_octo")).toBe(true);
    expect(mineAsks(asks, { gr_hud: { mine: false } as never }, true).some((a) => a.id === "ak_hud")).toBe(false);
    expect(deltaOf("First line.\n\nThe rest.")).toEqual({ delta: "First line.", rest: "The rest." });
    expect(claimMark({ text: "x", check: { kind: "pr" } }).line).toBe("pending");
    expect(claimMark({ text: "x", check: { kind: "pr" }, result: { ok: true, at: new Date(Date.now() - 4 * 60_000).toISOString() } }).line).toBe("checked 4 min ago");
  });
});

describe("the step strip", () => {
  it("draws one box per step by size, done steps filled, and goes red past the ceiling", () => {
    const html = renderToStaticMarkup(<StepStrip grant={grant("gr_hud")} />);
    expect(html.match(/class="step-box/g)).toHaveLength(3);
    expect(html).toContain("step-box size-L done");
    expect(html).toContain("step-box size-S left");
    expect(html).toContain("2 of 3 done");
    expect(html).toContain("projected");
    expect(html).toContain("step-strip over");
    expect(html).toContain("190k past the ceiling");
    expect(renderToStaticMarkup(<StepStrip grant={{ ...grant("gr_hud"), steps: [] }} />)).toBe("");
  });
});

describe("the funding view", () => {
  it("lists the money asks on proposals and works out expected spend from sizes × calibration", () => {
    const items = slateAsks(asks, grants);
    expect(items.map((x) => x.grant.id)).toEqual(["gr_ocean", "gr_land"]);
    const sizes = { S: 50_000, M: 150_000, L: 400_000 };
    // ocean: L, L, M at 1.6, 1.6, 1.1
    expect(expectedSpend(grant("gr_ocean"), sizes, stepCalibration)).toBe(Math.round(400_000 * 1.6 * 2 + 150_000 * 1.1));
    const line = slateLine({ freeTokens: 10_000_000, openAsksTokens: 5_500_000 }, items, new Set(["gr_ocean"]), sizes, stepCalibration);
    expect(line).toMatchObject({ before: 15_500_000, toggled: 4_000_000, after: 11_500_000, count: 1 });
  });

  it("the live line follows the fund / hold toggle, and the toggle funds nothing", async () => {
    signIn();
    vi.spyOn(api(), "bank").mockResolvedValue({ free: { freeTokens: 10_000_000, openAsksTokens: 5_500_000 } } as never);
    vi.spyOn(api(), "health").mockImplementation(() => mock.health());
    const decide = vi.spyOn(api(), "decideGrant");
    const el = await mount(<FundingView asks={asks} grants={grants} notices={notices} onDecided={() => undefined} />);
    await flush();
    const line = () => el.querySelector(".funding-line")!.textContent ?? "";
    expect(el.textContent).toContain("The money slate");
    expect(line()).toContain("toggled 5.5M");
    expect(line()).toContain("left 10M");
    const toggles = el.querySelectorAll<HTMLInputElement>(".funding-toggle input");
    expect(toggles).toHaveLength(2);
    await act(async () => toggles[0]!.click());
    expect(line()).toContain("toggled 1.5M");
    expect(line()).toContain("left 14M");
    expect(el.querySelector(".funding-toggle")!.textContent).toContain("hold");
    expect(decide).not.toHaveBeenCalled();
  });
});

describe("the feed", () => {
  it("filters by kind through GET /api/notices, pictures inline", async () => {
    const spy = vi.spyOn(api(), "notices").mockImplementation((q) => mock.notices(q));
    const el = await mount(<NoticesFeed />);
    await flush();
    expect(el.querySelectorAll(".notice")).toHaveLength(notices.length);
    expect(el.querySelector(".notice-picture")).not.toBeNull();
    const kind = el.querySelector("select[aria-label='Kind']") as HTMLSelectElement;
    await act(async () => { kind.value = "closed-loop"; kind.dispatchEvent(new Event("change", { bubbles: true })); });
    await flush();
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "closed-loop" }));
    expect(el.querySelectorAll(".notice")).toHaveLength(1);
    expect(el.textContent).toContain("You funded this at 1M");
  });
  it("a media id is served from /api/media", () => {
    expect(pictureSrc("mf_abcdefghij")).toMatch(/\/api\/media\/mf_abcdefghij$/);
    expect(pictureSrc("/x.png")).toBe("/x.png");
    expect(pictureSrc(null)).toBeNull();
  });
});

describe("the planning desk's step sizes", () => {
  it("an admin edits the table and oversell and saves them through PUT /api/town/defaults", async () => {
    signIn(true);
    store.state = { ...store.state, town: { ...(store.state.town ?? {}), name: "T", goal: "", stepSizes: { S: 50_000, M: 150_000, L: 400_000 }, oversell: 0.5 } as never };
    const pricing = vi.spyOn(api(), "pricing").mockImplementation(() => mock.pricing());
    const save = vi.spyOn(api(), "setGrantPricing").mockImplementation((p) => mock.setGrantPricing(p));
    const el = await mount(<PricingTab />);
    await flush();
    // the calibration comes from the admin-only GET /api/town/pricing
    expect(pricing).toHaveBeenCalled();
    expect(el.textContent).toContain("L: 1.6× over 12 steps");
    expect(el.textContent).toContain("policy asks");
    await act(async () => typeInto(el.querySelector("input[aria-label='S size']") as HTMLInputElement, "60"));
    await act(async () => typeInto(el.querySelector("input[aria-label='Oversell']") as HTMLInputElement, "25"));
    await act(async () => button(el, "Save").click());
    await flush();
    expect(save).toHaveBeenCalledWith({ stepSizes: { S: 60_000, M: 150_000, L: 400_000 }, oversell: 0.25 });
  });
  it("a non-admin reads the table, no Save", async () => {
    signIn(false);
    const pricing = vi.spyOn(api(), "pricing").mockImplementation(() => mock.pricing());
    const el = await mount(<PricingTab />);
    await flush();
    expect(button(el, "Save")).toBeUndefined();
    expect((el.querySelector("input[aria-label='M size']") as HTMLInputElement).disabled).toBe(true);
    // a non-admin never calls the admin-only pricing route: the table shows without the calibration lines
    expect(pricing).not.toHaveBeenCalled();
    expect(el.textContent).not.toContain("1.6×");
  });
});

describe("the review deck's ask slides", () => {
  const base = { notes: "", pictures: [], since: null, waiters: 0, history: "", buildingId: null, group: 5, title: "t", text: "t" };
  it("an ask slide carries the ask's branches as buttons; the slate slide decides nothing", () => {
    signIn();
    const slide: ReviewSlide = { ...base, key: "ask:ak_policy", kind: "ask", itemId: "ak_policy", askId: "ak_policy" };
    const html = renderToStaticMarkup(<SlideDecision slide={slide} n={3} grants={[]} reports={[]} asks={asks} onDecided={() => undefined} onOpenDoc={() => undefined} />);
    expect(html).toContain(">Add<");
    expect(html).toContain(">Skip<");
    const slate: ReviewSlide = { ...base, key: "slate:nt_slate", kind: "slate", itemId: null, group: 0 };
    expect(renderToStaticMarkup(<SlideDecision slide={slate} n={1} grants={[]} reports={[]} asks={asks} onDecided={() => undefined} onOpenDoc={() => undefined} />)).toContain("The slate funds nothing");
  });
  it("the mock deck: the slate first, then the town, then the asks in rank order", async () => {
    const deck = await mock.reviewDeck();
    expect(deck.slides[0]!.kind).toBe("slate");
    expect(deck.slides[1]!.kind).toBe("town");
    expect(deck.slides[2]!.askId).toBe("ak_hud");
    expect(deck.slides.some((s) => s.kind === "ask" && s.askId === "ak_policy")).toBe(true);
  });
});

describe("a grant is named by its title (migration 105)", () => {
  it("the ask card's step strip and the funding toggle name the grant by its title, never its objective", () => {
    signIn();
    const g = grant("gr_ocean");
    expect(g.title).toBe("Southern Ocean sink gap");
    const card = renderToStaticMarkup(<AskCard ask={ask("ak_ocean")} grant={g} onDecided={() => undefined} />);
    expect(card).toContain('aria-label="Steps of Southern Ocean sink gap"');
    expect(card).not.toContain(g.objective);
    const funding = renderToStaticMarkup(<FundingView asks={asks} grants={grants} onDecided={() => undefined} />);
    expect(funding).toContain('aria-label="Fund Southern Ocean sink gap"');
  });

  it("the grant page's header is the title, with the objective beneath it", async () => {
    signIn();
    // every call the page makes goes to the mock server
    const client = api() as unknown as Record<string, (...a: unknown[]) => unknown>, server = mock as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(mock))) if (k !== "constructor" && typeof client[k] === "function") vi.spyOn(client, k).mockImplementation((...a: unknown[]) => server[k]!(...a));
    const el = await mount(<GrantPanel id="gr_ocean" />);
    await flush();
    const g = grant("gr_ocean");
    expect(el.textContent).toContain("Southern Ocean sink gap");
    expect(el.querySelector(".grant-objective")?.textContent).toBe(g.objective);
  });
});
