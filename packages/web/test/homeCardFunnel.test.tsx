// @vitest-environment happy-dom
/**
 * The homepage card's join-funnel pings (gr_ptle4vvujl, kr_9me8p8vsds): Next to page 2 and 3, Skip or close, and Open each
 * POST /api/join-funnel/home with this browser's visitor id and the step; the first page sends nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HomeCard } from "../src/home/HomeCard";

vi.mock("../src/panels/hiwScenes", () => ({ sceneUrl: () => "" }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const collectives = [{ name: "Workshop", url: "/workshop/" }] as Parameters<typeof HomeCard>[0]["collectives"];
let root: Root, el: HTMLDivElement, steps: (string | undefined)[], assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  steps = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe("/api/join-funnel/home");
    const body = JSON.parse(String(init.body)) as { visitor: string; step?: string };
    expect(body.visitor).toMatch(/.{8,}/);
    expect(init.keepalive).toBe(true);
    steps.push(body.step);
    return new Response("{}");
  }));
  assign = vi.fn();
  vi.spyOn(window, "location", "get").mockReturnValue({ ...window.location, assign } as unknown as Location);
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(() => { act(() => root.unmount()); el.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const button = (label: string) => [...el.querySelectorAll<HTMLButtonElement>(".hiw-foot button")].find((b) => b.textContent?.startsWith(label))!;

describe("the homepage card's funnel pings", () => {
  it("Next, Next, Open: page2, page3, open, and Open goes to the collective", () => {
    act(() => root.render(<HomeCard collectives={collectives} onClose={() => {}} />));
    expect(steps).toEqual([]);
    act(() => button("Next").click());
    act(() => button("Next").click());
    act(() => button("Open").click());
    expect(steps).toEqual(["page2", "page3", "open"]);
    expect(assign).toHaveBeenCalledWith("/workshop/");
  });
  it("Skip on the first page: skip, and the card closes", () => {
    const onClose = vi.fn();
    act(() => root.render(<HomeCard collectives={collectives} onClose={onClose} />));
    act(() => button("Skip").click());
    expect(steps).toEqual(["skip"]);
    expect(onClose).toHaveBeenCalled();
  });
  it("the close × on page 2 counts as skip", () => {
    act(() => root.render(<HomeCard collectives={collectives} onClose={() => {}} />));
    act(() => button("Next").click());
    act(() => el.querySelector<HTMLButtonElement>(".hiw-head .close")!.click());
    expect(steps).toEqual(["page2", "skip"]);
  });
});
