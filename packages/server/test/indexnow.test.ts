import { createDoc, World } from "@muster-town/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BLOG_BUILDING } from "../src/blog.ts";
import { IndexNow, indexNowBody, indexNowDue, indexNowEnabled, isIndexNowKey } from "../src/indexnow.ts";
import type { SitePage } from "../src/share.ts";
import { json, seededApp } from "./helpers.ts";

const ORIGIN = "https://muster.town";

describe("IndexNow (pure)", () => {
  it("is on only where the public URL is muster.town, unless the flag says", () => {
    expect(indexNowEnabled(undefined, "https://muster.town")).toBe(true);
    expect(indexNowEnabled(undefined, "https://throwaway.fly.dev")).toBe(false);
    expect(indexNowEnabled(undefined, undefined)).toBe(false);
    expect(indexNowEnabled("off", "https://muster.town")).toBe(false);
    expect(indexNowEnabled("on", "https://other.example")).toBe(true);
    expect(indexNowEnabled(undefined, "not a url")).toBe(false);
  });

  it("due = the pages whose lastmod differs from what was last sent; nothing twice", () => {
    const pages: SitePage[] = [{ path: "/" }, { path: "/blog/a", lastmod: "2026-11-20" }, { path: "/hooks/cptsd", lastmod: "t1" }];
    expect(indexNowDue(ORIGIN, pages, {})).toEqual([`${ORIGIN}/`, `${ORIGIN}/blog/a`, `${ORIGIN}/hooks/cptsd`]);
    const sent = { [`${ORIGIN}/`]: "", [`${ORIGIN}/blog/a`]: "2026-11-20", [`${ORIGIN}/hooks/cptsd`]: "t0" };
    expect(indexNowDue(ORIGIN, pages, sent)).toEqual([`${ORIGIN}/hooks/cptsd`]);
    // property: after sending everything, nothing is due
    fc.assert(fc.property(fc.uniqueArray(fc.stringMatching(/^\/[a-z]{0,5}$/)), fc.array(fc.option(fc.string(), { nil: undefined })), (paths, mods) => {
      const ps = paths.map((path, i) => ({ path, lastmod: mods[i] }));
      const all = Object.fromEntries(ps.map((p) => [ORIGIN + p.path, p.lastmod ?? ""]));
      expect(indexNowDue(ORIGIN, ps, all)).toEqual([]);
      expect(indexNowDue(ORIGIN, ps, {})).toHaveLength(ps.length);
    }));
  });

  it("the body names the host, the key and where the key file is", () => {
    expect(indexNowBody(ORIGIN, "abcdef0123", [`${ORIGIN}/`])).toEqual({ host: "muster.town", key: "abcdef0123", keyLocation: `${ORIGIN}/abcdef0123.txt`, urlList: [`${ORIGIN}/`] });
    expect(isIndexNowKey("abcdef0123")).toBe(true);
    expect(isIndexNowKey("short")).toBe(false);
    expect(isIndexNowKey("has/slash1")).toBe(false);
  });
});

