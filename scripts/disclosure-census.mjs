#!/usr/bin/env node
/**
 * Disclosure census (goal gl_1ds3wl2n78, grant gr_zak30564zh, kr_p6l1w6tade): open every panel and every tab of it at
 * 1280×800 and 390×844 (touch) and count what its first screen shows, against the progressive-disclosure bar
 * (findings dc_j5ejqhvl9e): first screen ≤12 controls and ≤200 words, the whole panel ≤3 screens as it opens (collapsed).
 *
 * Two modes:
 *   mock  every panel kind, signed in as the mock admin, through the dev-only `window.__muster.open`. Start the mock first:
 *           (cd packages/web && VITE_MOCK=1 npx vite --port 5199)
 *           node scripts/disclosure-census.mjs mock [http://localhost:5199/workshop/]
 *   live  a live town as a guest, through the hash routes a guest can open (route.ts): #/grant, #/doc, #/building,
 *         #/agent, #/meeting, #/assignment, #/session, #/kr, #/manual, #/connect, #/bank. The ids come from the town's API,
 *         plus any --grants=gr_a,gr_b and --docs=dc_a,dc_b you name.
 *           node scripts/disclosure-census.mjs live [https://muster.town/workshop/] [--grants=…] [--docs=…]
 * Options: --sizes=laptop,phone (default both), --json (rows as JSON), --shots=<dir> (a screenshot of each panel's first tab).
 *
 * One row per panel/tab per size: ctl (controls on the first screen: buttons, links, inputs, selects, textareas, tabs,
 * summaries), ctl total (in the whole panel), words (words on the first screen), words total (in the whole panel), screens (panel body scroll height /
 * its visible height) and the verdict: pass, FAIL (with which limits it breaks) or excluded. The Bank (Bank Transparency's
 * own grant) and document bodies (a report or the manual: their length is the author's, not the chrome's) are excluded, not failed; their
 * numbers still print. A panel that didn't open prints "no panel".
 *
 * No dependencies in the repo: point PLAYWRIGHT at an installed playwright-core and CHROMIUM at a browser.
 *   mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright-core@1)
 */
import fs from "node:fs";

