import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Shipped } from "../src/panels/GrantPanel";
import { StepStrip } from "../src/panels/StepStrip";
import { MockApi } from "../src/mock/server";

vi.mock("../src/map/sprites", async (orig) => ({ ...(await orig<object>()), portraitUrl: () => "", iconUrl: () => "" }));

// gr_hwxc1lwi2e: a closed grant's page says what it shipped and has one spend number
describe("a closed grant's page", () => {
  it("lists what it shipped: title, where to look and the picture (kr_nidvt8pxfr)", async () => {
    const g = await new MockApi().grant("gr_stress");
    const html = renderToStaticMarkup(<Shipped grant={g} />);
    expect(html).toContain("What it shipped");
    expect(html).toContain("Ten desks run sessions in parallel");
    expect(html).toContain("the stress report lists 10 sessions");
    expect(html).toContain("A stuck desk restarts by itself");
    expect(html.match(/<img/g)).toHaveLength(1);
  });

  it("with no shipped notices says so in one muted line pointing at the close report (kr_7149nmpdfj)", async () => {
    const g = { ...(await new MockApi().grant("gr_stress")), shipped: [] };
    const html = renderToStaticMarkup(<Shipped grant={g} />);
    expect(html).toContain("No shipped notes were filed when it closed.");
    expect(html).toContain("close report");
    expect(html).not.toContain("What it shipped");
    expect(renderToStaticMarkup(<Shipped grant={{ ...g, checkpointDocId: null }} />)).toContain("under Sessions");
  });

  it("shows nothing on a grant that is not closed, or from an older server", async () => {
    const g = await new MockApi().grant("gr_stress");
    expect(renderToStaticMarkup(<Shipped grant={{ ...g, status: "funded" }} />)).toBe("");
    expect(renderToStaticMarkup(<Shipped grant={{ ...g, shipped: undefined }} />)).toBe("");
  });

  it("the step strip reads the booked spend, not the stale forecast, and projects nothing (kr_5epkmylb7c)", async () => {
    const g = await new MockApi().grant("gr_stress");
    const html = renderToStaticMarkup(<StepStrip grant={g} />);
    expect(html).toContain("spent 450k");
    expect(html).not.toContain("300k");
    expect(html).not.toContain("projected");
    // a funded grant still shows its forecast
    expect(renderToStaticMarkup(<StepStrip grant={{ ...g, status: "funded" }} />)).toContain("projected");
  });
});
