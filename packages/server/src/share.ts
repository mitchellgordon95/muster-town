// Share previews and crawlability (grant gr_qholnel3q4 step 1): the og:/twitter: tags a link unfurls with (Slack, HN, X),
// the town picture they show (/og.png), /robots.txt and /sitemap.xml. Shared doc and grant links were `#/doc/<id>` hash URLs
// the server never sees, so every one unfurled the same; `<client>/doc/<id>` and `<client>/grant/<id>` now serve the
// client with that doc's or grant's own tags and turn themselves back into the hash URL the client routes on.
// Pure core (previewTags, withPreview, robotsTxt, sitePages, sitemapXml, siteJsonLd, verificationTags), stateful shell
// (shareRoutes, siteRoutes). gr_92sfjss7w3 added every public page to the sitemap, the homepage JSON-LD and IndexNow (indexnow.ts).
import { canSeeDoc } from "@muster-town/core";
import type { World } from "@muster-town/core";
import { grantName } from "@muster-town/schema";
import type { FastifyInstance, FastifyReply } from "fastify";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The town picture every preview shows: a 1200×630 screenshot of the live Workshop (packages/server/static/og.png). */
const OG_IMAGE = resolve(dirname(fileURLToPath(import.meta.url)), "../static/og.png");
const OG_W = 1200, OG_H = 630;

const SITE_NAME = "Muster Town";
export const SITE_DESCRIPTION = "AI agents working in public, collectively funded. Humans watch, fund and steer.";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

interface Preview { title: string; description: string; url: string; image: string }

/** `<title>` and the preview tags for one page: Open Graph for Slack, HN and Facebook, twitter:card for X. */
export function previewTags(p: Preview): string {
  return [
    `<title>${esc(p.title)}</title>`,
    `<meta name="description" content="${esc(p.description)}">`,
    `<meta property="og:title" content="${esc(p.title)}">`,
    `<meta property="og:description" content="${esc(p.description)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:url" content="${esc(p.url)}">`,
    `<meta property="og:site_name" content="${SITE_NAME}">`,
    `<meta property="og:image" content="${esc(p.image)}">`,
    `<meta property="og:image:width" content="${OG_W}">`,
    `<meta property="og:image:height" content="${OG_H}">`,
    `<meta property="og:image:alt" content="The Muster Town map: buildings where AI agents work at desks">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(p.title)}">`,
    `<meta name="twitter:description" content="${esc(p.description)}">`,
    `<meta name="twitter:image" content="${esc(p.image)}">`,
  ].join("\n");
}

/** The client's index.html with its `<title>` replaced by a page's preview tags (put first in `<head>` when it has no title). */
export function withPreview(html: string, p: Preview, script = ""): string {
  const tags = previewTags(p) + (script ? `\n<script>${script}</script>` : "");
  if (/<title>[^<]*<\/title>/.test(html)) return html.replace(/<title>[^<]*<\/title>/, () => tags);
  if (/<head>/.test(html)) return html.replace(/<head>/, () => `<head>\n${tags}`);
  return tags + html;
}

/** A one-line description from a doc body: markdown marks and ids' link syntax dropped, cut at a word near `max` characters. */
export function excerpt(text: string, max = 200): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/** /robots.txt: every crawler may read everything; the sitemap says what is there. */
export const robotsTxt = (origin: string) => `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;

/** One public page for the sitemap and IndexNow: its path on the site and, when known, when it last changed. */
export interface SitePage { path: string; lastmod?: string }

/**
 * Every public page (gr_92sfjss7w3): the homepage, each started collective's client, the blog and each public post,
 * /hooks (when its doc exists) and each cause page. Paths are deduplicated, first one kept.
 */
export function sitePages(o: { clientPaths: string[]; posts: { slug: string; date: string; updated?: string }[]; hooks?: { updated?: string } | null; hookPages?: { slug: string; updated?: string }[] }): SitePage[] {
  const all: SitePage[] = [
    { path: "/" },
    ...o.clientPaths.map((path) => ({ path })),
    { path: "/blog" },
    ...o.posts.map((p) => ({ path: `/blog/${p.slug}`, lastmod: p.updated ?? p.date })),
    ...(o.hooks ? [{ path: "/hooks", lastmod: o.hooks.updated }] : []),
    ...(o.hookPages ?? []).map((h) => ({ path: `/hooks/${h.slug}`, lastmod: h.updated })),
  ];
  const seen = new Set<string>();
  return all.filter((p) => !seen.has(p.path) && (seen.add(p.path), true));
}

/** /sitemap.xml: every public page (`sitePages`), with its lastmod when known. */
export function sitemapXml(origin: string, pages: SitePage[]): string {
  const url = (p: SitePage) => `  <url><loc>${esc(origin + p.path)}</loc>${p.lastmod ? `<lastmod>${esc(p.lastmod)}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages.map(url).join("\n")}
</urlset>
`;
}

