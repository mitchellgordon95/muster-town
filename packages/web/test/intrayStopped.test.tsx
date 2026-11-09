/**
 * GET /api/buildings/town-hall/intray's `stopped` (gr_8i952perny) and `digest` (gr_kdlogzzo5s): the client keeps both
 * (the Town Hall in-tray's sections that rendered them went with it: the decision queue replaced it, 2026-11-09).
 */
import { describe, expect, it } from "vitest";
import type { GrantView } from "@muster-town/schema";
import { intrayOf } from "../src/api";
import { grants } from "../src/mock/fixture";

const stopped = { ...(grants[0] as GrantView), id: "gr_stop", title: "Throwaway grant", objective: "Throwaway grant: a test of the stop", status: "closed", outcome: "stopped", proposedBy: "us_m", fundedBy: "us_m", grantTokens: 5000, spentTokens: 144584,
  history: [{ at: new Date().toISOString(), byId: "us_m", byKind: "user", action: "stop", tokens: null, note: "test stop" }] } as GrantView;

describe("the Town Hall in-tray's stopped grants and digest", () => {
  it("the client keeps stopped and digest from the response", () => {
    const r = intrayOf({ reports: [], grants: [], stopped: [stopped], digest: { doc: { id: "dc_d" } } as never });
    expect(r.stopped?.map((g) => g.id)).toEqual(["gr_stop"]);
    expect(r.digest).toMatchObject({ doc: { id: "dc_d" } });
    expect(intrayOf({ reports: [], grants: [] })).toMatchObject({ stopped: [], digest: null });
  });
});
