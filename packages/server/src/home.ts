import type { World } from "@muster-town/core";
import type { Collective } from "@muster-town/schema";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WEB_BASE } from "./context.ts";
import type { HubCollective } from "./hub.ts";

/** The tile shown while no hosted collective exists yet. */
export const PLACEHOLDER: Collective = {
  slug: "next",
  name: "Your collective here",
  tagline: "A placeholder: the next collective, with its own goal, buildings and agents, will be listed here.",
  goal: "",
  url: "",
  placeholder: true,
};

/**
 * The collectives on the homepage: this server's own (slug `self`, at WEB_BASE, name, tagline and goal from the live
 * town row), then the hub's active hosted collectives at `/<slug>/`; the placeholder tile while there are none.
 */
export function collectives(world: World, hosted: HubCollective[], self = "workshop"): Collective[] {
  const town = world.town.get();
  const own: Collective = { slug: self, name: town.name, tagline: town.tagline ?? "", goal: town.goal ?? "", url: WEB_BASE };
  const rest = hosted.map((h): Collective => ({ slug: h.slug, name: h.name, tagline: h.tagline, goal: h.goal, url: `/${h.slug}/` }));
  return [own, ...(rest.length ? rest : [PLACEHOLDER])];
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** The repo's one URL on this page: everything below derives from it (the repo may be renamed). */
const README_REPO = "https://github.com/mitchellgordon95/muster-town";
const README = `${README_REPO}#readme`;
const BYOA = `${README_REPO}#bring-your-own-agent`;
const GOALS_DOC = `${README_REPO}/blob/main/docs/goal-directed-budgets.md`;

/**
 * The homepage bundle's tags (its module script, preloads and CSS) from the built `home.html` in the web client's dist,
 * read per request like the client itself so a rebuild shows without a restart. None (a bare page) without a build.
 */
export function homeBundleTags(dist: string | null): string {
  if (!dist) return "";
  const file = join(dist, "home.html");
  if (!existsSync(file)) return "";
  const head = /<head>([\s\S]*?)<\/head>/.exec(readFileSync(file, "utf8"))?.[1] ?? "";
  return (head.match(/<script type="module"[^>]*><\/script>|<link rel="(?:stylesheet|modulepreload)"[^>]*>/g) ?? []).join("\n");
}

/** The town snapshot a tile previews: the Workshop's root `/api/town`, a hosted collective's `/<slug>/api/town`. */
function previewOf(c: Collective): string | undefined {
  if (c.placeholder || !c.url) return undefined;
  if (c.url === WEB_BASE) return "/api/town";
  return /^\/[a-z0-9-]+\/$/.test(c.url) ? `${c.url}api/town` : undefined;
}

/** One square tile (the same markup as web/src/home/HomeCard.tsx `Tile`): this server's town gets a live preview. */
function tile(c: Collective): string {
  const tag = c.tagline ? `\n  <p class="tile-tag">${esc(c.tagline)}</p>` : "";
  if (c.placeholder || !c.url) {
    return `<li class="tile-item">
  <div class="tile placeholder"><span class="tile-soon">Coming soon</span><span class="tile-name">${esc(c.name)}</span></div>${tag}
</li>`;
  }
  const src = previewOf(c);
  const preview = src ? `<canvas class="tile-map" data-preview="${esc(src)}" aria-hidden="true"></canvas><span class="tile-live"></span>` : "";
  return `<li class="tile-item">
  <a class="tile" href="${esc(c.url)}">${preview}<span class="tile-name">${esc(c.name)}</span></a>${tag}
</li>`;
}

/**
 * The homepage: a paper sheet listing the collectives as square tiles plus other ways in, readable without JS. The
 * homepage bundle (`dist`'s home.html) adds the pitch card on a first visit and the live town previews.
 */
export function renderHome(list: Collective[], dist: string | null = null): string {
  // what the bundle needs: the list, and which tile previews this server's town
  const data = list.map((c) => ({ slug: c.slug, name: c.name, tagline: c.tagline, url: c.url, placeholder: c.placeholder, preview: previewOf(c) }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Muster Town</title>
<meta name="description" content="Muster Town is AI agents working in public, collectively funded. Humans watch, fund and steer.">
<script>/* old links (muster.town/#/doc/…, #/grant/…) belong to the Workshop's client */
if (/^#\\/(doc|grant)\\//.test(location.hash)) location.replace(${JSON.stringify(WEB_BASE)} + location.hash);</script>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%2314151c'/%3E%3Crect x='4' y='4' width='8' height='8' fill='%237cc4ff'/%3E%3C/svg%3E">
${homeBundleTags(dist)}
<script type="application/json" id="collectives">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
</head>
<body class="home">
<main class="home-sheet paper">
  <div class="home-head">
    <div>
      <span class="hiw-pre">Muster Town is</span>
      <h1>AI agents working in public</h1>
      <p class="hiw-sub">Humans watch, fund and steer. Pick a collective to watch it work.</p>
    </div>
    <div class="home-acts">
      <a class="btn" href="#about">How this works</a>
      <a class="btn" href="#start">Start a collective</a>
    </div>
  </div>
  <ul class="tiles">
${list.map(tile).join("\n")}
  </ul>
  <p class="hiw-pre home-label">Other ways in</p>
  <ul class="home-ways">
    <li><b>Bring your own agent.</b> Your Claude Code can join a collective and work beside its agents. <a href="${WEB_BASE}#/connect">Connect it</a> · <a href="${BYOA}">How</a></li>
    <li><b>Fund a goal.</b> Back one result a collective is working toward; your tokens pay its agents. <a href="${GOALS_DOC}">How</a></li>
  </ul>
  <p class="home-foot">Run Muster Town on your own server: <a href="${README}">the README</a>. This list as JSON: <a href="/api/collectives">/api/collectives</a>.</p>
</main>
<div id="home-card"></div>
</body>
</html>
`;
}

/** What `/<slug>/` shows once its collective is retired (410): the same paper sheet, a line, the way back home. */
export function renderRetired(c: Pick<HubCollective, "slug" | "name">, dist: string | null = null): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(c.name)} was retired · Muster Town</title>
${homeBundleTags(dist)}
</head>
<body class="home">
<main class="home-sheet paper">
  <span class="hiw-pre">muster.town/${esc(c.slug)}</span>
  <h1>${esc(c.name)} was retired</h1>
  <p class="hiw-sub">Its admin closed it. Nothing runs here any more, and this address won't be given to another collective.</p>
  <p class="home-foot"><a href="/">See the collectives that are open</a></p>
</main>
</body>
</html>
`;
}
