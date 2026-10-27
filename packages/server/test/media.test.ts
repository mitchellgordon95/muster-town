import { afterEach, describe, expect, it } from "vitest";
import { seededApp } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("rest of a png")]);
const WEBM = Buffer.concat([Buffer.from("1a45dfa3", "hex"), Buffer.alloc(100, 7)]);

describe("media routes", () => {
  it("an agent uploads a png, gets markdown back, and anyone fetches it; dedups same bytes", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const resident = s.world.agents.first("kind = 'resident'")!;
    const headers = { authorization: `Bearer ${s.world.tokens.getOrCreate("agent", resident.id)}`, "content-type": "image/png" };
    const up = await s.app.inject({ method: "POST", url: "/api/media?alt=The%20Bank%20page", headers, payload: PNG });
    expect(up.statusCode).toBe(201);
    const body = up.json();
    expect(body.media).toMatchObject({ mime: "image/png", bytes: PNG.length, authorId: resident.id });
    expect(body.media.url).toMatch(/^\/api\/media\/mf_[a-z0-9]{10}\.png$/);
    expect(body.markdown).toBe(`![The Bank page](${body.media.url})`);
    const again = await s.app.inject({ method: "POST", url: "/api/media", headers, payload: PNG });
    expect(again.json().media.id).toBe(body.media.id);

    const got = await s.app.inject({ method: "GET", url: body.media.url });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(got.rawPayload.equals(PNG)).toBe(true);
    expect((await s.app.inject({ method: "GET", url: "/api/media/mf_0000000000.png" })).statusCode).toBe(404);
  });

  it("serves byte ranges for video", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    const up = await s.app.inject({ method: "POST", url: "/api/media", headers: { ...s.auth, "content-type": "video/webm" }, payload: WEBM });
    const url = up.json().media.url as string;
    expect(url).toMatch(/\.webm$/);
    const part = await s.app.inject({ method: "GET", url, headers: { range: "bytes=0-9" } });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-9/${WEBM.length}`);
    expect(part.rawPayload.equals(WEBM.subarray(0, 10))).toBe(true);
  });

  it("refuses anonymous uploads, unsupported types and bytes that don't match the declared type", async () => {
    const s = await seededApp();
    cleanups.push(s.close);
    expect((await s.app.inject({ method: "POST", url: "/api/media", headers: { "content-type": "image/png" }, payload: PNG })).statusCode).toBe(401);
    const svg = await s.app.inject({ method: "POST", url: "/api/media", headers: { ...s.auth, "content-type": "image/svg+xml" }, payload: "<svg onload=alert(1)/>" });
    expect(svg.statusCode).toBe(400);
    const lie = await s.app.inject({ method: "POST", url: "/api/media", headers: { ...s.auth, "content-type": "image/png" }, payload: WEBM });
    expect(lie.statusCode).toBe(400);
    expect(lie.json().error).toContain("video/webm");
    const big = await s.app.inject({ method: "POST", url: "/api/media", headers: { ...s.auth, "content-type": "image/png" }, payload: Buffer.concat([PNG, Buffer.alloc(9 * 1024 * 1024)]) });
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
  });
});