const args = process.argv.slice(2);
const flags = Object.fromEntries(args.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const [mode = "mock", urlArg] = args.filter((a) => !a.startsWith("--"));
if (mode !== "mock" && mode !== "live") { console.error("usage: disclosure-census.mjs mock|live [url] [--sizes=laptop,phone] [--json] [--shots=dir]"); process.exit(2); }
const url = urlArg ?? (mode === "mock" ? "http://localhost:5199/workshop/" : "https://muster.town/workshop/");
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/tmp/pw/node_modules/playwright-core/index.mjs");
const list = (s) => (typeof s === "string" ? s.split(",").filter(Boolean) : []);
if (flags.shots) fs.mkdirSync(flags.shots, { recursive: true });

const BAR = { ctl: 12, words: 200, screens: 3 };
const SIZES = [{ n: "laptop", w: 1280, h: 800, touch: false }, { n: "phone", w: 390, h: 844, touch: true }]
  .filter((s) => !flags.sizes || list(flags.sizes).includes(s.n));

/** Why a panel is out of the census, or null. */
const excluded = (t) => t.kind === "bank" ? "the Bank: Bank Transparency's grant" : (t.kind === "library" && t.docId) || t.kind === "manual" ? "document body" : null;

// ---- targets ----
let targets;
if (mode === "mock") {
  // every PanelKind (state.ts) on the mock fixture's ids; `admin` is the old name for `planning`
  targets = [
    { kind: "agent", id: "ag_noor" }, { kind: "agent", id: "ag_keel" }, { kind: "building", id: "bl_carbon" }, { kind: "building", id: "bl_townhall" },
    { kind: "library" }, { kind: "library", docId: "dc_noor_r2" }, { kind: "meeting", id: "mt_town1" },
    { kind: "intray", id: "bl_carbon" }, { kind: "intray", id: "bl_townhall" }, { kind: "board", id: "bl_carbon" }, { kind: "cabinet", id: "bl_carbon" },
    { kind: "planning" }, { kind: "schedule", id: "bl_carbon" }, { kind: "mod" }, { kind: "grant", id: "gr_ocean" }, { kind: "grant", id: "gr_stress" },
    { kind: "assignment", id: "as_noor2" }, { kind: "session", id: "se_fork1" }, { kind: "manual" }, { kind: "stats" }, { kind: "help", id: "bl_carbon" },
    { kind: "goals" }, { kind: "goals", id: "gl_join" }, { kind: "outbox" }, { kind: "connect" }, { kind: "bank" },
  ];
} else {
  const origin = new URL(url).origin;
  const api = async (p) => { try { const r = await fetch(origin + p); return r.ok ? r.json() : {}; } catch { return {}; } };
  const town = await api("/api/town");
  const bl = (town.buildings ?? []).find((b) => /^bl_/.test(b.id));
  const mgr = (town.agents ?? []).find((a) => a.kind === "resident" && !a.forkOf && (town.buildings ?? []).some((b) => b.managerAgentId === a.id && b.id !== "town-hall"));
  const reports = (await api("/api/docs?type=report&limit=1")).docs ?? [];
  const meetings = [...((await api("/api/meetings")).meetings ?? []), ...(town.meetings ?? [])];
  const grants = [...new Set(["gr_ukrou4zjha", "gr_567tikzitl", "gr_zak30564zh", ...list(flags.grants)])];
  const docs = [...new Set(["dc_o0565x7thv", ...list(flags.docs), ...reports.map((d) => d.id)])];
  targets = [
    ...grants.map((id) => ({ kind: "grant", id })), ...docs.map((docId) => ({ kind: "library", docId })),
    ...(bl ? [{ kind: "building", id: bl.id }] : []), ...(mgr ? [{ kind: "agent", id: mgr.id }] : []),
    ...(meetings[0] ? [{ kind: "meeting", id: meetings[0].id }] : []),
    ...list(flags.assignments).map((id) => ({ kind: "assignment", id })), ...list(flags.sessions).map((id) => ({ kind: "session", id })),
    ...list(flags.krs).map((id) => ({ kind: "kr", id })),
    { kind: "manual" }, { kind: "connect" }, { kind: "bank" },
  ];
}
const hashOf = (t) => t.kind === "library" ? `#/doc/${t.docId}` : t.id ? `#/${t.kind}/${t.id}` : `#/${t.kind}`;
const label = (t) => t.kind + (t.id ? ":" + t.id : "") + (t.docId ? ":" + t.docId : "");

// ---- measuring ----
/**
 * Where the open panel is: the side panel (aside.panel), or a sheet over the map: the goal tree (.ge; its `part` "detail" is the
 * selected goal's pane, .ge-detail), the manual and help cards (.paper), the Bank (.bank-sheet). Marked data-census for the tab locator.
 */
const measure = (page, part) => page.evaluate((part) => {
  document.querySelectorAll("[data-census]").forEach((el) => el.removeAttribute("data-census"));
  let panel = document.querySelector("aside.panel") ?? document.querySelector(".ge") ?? document.querySelector(".paper.manual") ?? document.querySelector(".bank-sheet");
  if (panel && part === "detail") panel = panel.querySelector(".ge-detail");
  if (!panel) return null;
  panel.setAttribute("data-census", "");
  const pr = panel.getBoundingClientRect();
  const top = Math.max(0, pr.top), bottom = Math.min(innerHeight, pr.bottom);
  const shown = (el) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && r.bottom > top && r.top < bottom;
  };
  const ctrls = [...panel.querySelectorAll("button,input,select,textarea,a[href],[role=tab],summary")].filter((el) => el.getClientRects().length);
  let words = 0, total = 0;
  const tw = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const n = tw.currentNode; const k = (n.textContent.match(/\S+/g) ?? []).length;
    if (!k || !n.parentElement || !n.parentElement.getClientRects().length) continue;
    total += k; if (shown(n.parentElement)) words += k;
  }
  // screens: the tallest scroller in the panel (itself or a scrolling box inside it, at least 120 px tall)
  const scrollers = [panel, ...panel.querySelectorAll("*")].filter((el) => el === panel || (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.clientHeight >= 120));
  const screens = Math.max(1, ...scrollers.map((el) => el.scrollHeight / Math.max(1, el.clientHeight)));
  return { ctl: ctrls.filter(shown).length, ctlAll: ctrls.length, words, total, screens: +screens.toFixed(1) };
}, part);

