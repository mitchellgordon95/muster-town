#!/usr/bin/env node
/**
 * Disclosure census (goal gl_1ds3wl2n78, grant gr_zak30564zh, kr_p6l1w6tade): open every panel and every tab of it at
 * 1280×800 and 390×844 (touch) and count what its first screen shows, against the progressive-disclosure bar
 * (findings dc_j5ejqhvl9e): first screen ≤12 controls and ≤200 words; the whole panel ≤3 screens as it opens is reported.
 *
 * Two modes:
 *   mock  every panel kind, signed in as the mock admin, through the dev-only `window.__muster.open`. Start the mock first:
 *           (cd packages/web && VITE_MOCK=1 npx vite --port 5199)
 *           node scripts/disclosure-census.mjs mock [http://localhost:5199/workshop/]
 *   live  a live town as a guest, through the hash routes a guest can open (route.ts): #/grant, #/doc, #/building,
 *         #/agent, #/meeting, #/assignment, #/session, #/kr, #/manual, #/connect, #/bank. The ids come from the town's API,
 *         plus any --grants=gr_a,gr_b and --docs=dc_a,dc_b you name.
 *           node scripts/disclosure-census.mjs live [https://muster.town/workshop/] [--grants=…] [--docs=…] [--buildings=…] [--agents=…]
 * The verdict is kr_p6l1w6tade's bar: first screen ≤12 controls and ≤200 words. Screens (>3 as it opens) print as a
 * "long" note on the row, not a fail: a list that scrolls is fine when its first screen is a summary.
 *
 * Decision (step 4, as_daweqw8v78): the goal tree's canvas is a map, like the pixel map. Its cards are a zoomed-out
 * picture of the tree (10–21% zoom on live: their words are not readable text) and its toolbar is map chrome, so the
 * whole-sheet row of `goals` / `kr` is excluded and only the selected goal's detail pane (.sheet-side) is measured
 * against the bar. Showing desk steppers only on the selected card would cut controls but not the card words, so
 * the sheet would fail on words either way.
 *
 * Decision (step 4): a meeting's transcript is its speakers' words, like a report's body: words inside .transcript are
 * not counted, nor the links inside its lines (step 5: also an agent's Talk timeline, .chat.timeline). Every line shows, opened at the latest (Mitchell, 1:1 mt_pr3347g2w2: chat is never folded).
 *
 * Decision (step 5, as_hp1g7x0slm): since gr_4csjpgh346 a grant or agent opened by link or hash is a centred link sheet
 * (.sheet.link-sheet): it counts like the side panel. A doc opened from the library, an in-tray or a filing cabinet is a
 * centred doc sheet (.sheet.doc-sheet): a document body, excluded. In-trays and cabinets are measured as their sidebar list.
 *
 * Goal-tree readability (grant gr_nhayb7s9bd, kr_vdvagvpm47): the goal tree's sheet also gets a "(goal titles on the first screen)"
 * row: how many goal titles show on its first screen (canvas boxes .gc-text inside the canvas viewport, or the phone outline's
 * rows .go-text) and the smallest of their on-screen sizes (computed font size × the canvas zoom). It passes at 11 px or more.
 *
 * The decision queue (.sheet.queue-sheet, the hydrant) is a target too: mock opens it with open({kind: "queue"}), live with #/queue.
 * Live also opens the goal tree at its root with #/goals. Its front ask card's title, body and recommendation are the asker's words, like a
 * doc body (decision as_5spvwexh1o on dc_9u3s34jwd3): not counted on the first screen; words total keeps them and the verdict says how many.
 *
 * Ask-card row (grant gr_x7p580xe1o: kr_2grnxy8ig7, kr_g3qtv4vbsb, kr_6jxbastxzt): when the queue is a target, the census also opens
 * #/queue (mock: open({kind: "queue"})) at 1366×800 and 390×844 and presses J through every item, one row per ask card: body
 * font-weight, bold blocks (the lead .ask-delta and any bold paragraph in the body; at most 1), the most characters on one line
 * (character rects grouped by line, over the lead, recommendation and body), the top of the recommendation, and the decision row
 * (.ask-actions: buttons, or Sign in to decide): it must be the card's last block, the only one, and hold every button on the card
 * (Mitchell, 1:1 mt_gf4un6ct4p: the buttons go in one row at the bottom, below all text; "If you <branch>:" stays in the body).
 * Passes at 1366: weight 400, ≤1 bold block, row at the bottom; at 390: row at the bottom. Chars/line and the recommendation's top are
 * informational: the card keeps its old width and order, the recommendation after the body (Mitchell, 1:1 mt_eq521xwgth: only the bold went).
 *
 * Options: --sizes=laptop,phone (default both), --only=goals,kr (just those panel kinds), --json (rows as JSON), --shots=<dir> (a screenshot of each panel's first tab).
 *
 * One row per panel/tab per size: ctl (controls on the first screen: buttons, links, inputs, selects, textareas, tabs,
 * summaries), ctl total (in the whole panel as it opens: what a closed <details> hides is not counted), words (words on the first screen), words total (in the whole panel as it opens), screens (panel body scroll height /
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

const BAR = { ctl: 12, words: 200, screens: 3, titlePx: 11 };
const SIZES = [{ n: "laptop", w: 1280, h: 800, touch: false }, { n: "phone", w: 390, h: 844, touch: true }]
  .filter((s) => !flags.sizes || list(flags.sizes).includes(s.n));

/** Why a panel is out of the census, or null. */
const excluded = (t, part, m) => m?.docSheet ? "document body: an open doc sheet" : (t.kind === "goals" || t.kind === "kr") && part !== "detail" ? "map: the goal tree canvas; its detail row counts" : t.kind === "bank" ? "the Bank: Bank Transparency's grant" : (t.kind === "library" && t.docId) || t.kind === "manual" ? "document body" : null;

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
    { kind: "goals" }, { kind: "goals", id: "gl_join" }, { kind: "outbox" }, { kind: "connect" }, { kind: "bank" }, { kind: "queue" },
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
    ...[...new Set([...(bl ? [bl.id] : []), ...list(flags.buildings)])].map((id) => ({ kind: "building", id })),
    ...[...new Set([...(mgr ? [mgr.id] : []), ...list(flags.agents)])].map((id) => ({ kind: "agent", id })),
    ...(meetings[0] ? [{ kind: "meeting", id: meetings[0].id }] : []),
    ...list(flags.assignments).map((id) => ({ kind: "assignment", id })), ...list(flags.sessions).map((id) => ({ kind: "session", id })),
    ...[...new Set(["kr_p6l1w6tade", ...list(flags.krs)])].map((id) => ({ kind: "kr", id })),
    { kind: "goals" }, { kind: "queue" }, { kind: "manual" }, { kind: "connect" }, { kind: "bank" },
  ];
}
// --only=goals,kr keeps just those panel kinds (one panel's before/after without the whole ~3 min run)
if (flags.only) targets = targets.filter((t) => list(flags.only).includes(t.kind));
const hashOf = (t) => t.kind === "library" ? `#/doc/${t.docId}` : t.id ? `#/${t.kind}/${t.id}` : `#/${t.kind}`;
const label = (t) => t.kind + (t.id ? ":" + t.id : "") + (t.docId ? ":" + t.docId : "");

