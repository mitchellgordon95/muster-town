import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { GrantView } from "@muster-town/schema";
import { CompactLine, grantPillText, readIntrayMode, reportPill } from "../src/panels/intrayList";

const LONG = "Workshop rollup 42 (checkpoint, stop a funded grant): a human can stop a funded grant and the town winds it down, live on 97a9570";

describe("the in-tray as a list (Mitchell's flag dc_2hllscunfx)", () => {
  it("one line per item: the title (full in the tooltip), one pill, a time-ago; no cards, no Needs line", () => {
    const pill = reportPill({ type: "report", tags: ["rollup"], verdict: "continue" });
    const html = renderToStaticMarkup(<CompactLine lead={<b>Workshop</b>} title={LONG} at={new Date().toISOString()} pill={pill} onOpen={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toContain(`title="${LONG}"`);
    expect(html).toContain('class="intray-line-title"');
    expect(html.match(/class="pill/g)).toHaveLength(1);
    expect(html).toContain(">rollup<");
    expect(html).toContain("just now");
    for (const s of ["intray-cards", "Needs:", "covers", "chain "]) expect(html).not.toContain(s);
  });

  it("clicking the line opens the item", () => {
    const onOpen = vi.fn();
    const el = CompactLine({ title: "A report", at: null, onOpen }) as ReactElement<{ onClick: () => void }>;
    el.props.onClick();
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("the pill: a flag, a verdict, a grant's status with its money", () => {
    expect(renderToStaticMarkup(<>{reportPill({ type: "flag", tags: [], verdict: null })}</>)).toContain("⚑ flag");
    expect(renderToStaticMarkup(<>{reportPill({ type: "report", tags: [], verdict: "stop" })}</>)).toContain(">stop<");
    const g = { status: "checkpoint", outcome: null, askTokens: 500_000, grantTokens: 500_000, spentTokens: 537_665 } as unknown as GrantView;
    expect(grantPillText(g)).toMatch(/^53\dk \/ 500k$/);
    expect(grantPillText({ ...g, status: "proposed" } as GrantView)).toBe("asks 500k");
    expect(grantPillText(g, true)).toMatch(/^stopped · /);
  });

  it("List is the default; Cards is remembered", () => {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
    expect(readIntrayMode()).toBe("list");
    store["muster.intrayMode"] = "cards";
    expect(readIntrayMode()).toBe("cards");
    vi.unstubAllGlobals();
  });
});