const verdict = (t, m) => {
  if (!m) return "no panel";
  const ex = excluded(t); if (ex) return `excluded (${ex})`;
  const why = [m.ctl > BAR.ctl && `ctl>${BAR.ctl}`, m.words > BAR.words && `words>${BAR.words}`, m.screens > BAR.screens && `screens>${BAR.screens}`].filter(Boolean);
  return why.length ? `FAIL ${why.join(" ")}` : "pass";
};

// ---- run ----
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium" });
const rows = [];
for (const size of SIZES) {
  const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch });
  const page = await ctx.newPage();
  const settle = (ms) => page.waitForTimeout(ms);
  const open = async (t) => {
    if (mode === "mock") { await page.evaluate((x) => window.__muster.open(x), t); await settle(900); return; }
    // a fresh load per target: a hash-only goto keeps the page, and sheets (the goal tree) stay open over the next panel
    await page.goto("about:blank");
    await page.goto(url + (url.includes("?") ? "&" : "?") + "guest" + hashOf(t), { waitUntil: "load" }); await settle(4500);
  };
  if (mode === "mock") {
    await page.goto(url, { waitUntil: "load" }); await settle(2500);
    for (const name of ["Explore the town", "Skip"]) { const x = page.getByText(name).first(); if (await x.isVisible().catch(() => false)) { await x.click().catch(() => {}); await settle(800); } }
    if (!(await page.evaluate(() => !!window.__muster))) { console.error("no window.__muster: is this a dev (vite) mock build?"); process.exit(1); }
  }
  for (const t of targets) {
    await open(t);
    await measure(page); // marks the panel for the tab locator
    const tabs = page.locator("[data-census] [role=tab]");
    const names = await tabs.evaluateAll((els) => els.map((e) => e.textContent.trim()));
    for (const [i, tab] of (names.length ? names : [null]).entries()) {
      if (i > 0) { await tabs.nth(i).click().catch(() => {}); await settle(mode === "live" ? 2000 : 600); }
      const m = await measure(page);
      rows.push({ size: `${size.w}×${size.h}`, panel: label(t), tab, ...(m ?? {}), verdict: verdict(t, m) });
      // the goal tree is a sheet with the tree beside the selected goal: its detail pane gets its own row (kr_3jie8qwdt6)
      if (t.kind === "goals" || t.kind === "kr") { const d = await measure(page, "detail"); if (d) rows.push({ size: `${size.w}×${size.h}`, panel: label(t), tab: "(selected goal's detail)", ...d, verdict: verdict(t, d) }); }
      if (i === 0 && flags.shots) await page.screenshot({ path: `${flags.shots}/${size.n}-${label(t).replace(/[:/]/g, "_")}.png` }).catch(() => {});
    }
    if (mode === "mock") await page.evaluate(() => window.__muster.open(null));
  }
  await ctx.close();
}
await browser.close();

if (flags.json) console.log(JSON.stringify(rows, null, 1));
else {
  console.log(`Disclosure census, ${mode} ${url}; bar: first screen ≤${BAR.ctl} controls and ≤${BAR.words} words, ≤${BAR.screens} screens collapsed`);
  console.log("| size | panel | tab | ctl | ctl total | words | words total | screens | verdict |\n|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.size} | ${r.panel} | ${r.tab ?? ""} | ${r.ctl ?? ""} | ${r.ctlAll ?? ""} | ${r.words ?? ""} | ${r.total ?? ""} | ${r.screens ?? ""} | ${r.verdict} |`);
  const counted = rows.filter((r) => r.verdict === "pass" || r.verdict.startsWith("FAIL"));
  console.log(`\n${counted.filter((r) => r.verdict === "pass").length} of ${counted.length} rows pass; ${rows.length - counted.length} excluded or not opened.`);
}