// ---- measuring ----
/**
 * Where the open panel is: the side panel (aside.panel), or a sheet over the map: the goal tree (.sheet.goal-sheet; its `part` "detail" is the
 * selected goal's pane, .sheet-side), the decision queue (.sheet.queue-sheet, over the Secretary's 1:1 in the side panel), the manual and help cards (.paper), the Bank (.sheet[aria-label="The Bank"]). Marked data-census for the tab locator.
 */
const measure = (page, part) => page.evaluate((part) => {
  document.querySelectorAll("[data-census]").forEach((el) => el.removeAttribute("data-census"));
  // a link sheet (a grant or an agent opened from a link or a hash, gr_4csjpgh346 step 3) sits over any side panel: it is the panel;
  // a doc sheet (a report, a rollup, an in-tray or cabinet item opened from its list) is a document body (excluded)
  let panel = document.querySelector(".sheet.link-sheet") ?? document.querySelector(".sheet.doc-sheet") ?? document.querySelector(".sheet.queue-sheet") ?? document.querySelector("aside.panel") ?? document.querySelector(".sheet.goal-sheet") ?? document.querySelector(".paper.manual") ?? document.querySelector('.sheet[aria-label="The Bank"]');
  if (panel && part === "detail") panel = panel.querySelector(".sheet-side");
  if (!panel) return null;
  panel.setAttribute("data-census", "");
  const pr = panel.getBoundingClientRect();
  const top = Math.max(0, pr.top), bottom = Math.min(innerHeight, pr.bottom);
  // inside a closed <details> (all but its summary) Chromium still gives boxes, under content-visibility: hidden
  const folded = (el) => {
    for (let d = el.closest("details:not([open])"); d; d = d.parentElement?.closest("details:not([open])")) {
      const s = el.closest("summary");
      if (!(s && s.parentElement === d)) return true;
    }
    return false;
  };
  const shown = (el) => {
    if (folded(el)) return false;
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && r.bottom > top && r.top < bottom;
  };
  // chat (a meeting's transcript, an agent's Talk timeline) is never folded (Mitchell, 1:1 mt_pr3347g2w2): its lines are the
  // speakers', like a report's body, so its words and the links inside its lines are not counted; the panel's own controls are
  const CHAT = ".transcript, .chat.timeline";
  // Decision (as_5spvwexh1o, on dc_9u3s34jwd3): the decision queue's front ask card is its author's words, like a doc body: its title,
  // body and recommendation are not counted on the first screen (labels, branches, buttons and the queue's own lines are); words total keeps them
  const CARD = ".queue-sheet .ask-card :is(.ask-title, .ask-delta, .ask-body, .ask-rec)";
  const card = (el) => !!el.closest(CARD) && !el.closest(".ask-label");
  const ctrls = [...panel.querySelectorAll("button,input,select,textarea,a[href],[role=tab],summary")].filter((el) => el.getClientRects().length && !folded(el) && !el.closest(CHAT));
  let words = 0, total = 0, cardWords = 0;
  const tw = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
  while (tw.nextNode()) {
    const n = tw.currentNode; const k = (n.textContent.match(/\S+/g) ?? []).length;
    if (!k || !n.parentElement || !n.parentElement.getClientRects().length || folded(n.parentElement) || n.parentElement.closest(CHAT)) continue;
    total += k;
    if (card(n.parentElement)) cardWords += k; else if (shown(n.parentElement)) words += k;
  }
  // screens: the tallest scroller in the panel (itself or a scrolling box inside it, at least 120 px tall)
  const scrollers = [panel, ...panel.querySelectorAll("*")].filter((el) => el === panel || (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.clientHeight >= 120));
  const screens = Math.max(1, ...scrollers.map((el) => el.scrollHeight / Math.max(1, el.clientHeight)));
  return { docSheet: panel.matches(".sheet.doc-sheet"), ctl: ctrls.filter(shown).length, ctlAll: ctrls.length, words, total, cardWords, screens: +screens.toFixed(1) };
}, part);

