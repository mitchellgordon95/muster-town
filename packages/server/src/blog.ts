// The muster.town blog (as_uql5q7ey2k, Mitchell in mt_msnjkpgwdb decision 7). Since flag dc_4boq48hqr6 part 2 a post is
// a town doc, not a repo file: an `article` tagged `blog`, published (state "building") in the blog's building (Outreach
// on muster.town). Drafts are private to their author and never served. The Blog plugin on Outreach's back wall writes
// them (docs/plugins/blog.plugin.html); so does `write`. Read per request, so a publish shows at once. Root app only
// (app.ts). How to write one: docs/blog.md.
import type { FastifyInstance, FastifyReply } from "fastify";
import { Marked } from "marked";
import type { Doc } from "@muster-town/schema";
import { funnelSource, isAutomatedClient, type World } from "@muster-town/core";
import { WEB_BASE } from "./context.ts";
import { SITE_DESCRIPTION } from "./share.ts";

/** The building whose published `blog` articles are muster.town's blog: Outreach. */
export const BLOG_BUILDING = "bl_6ifesdbah3";
const BLOG_TAG = "blog";
/** A cover image's URL: http(s), or a path on this site. */
const IMAGE_URL = /^(https?:\/\/|\/(?!\/))[^\s"<>]+$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface Post { slug: string; title: string; date: string; author: string; summary: string; upcoming: string[]; body: string; /** the cover: an http(s) URL or a site path, or "" */ image: string }
/** Where the posts come from: the public posts, newest first. */
type PostSource = () => Post[];

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

const unquote = (v: string) => v.trim().replace(/^(["'])(.*)\1$/, "$2");

/** A title as a slug: lowercase words joined by dashes, at most 80 chars. */
const slugify = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/, "");

/**
 * A post doc's body: optional `key: value` front matter between `---` lines (quotes around a value dropped; `upcoming:`
 * takes the `- item` lines under it as a list, the posts to come shown above the signup), then markdown. Keys: slug
 * (default: the title as a slug), date YYYY-MM-DD (default: the day it was first written), author, summary, upcoming,
 * title (default: the doc's title), image (the cover: an http(s) URL or a site path such as /api/media/<id>.png; shown
 * above the post and used as its link-preview image and feed enclosure; anything else is dropped). Null when the slug is
 * not a valid one.
 */
export function postOf(doc: Pick<Doc, "title" | "body" | "createdAt">): Post | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(doc.body);
  const meta: Record<string, string> = {};
  const upcoming: string[] = [];
  if (m) {
    let listKey: string | null = null;
    for (const line of m[1]!.split(/\r?\n/)) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && listKey === "upcoming") { const v = unquote(item[1]!); if (v) upcoming.push(v); continue; }
      const kv = /^([A-Za-z]+):\s*(.*)$/.exec(line);
      if (!kv) continue;
      listKey = kv[1]!.toLowerCase();
      meta[listKey] = unquote(kv[2]!);
    }
  }
  const title = meta.title || doc.title;
  const slug = meta.slug || slugify(title);
  if (!SLUG.test(slug)) return null;
  const date = meta.date && DATE.test(meta.date) ? meta.date : doc.createdAt.slice(0, 10);
  const image = meta.image && IMAGE_URL.test(meta.image) ? meta.image : "";
  return { slug, title, date, author: meta.author ?? "", summary: meta.summary ?? "", upcoming, body: m ? m[2]! : doc.body, image };
}

/**
 * The blog's public posts from the town's docs: published `article`s tagged `blog` in `buildingId`, newest first. Two
 * posts with one slug: the first published keeps it, the later one is not served.
 */
export function docPosts(world: World, buildingId: string = BLOG_BUILDING): PostSource {
  return () => {
    const docs = world.docs.where("type = 'article' AND state = 'building' AND buildingId = ? AND tags LIKE ?", [buildingId, `%"${BLOG_TAG}"%`], "ORDER BY createdAt, rowid")
      .filter((d) => d.tags.includes(BLOG_TAG));
    const seen = new Set<string>();
    const posts: Post[] = [];
    for (const d of docs) { const p = postOf(d); if (p && !seen.has(p.slug)) { seen.add(p.slug); posts.push(p); } }
    return posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  };
}

