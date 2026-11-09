/**
 * The Town Hall hydrant (docs/legible-delegation.md §3, UI / UX A): its place in the Town Hall, its three numbers from
 * the in-tray read, and the stream's dots (capped, none under reduced motion).
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TILE, type Notice } from "@muster-town/schema";
import { computeLayout } from "../src/mock/layout";
import { agents, asks, buildings, notices } from "../src/mock/fixture";
import { MAX_PARTICLES, hydrantCounts, streamParticles } from "../src/map/hydrant";
import { HydrantRows } from "../src/panels/Places";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const notice = (id: string, kind: Notice["kind"], createdAt: string): Notice => ({ ...notices[0], id, kind, createdAt });

describe("the Town Hall hydrant", () => {
  it("the Town Hall layout has the hydrant place beside the in-tray, its tile right of the tray", () => {
    const { grid, places } = computeLayout(buildings, agents);
    const hall = buildings.find((b) => b.kind === "town-hall")!;
    const p = places.find((x) => x.id === `hydrant:${hall.id}`)!;
    expect(p).toMatchObject({ kind: "hydrant", buildingId: hall.id });
    const at = (x: number, y: number) => grid.tiles[y * grid.w + x];
    expect(at(p.pos.x, p.pos.y + 1)).toBe(TILE.HYDRANT);
    expect(at(p.pos.x - 1, p.pos.y + 1)).toBe(TILE.MANAGER_DESK);
  });

  it("counts live asks (a deferred one too), today's notices and the last slate as the ranking time", () => {
    const now = new Date("2026-11-08T15:00:00");
    const c = hydrantCounts({
      asks: [{ ...asks[0], status: "open" }, { ...asks[0], id: "ak_b", status: "open" }, { ...asks[0], id: "ak_c", status: "deferred" }],
      notices: [notice("nt_a", "shipped", new Date("2026-11-08T09:00:00").toISOString()), notice("nt_s", "slate", new Date("2026-11-08T08:00:00").toISOString()), notice("nt_old", "slate", new Date("2026-11-06T08:00:00").toISOString())],
    }, now);
    expect(c).toEqual({ asks: 3, noticesToday: 2, rankedAt: new Date("2026-11-08T08:00:00").toISOString() });
    expect(hydrantCounts(null)).toEqual({ asks: 0, noticesToday: 0, rankedAt: null });
  });

  it("the panel shows the three numbers and the rank button it is given", () => {
    const html = renderToStaticMarkup(<HydrantRows counts={{ asks: 3, noticesToday: 5, rankedAt: null }} onInTray={() => undefined} onFeed={() => undefined} rank={<button>Rank now</button>} />);
    expect(html).toMatch(/<b class="hydrant-n">3<\/b><span>open asks<\/span>/);
    expect(html).toMatch(/<b class="hydrant-n">5<\/b><span>notices today<\/span>/);
    expect(html).toMatch(/<b class="hydrant-n">not yet<\/b><span>ranked<\/span>/);
    for (const label of ["In-tray", "Feed", "Rank now"]) expect(html).toContain(`>${label}</button>`);
  });

  it("the stream: a dot per ask and notice, at most a dozen, none under reduced motion or without a target", () => {
    const from = { x: 0, y: 0 }, to = { ask: { x: 32, y: 0 }, notice: { x: -64, y: 0 } };
    const few = streamParticles(from, to, { asks: 2, noticesToday: 3 }, 1000, false);
    expect(few.filter((d) => d.kind === "ask")).toHaveLength(2);
    expect(few.filter((d) => d.kind === "notice")).toHaveLength(3);
    expect(streamParticles(from, to, { asks: 40, noticesToday: 40 }, 1000, false)).toHaveLength(MAX_PARTICLES);
    expect(streamParticles(from, to, { asks: 40, noticesToday: 0 }, 1000, false)).toHaveLength(MAX_PARTICLES);
    expect(streamParticles(from, to, { asks: 2, noticesToday: 3 }, 1000, true)).toEqual([]);
    expect(streamParticles(from, { ask: null, notice: null }, { asks: 2, noticesToday: 3 }, 1000, false)).toEqual([]);
    for (const d of few) {
      expect(d.x).toBeGreaterThanOrEqual(-64);
      expect(d.x).toBeLessThanOrEqual(32);
    }
  });
});