/**
 * The goal tree's first screen (kr_vdvagvpm47): the goal titles shown inside the canvas viewport (.gc) or the outline (.go-tree),
 * and the smallest on-screen size among them: the computed font size times the canvas zoom (the .gc-stage scale).
 */
const measureTitles = (page) => page.evaluate(() => {
  const sheet = document.querySelector(".sheet.goal-sheet");
  if (!sheet) return null;
  const outline = sheet.querySelector(".go-tree");
  const frame = (outline ?? sheet.querySelector(".gc"))?.getBoundingClientRect();
  if (!frame) return null;
  const top = Math.max(0, frame.top), bottom = Math.min(innerHeight, frame.bottom), left = Math.max(0, frame.left), right = Math.min(innerWidth, frame.right);
  // the canvas zoom is the stage's scale (the outline is not zoomed); a box's own height is rounded to whole px, so not that
  const stage = outline ? null : sheet.querySelector(".gc-stage");
  const zoom = stage ? new DOMMatrix(getComputedStyle(stage).transform).a : 1;
  const sizes = [...sheet.querySelectorAll(outline ? ".go-row .go-text" : ".gc-box .gc-text")].flatMap((el) => {
    const r = el.getBoundingClientRect();
    if (!r.height || getComputedStyle(el).visibility === "hidden" || r.bottom <= top || r.top >= bottom || r.right <= left || r.left >= right) return [];
    return [parseFloat(getComputedStyle(el).fontSize) * zoom];
  });
  return { view: outline ? "outline" : "canvas", titles: sizes.length, minPx: sizes.length ? +Math.min(...sizes).toFixed(1) : null };
});

const verdict = (t, m, part) => {
  if (!m) return "no panel";
  const ex = excluded(t, part, m); if (ex) return `excluded (${ex})`;
  const why = [m.ctl > BAR.ctl && `ctl>${BAR.ctl}`, m.words > BAR.words && `words>${BAR.words}`].filter(Boolean);
  const long = m.screens > BAR.screens ? ` (long: ${m.screens} screens)` : "";
  const ask = m.cardWords ? ` (${m.cardWords} of ${m.total} words total are the front ask card's, not counted on the first screen)` : "";
  return (why.length ? `FAIL ${why.join(" ")}` : "pass") + long + ask;
};