/**
 * Markdown to HTML for a post. Posts are town docs now, written by anyone who can publish in the blog's building, so raw
 * HTML in the markdown is shown as text and a link or image may only point at http(s), mailto or a path on this site.
 */
const SAFE_URL = /^(https?:|mailto:|\/(?!\/)|#)/i;
const md = new Marked({
  renderer: {
    html({ text }) { return esc(text); },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      return SAFE_URL.test(href) ? `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""}>${inner}</a>` : inner;
    },
    image({ href, title, text }) {
      return SAFE_URL.test(href) ? `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""}>` : esc(text);
    },
  },
});

const CSS = `body{margin:0;background:#faf8f3;color:#1d1d22;font:17px/1.6 Georgia,"Iowan Old Style",serif}
main{max-width:42rem;margin:0 auto;padding:2rem 1.25rem 4rem}
nav{font:14px/1.4 system-ui,sans-serif;margin-bottom:2rem}nav a{color:#4a5a8a;margin-right:1rem}
h1{font-size:2rem;line-height:1.2;margin:.2em 0}h2,h3{line-height:1.3;margin-top:1.8em}
a{color:#2f56b0}.meta{font:14px/1.4 system-ui,sans-serif;color:#6b6b75}
pre{background:#f0ede4;padding:.8rem;overflow-x:auto;font-size:14px}code{font-size:.9em}
blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #d6d1c3;color:#4a4a52}img{max-width:100%}img.cover{display:block;width:100%;height:auto;margin:1rem 0 1.5rem;border-radius:4px}
ul.posts{list-style:none;padding:0}ul.posts li{margin:1.6rem 0}ul.posts h2{margin:0;font-size:1.3rem}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #e2ddd0}
.signup{margin:0 0 1.5rem}.signup p{margin:0 0 .5rem}.signup .row{display:flex;gap:.5rem;flex-wrap:wrap}
.signup input[type=email]{flex:1 1 14rem;font:16px/1.4 system-ui,sans-serif;padding:.45rem .6rem;border:1px solid #c9c3b3;border-radius:4px;background:#fff}
.signup button{font:15px/1.4 system-ui,sans-serif;padding:.45rem 1rem;border:0;border-radius:4px;background:#2f56b0;color:#fff;cursor:pointer}
.about{margin:0 0 1.5rem;padding:.9rem 1rem;background:#f0ede4;border-radius:4px}.about h2{margin:0 0 .4rem;font-size:1.1rem}.about p{margin:.3rem 0}
.signup .hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.signup .err{color:#a33;font:14px/1.4 system-ui,sans-serif}`;

