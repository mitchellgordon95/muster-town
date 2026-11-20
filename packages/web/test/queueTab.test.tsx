import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { QueueCard, QueueLane } from "@muster-town/schema";
import { DONE_SHOWN, Lane } from "../src/panels/QueueTab";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), iconUrl: () => "", portraitUrl: () => "" }));

const card = (i: number, status = "done"): QueueCard => ({
  id: `as_${i}`, title: `Job ${i}`, lane: "directed", grantId: null, agentId: "ag_p", agentName: "Pix",
  status, createdAt: "2026-10-31T00:00:00Z", updatedAt: "2026-10-31T00:00:00Z", heldReason: null, tokens: null, reportId: null,
});
const lane = (done: number, queued = 0, exploreBlock: string | null = null): QueueLane => ({
  buildingId: "workshop", buildingName: "Town Workshop", desks: 2, exploreBlock,
  queued: Array.from({ length: queued }, (_, i) => card(100 + i, "pending")), held: [], running: [],
  done: Array.from({ length: done }, (_, i) => card(i)),
});
const titles = (html: string) => [...html.matchAll(/>Job (\d+)</g)].map((m) => Number(m[1]));

describe("Queue tab Done column (live check dc_7hi2zypctp: 43 done cards made the board ~9,600 px tall)", () => {
  it("shows the latest 10 done cards, the count in the header, and Show all (N)", () => {
    const html = renderToStaticMarkup(<Lane lane={lane(43)} />);
    expect(DONE_SHOWN).toBe(10);
    expect(titles(html)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(html).toContain("Done (24 h) 43");
    expect(html).toContain("Show all (43)");
  });
  it("keeps a short Done column whole with no toggle, and Queued is never capped", () => {
    const html = renderToStaticMarkup(<Lane lane={lane(10, 15)} />);
    expect(titles(html).filter((n) => n >= 100)).toHaveLength(15);
    expect(titles(html).filter((n) => n < 100)).toHaveLength(10);
    expect(html).not.toContain("Show all");
  });
  it("names the explore tick's wait above the columns (gr_6id9g7u9cj)", () => {
    expect(renderToStaticMarkup(<Lane lane={lane(0, 0, "the last 3 explorers found nothing; next may start at 2026-11-20 05:30 UTC")} />))
      .toContain("Explore: the last 3 explorers found nothing; next may start at 2026-11-20 05:30 UTC.");
    expect(renderToStaticMarkup(<Lane lane={lane(0)} />)).toContain("Explore: an explorer may start at the next tick.");
  });
});