/** The front ask card in the queue (the ask-card row): see the header. */
const measureAsk = (page) => page.evaluate(() => {
  const c = document.querySelector(".queue-sheet .ask-card, .ask-card");
  if (!c) return null;
  const cs = (e) => getComputedStyle(e);
  const lines = (e) => {
    const out = new Map(); const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let n;
    while ((n = w.nextNode())) for (let i = 0; i < n.length; i++) {
      if (/\s/.test(n.data[i])) continue;
      const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); const rc = r.getClientRects()[0]; if (!rc) continue;
      const k = Math.round(rc.top + rc.height / 2); const o = out.get(k) ?? { l: rc.left, r: rc.right };
      out.set(k, { l: Math.min(o.l, rc.left), r: Math.max(o.r, rc.right) });
    }
    return [...out.values()];
  };
  const parts = [...c.querySelectorAll(".ask-delta, .ask-rec, .ask-body")];
  let maxChars = 0;
  for (const e of parts) {
    const text = e.textContent ?? ""; if (!text.trim()) continue;
    const ls = lines(e); if (!ls.length) continue;
    // characters on a line: its span over the element's average advance (its laid-out width over its characters, spaces included)
    const span = ls.reduce((a, x) => a + (x.r - x.l), 0); const chars = text.replace(/\s+/g, " ").trim().length;
    const adv = span / Math.max(1, chars);
    for (const x of ls) maxChars = Math.max(maxChars, Math.round((x.r - x.l) / adv));
  }
  const body = c.querySelector(".ask-body"), lead = c.querySelector(".ask-delta"), rec = c.querySelector(".ask-rec"), row = c.querySelector(".ask-actions");
  const bodyBlocks = body ? [...body.querySelectorAll("p, li")] : [];
  const bold = (lead && +cs(lead).fontWeight >= 600 ? 1 : 0) + bodyBlocks.filter((b) => +cs(b).fontWeight >= 600 || (b.textContent.trim() && [...b.querySelectorAll("strong, b")].reduce((a, s) => a + s.textContent.length, 0) >= b.textContent.trim().length * 0.8)).length;
  // the decision row is the card's one row of buttons, last on the card: every button inside it, nothing laid out below it
  const rows = c.querySelectorAll(".ask-actions");
  const rowBottom = row ? row.getBoundingClientRect().top : 0;
  const below = row ? [...c.children].filter((e) => e !== row && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().top >= rowBottom).length : 0;
  const loose = row ? [...c.querySelectorAll("button")].filter((b) => !row.contains(b)).length : c.querySelectorAll("button").length;
  return { title: c.querySelector(".ask-title")?.textContent?.trim() ?? "", weight: body ? +cs(body).fontWeight : lead ? 400 : null, bold, maxChars,
    recTop: rec ? Math.round(rec.getBoundingClientRect().top) : null, rowTop: row ? Math.round(row.getBoundingClientRect().top) : null,
    rowLast: rows.length === 1 && c.lastElementChild === row && below === 0, loose };
});

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
      if (t.kind === "goals" || t.kind === "kr") { const d = await measure(page, "detail"); if (d) rows.push({ size: `${size.w}×${size.h}`, panel: label(t), tab: "(selected goal's detail)", ...d, verdict: verdict(t, d, "detail") }); }
      // its first screen's goal titles: readable at 11 px or more (kr_vdvagvpm47)
      if (t.kind === "goals" && i === 0) {
        const g = await measureTitles(page);
        rows.push({ size: `${size.w}×${size.h}`, panel: label(t), tab: `(goal titles on the first screen${g ? `, ${g.view}` : ""})`, titles: g?.titles, minPx: g?.minPx,
          verdict: !g || !g.titles ? "no titles" : g.minPx >= BAR.titlePx ? "pass" : `FAIL title<${BAR.titlePx}px` });
      }
      if (i === 0 && flags.shots) await page.screenshot({ path: `${flags.shots}/${size.n}-${label(t).replace(/[:/]/g, "_")}.png` }).catch(() => {});
    }
    // close the side panel and any link or doc sheet (store.sheet), which a side panel's open(null) leaves up
    if (mode === "mock") await page.evaluate(() => { window.__muster.open(null); window.__muster.openSheet?.(null); });
  }
  await ctx.close();
}
// the ask-card row: every item of the queue, J by J, at 1366×800 and 390×844 (kr_2grnxy8ig7, kr_g3qtv4vbsb, kr_6jxbastxzt)
const askRows = [];
if (targets.some((t) => t.kind === "queue")) {
  for (const size of [{ n: "laptop", w: 1366, h: 800, touch: false }, { n: "phone", w: 390, h: 844, touch: true }].filter((s) => !flags.sizes || list(flags.sizes).includes(s.n))) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, hasTouch: size.touch, isMobile: size.touch });
    const page = await ctx.newPage();
    if (mode === "mock") {
      await page.goto(url, { waitUntil: "load" }); await page.waitForTimeout(2500);
      for (const name of ["Explore the town", "Skip"]) { const x = page.getByText(name).first(); if (await x.isVisible().catch(() => false)) { await x.click().catch(() => {}); await page.waitForTimeout(800); } }
      await page.evaluate(() => window.__muster.open({ kind: "queue" })); await page.waitForTimeout(1200);
    } else { await page.goto(url + (url.includes("?") ? "&" : "?") + "guest#/queue", { waitUntil: "load" }); await page.waitForTimeout(4500); }
    const seen = new Set(); let misses = 0;
    for (let k = 0; k < 60 && misses < 5; k++) {
      const m = await measureAsk(page);
      const key = m?.title ?? `(not an ask ${k})`;
      if (m && seen.has(key)) break;
      if (!m) misses++;
      else {
        misses = 0; seen.add(key);
        const why = size.n === "laptop"
          ? [m.weight !== 400 && `weight ${m.weight}`, m.bold > 1 && `bold ${m.bold}`, !m.rowLast && "decision row not last", m.loose && `${m.loose} button(s) outside the row`].filter(Boolean)
          : [!m.rowLast && "decision row not last", m.loose && `${m.loose} button(s) outside the row`].filter(Boolean);
        askRows.push({ size: `${size.w}×${size.h}`, ...m, verdict: why.length ? `FAIL ${why.join(", ")}` : "pass" });
        if (flags.shots && askRows.filter((r) => r.size === `${size.w}×${size.h}`).length === 1) await page.screenshot({ path: `${flags.shots}/askcard-${size.n}.png` }).catch(() => {});
      }
      await page.keyboard.press("j"); await page.waitForTimeout(mode === "live" ? 900 : 400);
    }
    await ctx.close();
  }
}
await browser.close();

