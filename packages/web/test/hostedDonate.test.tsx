import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Me, TownHealth } from "@muster-town/schema";
import { Donate } from "../src/panels/BankFunding";
import { store } from "../src/state";

// Mitchell, 1:1 mt_p3ge56kg03: a hosted collective never runs on a subscription; the Workshop and self-hosted towns may
describe("Donate: the subscription source", () => {
  const admin = { user: { id: "us_a", name: "Ada", hasApiKey: false }, roles: [], avatarAgentId: null, isAdmin: true } as unknown as Me;
  const render = (health: TownHealth | null) => { store.set({ me: admin, buildings: [], health }); return renderToStaticMarkup(<Donate onChange={() => {}} />); };

  it("is offered to the Workshop's admin (no funding in its health)", () => {
    expect(render({ docker: true })).toContain("My subscription (owner)");
  });

  it("is not offered in a hosted collective, keyed or not", () => {
    for (const funding of ["api-key", "none"] as const) {
      const html = render({ docker: true, funding });
      expect(html).not.toContain("subscription");
      expect(html).toContain('value="API key"');
    }
  });
});
