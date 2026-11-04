/**
 * The Town Hall in-tray's "Stopped: for the record" section (gr_8i952perny) and the Secretary's digest card
 * (gr_kdlogzzo5s) read `stopped` and `digest` from GET /api/buildings/town-hall/intray: the client keeps both, and the
 * section renders in List and Cards without reading `list` before it is declared.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { GrantView } from "@muster-town/schema";
import { intrayOf } from "../src/api";
import { TownHallIntray } from "../src/panels/Places";
import { grants } from "../src/mock/fixture";
import { store } from "../src/state";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));
vi.mock("../src/route", async (orig) => ({ ...(await orig<object>()), grantUrl: (id: string) => `/#/grant/${id}` }));
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div>, DocText: ({ text }: { text: string }) => <span>{text}</span>, openDocLink: () => undefined }));

const stopped = { ...(grants[0] as GrantView), id: "gr_stop", objective: "Throwaway grant", status: "closed", outcome: "stopped", proposedBy: "us_m", fundedBy: "us_m", grantTokens: 5000, spentTokens: 144584,
  history: [{ at: new Date().toISOString(), byId: "us_m", byKind: "user", action: "stop", tokens: null, note: "test stop" }] } as GrantView;

describe("the Town Hall in-tray's stopped grants and digest", () => {
  it("the client keeps stopped and digest from the response", () => {
    const r = intrayOf({ reports: [], grants: [], stopped: [stopped], digest: { doc: { id: "dc_d" } } as never });
    expect(r.stopped?.map((g) => g.id)).toEqual(["gr_stop"]);
    expect(r.digest).toMatchObject({ doc: { id: "dc_d" } });
    expect(intrayOf({ reports: [], grants: [] })).toMatchObject({ stopped: [], digest: null });
  });
  for (const mode of ["list", "cards"] as const) it(`renders "Stopped: for the record" in ${mode}`, () => {
    store.state = { ...store.state, me: { isAdmin: true, roles: [], user: { id: "us_m", name: "Mitchell" } } as never };
    const html = renderToStaticMarkup(<TownHallIntray mode={mode} onFocus={() => undefined} reports={[]} grants={[]} goalProposals={[]} routes={{}} access={[]} captains={[]} retainers={[]} blocked={[]} stopped={[stopped]} onOpen={() => undefined} onDecided={() => undefined} />);
    expect(html).toContain("Stopped: for the record");
    expect(html).toContain("Throwaway grant");
  });
});
