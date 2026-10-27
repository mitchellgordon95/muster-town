import { describe, expect, it } from "vitest";
import { mediaOf } from "../src/panels/MediaThumb";

describe("mediaOf (in-tray thumbnails)", () => {
  it("finds town-hosted images and videos in order, and ignores other images", () => {
    const body = "## Findings\n![Bank page](/api/media/mf_k19ooe4963.png) and\n![walkthrough](https://town.example/api/media/mf_af74tc48ca.webm)\n![elsewhere](https://x.example/a.png) ![svg](/api/media/mf_abcdefghij.svg)";
    expect(mediaOf(body)).toEqual([
      { alt: "Bank page", url: "/api/media/mf_k19ooe4963.png", video: false },
      { alt: "walkthrough", url: "https://town.example/api/media/mf_af74tc48ca.webm", video: true },
    ]);
    expect(mediaOf("no media here")).toEqual([]);
  });
});
