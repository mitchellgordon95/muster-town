/**
 * A doc of type "page" (grant gr_4csjpgh346 kr_pm0fmsiaxs; Mitchell in 1:1 mt_0n8ttf1bur, notes dc_ll4ap5di82: scripts
 * in sandboxed page docs only, "sgtm"): its body is a full HTML page, scripts and styles included. It never goes
 * through the Markdown sanitizer: it runs in `<iframe sandbox="allow-scripts">` (no allow-same-origin, so an opaque
 * origin: no cookies, no storage, no access to the town's window or API) inside a centred Sheet whose head shows the
 * title and author like any doc. The frame gets the town's CSS variables (`--bg`, `--text`, `--accent`, `--fs-md`, …,
 * plus `--font` and `--mono`) on its `:root`, a dark default body, and a Content-Security-Policy with no network
 * (`connect-src 'none'`): a page draws from what it carries, and pictures may come from this town's media.
 */
import { useMemo, useState } from "react";
import type { Doc } from "@muster-town/schema";
import { Sheet } from "./Sheet";
import { timeAgo, useNameOf } from "./ui";

/** The town's CSS custom properties as declared on :root in its stylesheets, with their computed values. */
function townCssVars(): Record<string, string> {
  const names = new Set<string>();
  for (const sheet of [...document.styleSheets]) {
    let rules: CSSRuleList;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of [...rules]) {
      if (!(r instanceof CSSStyleRule) || r.selectorText.trim() !== ":root") continue;
      for (let i = 0; i < r.style.length; i++) if (r.style[i].startsWith("--")) names.add(r.style[i]);
    }
  }
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const n of names) { const v = cs.getPropertyValue(n).trim(); if (v) vars[n] = v; }
  const font = getComputedStyle(document.body).fontFamily;
  if (font && !vars["--font"]) vars["--font"] = font;
  return vars;
}

/** The iframe's srcdoc: our doctype, a CSP, the town's variables and a default body, then the page as written. */
export function pageSrcDoc(body: string, vars: Record<string, string>, mediaOrigin: string): string {
  const safe = (v: string) => v.replace(/[<>{}]/g, "");
  const root = Object.entries(vars).filter(([k]) => /^--[\w-]+$/.test(k)).map(([k, v]) => `${k}: ${safe(v)};`).join(" ");
  const img = ["data:", "blob:", mediaOrigin].filter(Boolean).join(" ");
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src ${img}; media-src ${img}; font-src data:`;
  const page = body.replace(/^\s*<!doctype[^>]*>/i, "");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<style>:root { ${root} color-scheme: dark; } html, body { margin: 0; background: var(--panel); color: var(--text); font: var(--fs-md, 13px)/1.5 var(--font, system-ui, sans-serif); } body { padding: 16px; }</style>`
    + page;
}

/** The page in a centred sheet. */
function PageSheet({ doc, onClose }: { doc: Doc; onClose: () => void }) {
  const srcDoc = useMemo(() => pageSrcDoc(doc.body, townCssVars(), location.origin), [doc.body]);
  const author = useNameOf(doc.authorId);
  return (
    <Sheet label={doc.title} title={doc.title} sub={<>page by <b>{author}</b> · {timeAgo(doc.updatedAt)}</>} onClose={onClose} escFirst mainClass="page-main" maxWidth={1100} className="page-sheet">
      <iframe className="page-frame" title={doc.title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} />
    </Sheet>
  );
}

/** What a page doc shows where a doc's body would be: it opens in its sheet at once; closed, a button opens it again. */
export function PageDoc({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="page-doc">
      <p className="muted">This is a page: it runs in its own sandboxed frame, with no access to the town.</p>
      <button className="btn primary" onClick={() => setOpen(true)}>Open the page</button>
      {open ? <PageSheet doc={doc} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
