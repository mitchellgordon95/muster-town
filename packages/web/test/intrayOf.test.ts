/** The web client's in-tray fetch keeps every field the server sends: the digest card and the stopped grants were dropped (live 0fb0b97). */
import { describe, expect, it } from "vitest";
import { intrayOf } from "../src/api";

describe("intrayOf", () => {
  it("passes the digest card and the stopped grants through", () => {
    const digest = { doc: { id: "dc_dig" }, decisions: [], askedOfYou: null, shipped: "", covered: [] } as never;
    const stopped = [{ id: "gr_s", status: "closed" }] as never;
    const r = intrayOf({ reports: [], grants: [], digest, stopped });
    expect(r.digest).toBe(digest);
    expect(r.stopped).toBe(stopped);
  });
  it("defaults the lists when the server leaves them out", () => {
    const r = intrayOf({});
    expect(r).toMatchObject({ reports: [], grants: [], stopped: [], digest: null, defaultView: "all" });
  });
});