describe("IndexNow (the submitter)", () => {
  const setup = (status = 202) => {
    const world = World.open(":memory:");
    const calls: { url: string; body: ReturnType<typeof indexNowBody> }[] = [];
    let pages: SitePage[] = [{ path: "/" }, { path: "/hooks/cptsd", lastmod: "t1" }];
    const fetch = async (url: string, init: { body: string }) => { calls.push({ url, body: JSON.parse(init.body) }); return { status }; };
    const ix = new IndexNow({ world, origin: ORIGIN, pages: () => pages, fetch });
    return { world, calls, ix, setPages: (p: SitePage[]) => { pages = p; } };
  };
  const events = (world: World) => world.events.recent({ limit: 50 }).filter((e) => e.text.startsWith("IndexNow")).reverse();

  it("keeps one key, submits every page first, then only what is published or updated; each submit is an event", async () => {
    const { world, calls, ix, setPages } = setup();
    expect(isIndexNowKey(ix.key)).toBe(true);
    expect(new IndexNow({ world, origin: ORIGIN, pages: () => [] }).key).toBe(ix.key);
    expect(await ix.run()).toBe(202);
    expect(calls[0]!.url).toBe("https://api.indexnow.org/indexnow");
    expect(calls[0]!.body).toMatchObject({ host: "muster.town", key: ix.key, urlList: [`${ORIGIN}/`, `${ORIGIN}/hooks/cptsd`] });
    expect(await ix.run()).toBeNull();
    setPages([{ path: "/" }, { path: "/hooks/cptsd", lastmod: "t2" }, { path: "/blog/new", lastmod: "2026-11-24" }]);
    expect(await ix.run()).toBe(202);
    expect(calls[1]!.body.urlList).toEqual([`${ORIGIN}/hooks/cptsd`, `${ORIGIN}/blog/new`]);
    const ev = events(world);
    expect(ev).toHaveLength(2);
    expect(ev.at(-1)!.text).toMatch(/submitted 2 URLs .*response 202; key file https:\/\/muster.town\/[0-9a-f]{32}\.txt$/);
    world.close();
  });

  it("a refused submit is logged once, is not marked sent and waits 6 hours to retry", async () => {
    const { world, calls, ix } = setup(403);
    const t = Date.parse("2026-11-24T22:00:00Z");
    expect(await ix.run(t)).toBe(403);
    expect(await ix.run(t + 60_000)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(events(world)[0]!.text).toMatch(/failed \(response 403\)/);
    expect(await ix.run(t + 6 * 3600_000 + 1)).toBe(403);
    expect(calls[1]!.body.urlList).toHaveLength(2);
    world.close();
  });
});

describe("the real app's sitemap, JSON-LD and site verification", () => {
  it("lists /hooks and each cause page, carries JSON-LD on /, and an admin's verification tokens show on /", async () => {
    const { world, app, auth, close } = await seededApp();
    const mk = (title: string, tags: string[], body: string) => createDoc(world, { type: "note", title, body, authorId: "ag_writer", authorKind: "agent", state: "building", buildingId: BLOG_BUILDING, tags });
    mk("Ranked", ["hooks"], "1. causes");
    mk("C-PTSD", ["hook"], "---\nslug: cptsd\n---\nWho");
    mk("Climate", ["hook"], "---\nslug: climate-adaptation\n---\nWho");
    const map = (await app.inject("/sitemap.xml")).body;
    for (const p of ["/", "/workshop/", "/blog", "/hooks", "/hooks/cptsd", "/hooks/climate-adaptation"]) expect(map).toContain(`<loc>${ORIGIN}${p}</loc>`);
    const home = (await app.inject("/")).body;
    expect(home).toContain('<script type="application/ld+json">');
    expect(home).toContain('"sameAs":["https://github.com/mitchellgordon95/muster-town"]');
    expect(home).not.toContain("google-site-verification");
    // no IndexNow outside muster.town's production env: no key file is served
    expect(world.town.marker("indexnowKey")).toBeNull();

    expect((await json(app, "PUT", "/api/town/site-verification", { body: { google: "g123" } })).status).toBe(401);
    expect((await json(app, "PUT", "/api/town/site-verification", { headers: auth, body: { google: "bad token!" } })).status).toBe(400);
    const r = await json(app, "PUT", "/api/town/site-verification", { headers: auth, body: { google: "g123", bing: "B456" } });
    expect(r.status).toBe(200);
    expect(r.body.siteVerification).toEqual({ google: "g123", bing: "B456" });
    const after = (await app.inject("/")).body;
    expect(after).toContain('<meta name="google-site-verification" content="g123">');
    expect(after).toContain('<meta name="msvalidate.01" content="B456">');
    expect((await json(app, "PUT", "/api/town/site-verification", { headers: auth, body: { bing: "" } })).body.siteVerification).toEqual({ google: "g123" });
    await close();
  });
});