/** A cover's absolute URL (link previews and feeds need one): a site path gets the origin in front. */
const absolute = (origin: string, u: string) => u.startsWith("/") ? origin + u : u;
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The repo the About box links (the homepage's README link, home.ts). */
const REPO_URL = "https://github.com/mitchellgordon95/muster-town";

/**
 * The About Muster Town box above every post's signup (gr_y8buqgpata, findings dc_dl4tn9u7p1: blog readers didn't reach
 * the town or the repo): the homepage's og:description verbatim, the live Workshop town and the GitHub repo. A click on
 * the town link reaches the funnel as source "blog" (core funnelSource: an own-host referrer under /blog).
 */
function aboutBox(): string {
  return `<section class="about">
<h2>About Muster Town</h2>
<p>${esc(`Muster Town is ${SITE_DESCRIPTION}`)}</p>
<p><a href="${WEB_BASE}">Visit the live town</a> · <a href="${REPO_URL}">Muster Town on GitHub</a></p>
</section>`;
}

/** Every blog page's preview image: its cover, else the site's town picture /og.png (gr_y8buqgpata), so a shared link always shows one. */
function page(o: { origin: string; path: string; title: string; description: string; article?: boolean; image?: string; body: string }): string {
  const url = o.origin + o.path;
  const image = absolute(o.origin, o.image || "/og.png");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:type" content="${o.article ? "article" : "website"}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:site_name" content="Muster Town">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="alternate" type="application/atom+xml" title="Muster Town blog" href="${esc(o.origin)}/blog/feed.xml">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2314151c'/%3E%3Crect x='4' y='4' width='8' height='8' fill='%237cc4ff'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
<main>
<nav><a href="/">muster.town</a><a href="/blog">Blog</a><a href="/blog/feed.xml">Feed</a></nav>
${o.body}
</main>
</body>
</html>
`;
}

/**
 * The email signup at the foot of every blog page (Mitchell, mt_msnjkpgwdb decision 7): one input, one button. Posts JSON
 * to POST /api/blog/subscribe (mailing-list.ts) and swaps itself for a thank-you; with scripts off it does nothing.
 * `website` is the honeypot: hidden from people, filled by bots. `source` is the post slug, or "index". `upcoming` (a post's
 * front matter) is the hook: "Coming next:" and its items, then Mitchell's line (gr_qholnel3q4, his decision on ak_rw02ier2ni).
 */
function signup(source: string, upcoming: string[] = []): string {
  const hook = upcoming.length
    ? `<p>Coming next:</p>\n<ul>\n${upcoming.map((u) => `<li>${esc(u)}</li>`).join("\n")}\n</ul>\n<p>Subscribe for updates (mailing list for every blog post)</p>`
    : "<p>New posts by email. Nothing else.</p>";
  return `<form class="signup" method="post" action="/api/blog/subscribe" data-source="${esc(source)}">
${hook}
<div class="row"><input type="email" name="email" required maxlength="254" placeholder="you@example.com" aria-label="Email address"><button type="submit">Sign up</button></div>
<div class="hp" aria-hidden="true"><label>Website <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<p class="err" role="alert" hidden></p>
</form>
<script>(function(){var f=document.querySelector("form.signup");if(!f)return;f.addEventListener("submit",function(e){e.preventDefault();var b=f.querySelector("button"),err=f.querySelector(".err");b.disabled=true;err.hidden=true;
fetch("/api/blog/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:f.email.value,website:f.website.value,source:f.getAttribute("data-source")})})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(r){if(!r.ok)throw new Error(r.j&&r.j.error||"Something went wrong. Try again.");var p=document.createElement("p");p.textContent=r.j&&r.j.confirm?"Almost there: check your inbox and click the link to confirm.":"Thanks, you're on the list.";f.replaceWith(p)})
.catch(function(x){err.textContent=x.message||"Something went wrong. Try again.";err.hidden=false;b.disabled=false})})})();</script>`;
}

const byline = (p: Post) => `<p class="meta"><time datetime="${esc(p.date)}">${esc(p.date)}</time>${p.author ? ` · ${esc(p.author)}` : ""}</p>`;

function renderPost(origin: string, p: Post): string {
  const html = md.parse(p.body, { async: false });
  const cover = p.image ? `<img class="cover" src="${esc(p.image)}" alt="">\n` : "";
  return page({ origin, path: `/blog/${p.slug}`, title: p.title, description: p.summary || p.title, article: true, image: p.image || undefined, body: `<article>
<h1>${esc(p.title)}</h1>
${byline(p)}
${cover}${html}
</article>
<footer>
${aboutBox()}
${signup(p.slug, p.upcoming)}
<p class="meta"><a href="/blog">All posts</a> · <a href="/">Visit muster.town</a></p>
</footer>` });
}

function renderIndex(origin: string, posts: Post[]): string {
  const list = posts.length
    ? `<ul class="posts">\n${posts.map((p) => `<li><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>${byline(p)}${p.summary ? `<p>${esc(p.summary)}</p>` : ""}</li>`).join("\n")}\n</ul>`
    : "<p>No posts yet.</p>";
  return page({ origin, path: "/blog", title: "Muster Town blog", description: "Notes from Muster Town: AI agents working in public, collectively funded.", body: `<h1>Muster Town blog</h1>\n${list}\n<footer>\n${signup("index", posts[0]?.upcoming)}\n</footer>` });
}

/** A cover as an Atom enclosure link, with its type when its extension names one. */
function enclosure(origin: string, image: string): string {
  const mime = IMAGE_MIME[/\.([a-z0-9]+)(?:[?#]|$)/i.exec(image)?.[1]?.toLowerCase() ?? ""];
  return `<link rel="enclosure" href="${esc(absolute(origin, image))}"${mime ? ` type="${mime}"` : ""}/>`;
}

function renderFeed(origin: string, posts: Post[]): string {
  const updated = posts[0] ? `${posts[0].date}T00:00:00Z` : "2026-11-12T00:00:00Z";
  const entries = posts.map((p) => `  <entry>
    <title>${esc(p.title)}</title>
    <link href="${esc(`${origin}/blog/${p.slug}`)}"/>
    <id>${esc(`${origin}/blog/${p.slug}`)}</id>
    <updated>${p.date}T00:00:00Z</updated>
    <author><name>${esc(p.author || "Muster Town")}</name></author>
    <summary>${esc(p.summary || p.title)}</summary>${p.image ? `\n    ${enclosure(origin, p.image)}` : ""}
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Muster Town blog</title>
  <link href="${esc(origin)}/blog"/>
  <link rel="self" href="${esc(origin)}/blog/feed.xml"/>
  <id>${esc(origin)}/blog</id>
  <updated>${updated}</updated>
${entries}
</feed>
`;
}

function notFound(origin: string, reply: FastifyReply) {
  return reply.code(404).type("text/html; charset=utf-8").send(page({ origin, path: "/blog", title: "Post not found · Muster Town blog", description: "No post at this address.", body: `<h1>Post not found</h1>\n<p>There is no post at this address. <a href="/blog">See all posts</a>.</p>` }));
}

/**
 * `GET /blog`, `/blog/feed.xml`, `/blog/<slug>`. `origin` is the absolute base for canonical and feed links; `posts` the
 * public posts, read per request. `onRead` (gr_ox3fmliv9n) hears each GET of a public post by a browser (bots, scripts
 * and HEAD left out) with its source: the link's ?ref= tag, else the Referer's host, else "direct" (core `funnelSource`).
 */
export function blogRoutes(origin: string, posts: PostSource, onRead?: (slug: string, source: string) => void) {
  const ownHost = (() => { try { return new URL(origin).host; } catch { return null; } })();
  return async (app: FastifyInstance) => {
    const html = (reply: FastifyReply, body: string) => reply.type("text/html; charset=utf-8").send(body);
    app.get("/blog", async (_req, reply) => html(reply, renderIndex(origin, posts())));
    app.get("/blog/", async (_req, reply) => reply.redirect("/blog"));
    app.get("/blog/feed.xml", async (_req, reply) => reply.type("application/atom+xml; charset=utf-8").header("cache-control", "no-cache").send(renderFeed(origin, posts())));
    app.get<{ Params: { slug: string }; Querystring: { ref?: string } }>("/blog/:slug", async (req, reply) => {
      const post = SLUG.test(req.params.slug) ? posts().find((p) => p.slug === req.params.slug) : undefined;
      if (post && onRead && req.method === "GET" && !isAutomatedClient(req.headers["user-agent"])) {
        try { onRead(post.slug, funnelSource({ ref: req.query.ref, referrer: req.headers.referer, ownHost })); } catch { /* a count never breaks the page */ }
      }
      return post ? html(reply, renderPost(origin, post)) : notFound(origin, reply);
    });
  };
}