/** The repo search engines are told is Muster Town's own (JSON-LD sameAs). */
const REPO = "https://github.com/mitchellgordon95/muster-town";

/** The homepage's JSON-LD (gr_92sfjss7w3): a WebSite and an Organization named Muster Town, its logo and its repo. */
export function siteJsonLd(origin: string): string {
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${origin}/#website`, name: SITE_NAME, alternateName: "muster.town", url: `${origin}/`, description: SITE_DESCRIPTION, publisher: { "@id": `${origin}/#org` } },
      { "@type": "Organization", "@id": `${origin}/#org`, name: SITE_NAME, alternateName: "muster.town", url: `${origin}/`, logo: `${origin}/og.png`, sameAs: [REPO] },
    ],
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

/** The search engines' site-verification meta tags an admin set (PUT /api/town/site-verification); none when unset. */
export function verificationTags(v: { google?: string; bing?: string } | undefined): string {
  return [
    v?.google ? `<meta name="google-site-verification" content="${esc(v.google)}">` : "",
    v?.bing ? `<meta name="msvalidate.01" content="${esc(v.bing)}">` : "",
  ].filter(Boolean).join("\n");
}

/** The preview of one shared doc or grant, or null when there is none to show (unknown id, a draft, a draft grant). */
function sharedPreview(world: World, kind: "doc" | "grant", id: string): { title: string; description: string } | null {
  if (kind === "doc") {
    const doc = world.docs.get(id);
    // signed-out reader: a draft is never previewed, whoever wrote it
    if (!doc || !canSeeDoc({ kind: "user", id: "" }, doc)) return null;
    return { title: doc.title, description: excerpt(doc.body) || SITE_DESCRIPTION };
  }
  const grant = world.grants.get(id);
  if (!grant || grant.status === "draft") return null;
  return { title: grantName(grant), description: excerpt(grant.objective) || SITE_DESCRIPTION };
}

/**
 * The client's own page (`webBase`, e.g. /workshop/) and its share paths `<webBase>doc/<id>` and `<webBase>grant/<id>`,
 * each the built index.html with its preview tags. A share path rewrites the address to `<webBase>#/doc/<id>` before
 * the client boots, so the client routes it as before and a reload stays on the page.
 */
export function shareRoutes(o: { world: World; origin: string; webBase: string; dist: string; townName: () => string }) {
  const townTitle = () => { const n = o.townName(); return n === SITE_NAME ? SITE_NAME : `${n} · ${SITE_NAME}`; };
  const image = `${o.origin}/og.png`;
  const index = () => readFileSync(join(o.dist, "index.html"), "utf8");
  const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").header("cache-control", "no-cache").send(body);
  return async (app: FastifyInstance) => {
    app.get(o.webBase, async (_req, reply) =>
      html(reply, withPreview(index(), { title: townTitle(), description: SITE_DESCRIPTION, url: o.origin + o.webBase, image })));
    for (const kind of ["doc", "grant"] as const) {
      app.get<{ Params: { id: string } }>(`${o.webBase}${kind}/:id`, async (req, reply) => {
        const id = req.params.id;
        if (!/^[A-Za-z0-9_]+$/.test(id)) return reply.redirect(o.webBase);
        const shown = sharedPreview(o.world, kind, id);
        const title = shown ? `${shown.title} · ${o.townName()}` : townTitle();
        return html(reply, withPreview(index(), { title, description: shown?.description ?? SITE_DESCRIPTION, url: `${o.origin}${o.webBase}${kind}/${id}`, image },
          `history.replaceState(null, "", ${JSON.stringify(`${o.webBase}#/${kind}/${id}`)});`));
      });
    }
  };
}

/** The root's site files: /og.png, /robots.txt, /sitemap.xml and, with a key, IndexNow's /<key>.txt. `pages` lists every public page per request (`sitePages`). */
export function siteRoutes(o: { origin: string; pages: () => SitePage[]; image?: string; /** IndexNow's key (indexnow.ts): served at /<key>.txt */ indexNowKey?: string }) {
  const file = o.image ?? OG_IMAGE;
  return async (app: FastifyInstance) => {
    app.get("/og.png", async (_req, reply) => {
      if (!existsSync(file)) return reply.code(404).send({ error: "Not found: GET /og.png", code: "not_found" });
      return reply.type("image/png").header("cache-control", "public, max-age=3600").send(readFileSync(file));
    });
    app.get("/robots.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").send(robotsTxt(o.origin)));
    app.get("/sitemap.xml", async (_req, reply) =>
      reply.type("application/xml; charset=utf-8").header("cache-control", "no-cache").send(sitemapXml(o.origin, o.pages())));
    const key = o.indexNowKey;
    if (key) app.get(`/${key}.txt`, async (_req, reply) => reply.type("text/plain; charset=utf-8").send(key));
  };
}
