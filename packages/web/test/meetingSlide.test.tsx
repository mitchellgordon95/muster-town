import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { parseDeck } from "@muster-town/schema";
import { PresentedSlide } from "../src/panels/MeetingSlide";
import { MockApi } from "../src/mock/server";

// Markdown sanitizes with DOMParser, which node lacks: render its source text instead
vi.mock("../src/panels/Markdown", () => ({ Markdown: ({ text }: { text: string }) => <div className="md">{text}</div> }));

const deck = parseDeck("# Bank day\nOpening\nNotes: say hello\n---\n## Spend\n400k today\nNotes: the big number\n---\n## Next\nAsk");

// gr_jh0lu0w6yj step 5: the presented slide above a meeting's chat follows meeting.deck.slide
describe("presentation mode: the synced slide", () => {
  it("every attendee sees the meeting's current slide; only the presenter sees the Notes line and the next slide's title", () => {
    const viewer = renderToStaticMarkup(<PresentedSlide title="Bank day" slides={deck.slides} n={2} presenter={false} go={null} />);
    expect(viewer).toContain("2 / 3");
    expect(viewer).toContain("400k today");
    expect(viewer).not.toContain("Opening");
    expect(viewer).not.toContain("the big number");
    expect(viewer).not.toContain("Next:");
    const presenter = renderToStaticMarkup(<PresentedSlide title="Bank day" slides={deck.slides} n={2} presenter go={() => undefined} />);
    expect(presenter).toContain("the big number");
    expect(presenter).toContain("Next: Next");
    expect(presenter).toContain("you are presenting");
    // the meeting row moved on (a websocket update): the same component shows the new slide
    expect(renderToStaticMarkup(<PresentedSlide title="Bank day" slides={deck.slides} n={3} presenter go={() => undefined} />)).toContain("Next: (last slide)");
  });

  it("presenting from a deck doc sets meeting.deck and posts '— slide n: <title>' once per move", async () => {
    const api = new MockApi();
    const m = await api.createMeeting({ kind: "ad-hoc", buildingId: "bl_carbon", startNow: true, brings: { mode: "nothing", text: "" } });
    expect(m.deck).toBeNull();
    await api.presentMeeting(m.id, "dc_ws_deck", 2);
    const again = await api.presentMeeting(m.id, "dc_ws_deck", 2);
    expect(again.deck).toMatchObject({ docId: "dc_ws_deck", slide: 2 });
    expect(again.transcript.filter((u) => u.speakerKind === "system").map((u) => u.text)).toEqual(["— slide 2: The HUD on a narrow screen"]);
    expect((await api.presentMeeting(m.id, null)).deck).toBeNull();
    const called = await api.createMeeting({ kind: "in-tray-review", buildingId: null, startNow: true, deck: { docId: "review-deck" } });
    expect(called.deck).toMatchObject({ docId: "review-deck", slide: 1 });
  });
});