if (flags.json) console.log(JSON.stringify({ rows, askRows }, null, 1));
else {
  console.log(`Disclosure census, ${mode} ${url}; bar: first screen ≤${BAR.ctl} controls and ≤${BAR.words} words (over ${BAR.screens} screens is noted as long)`);
  console.log("In-trays and filing cabinets are measured as their sidebar list; an item opened from them is a centred doc sheet, a document body (excluded, like the Bank). Grants and agents opened by link or hash are centred link sheets and count.");
  console.log(`The goal tree's title row: goal titles on its first screen and the smallest on-screen title size (pass at ${BAR.titlePx} px or more).`);
  console.log("| size | panel | tab | ctl | ctl total | words | words total | screens | titles | min title px | verdict |\n|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.size} | ${r.panel} | ${r.tab ?? ""} | ${r.ctl ?? ""} | ${r.ctlAll ?? ""} | ${r.words ?? ""} | ${r.total ?? ""} | ${r.screens ?? ""} | ${r.titles ?? ""} | ${r.minPx ?? ""} | ${r.verdict} |`);
  const counted = rows.filter((r) => r.verdict.startsWith("pass") || r.verdict.startsWith("FAIL"));
  console.log(`\n${counted.filter((r) => r.verdict.startsWith("pass")).length} of ${counted.length} rows pass; ${rows.length - counted.length} excluded or not opened.`);
  if (targets.some((t) => t.kind === "queue")) {
    console.log("\nAsk-card row: every ask card in #/queue, J by J. Pass at 1366: body weight 400, ≤1 bold block, decision row last with every button in it; at 390: decision row last with every button in it. Chars/line and rec top are informational.");
    console.log("| size | ask | body weight | bold blocks | max chars/line | rec top | decision row top | row last | buttons outside row | verdict |\n|---|---|---|---|---|---|---|---|---|---|");
    for (const r of askRows) console.log(`| ${r.size} | ${r.title.slice(0, 60)} | ${r.weight ?? ""} | ${r.bold} | ${r.maxChars} | ${r.recTop ?? ""} | ${r.rowTop ?? ""} | ${r.rowLast ? "yes" : "no"} | ${r.loose} | ${r.verdict} |`);
    console.log(`\n${askRows.filter((r) => r.verdict === "pass").length} of ${askRows.length} ask-card rows pass${askRows.length ? "" : " (no open ask: the queue is empty)"}.`);
  }
}
