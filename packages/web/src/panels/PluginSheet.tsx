/**
 * An installed plugin's widget (docs/plugins.md; Mitchell's flag dc_4boq48hqr6): its page from GET /api/plugins/:id in
 * the same sandboxed iframe as a page doc (PageView.tsx: no network, no same origin), with the bridge shim in front.
 * The page calls `town.docs.list()` and friends; this sheet answers each call (pluginBridge.ts checks it against the
 * manifest's scopes) through the town's plugin routes as the viewer, so the server applies the viewer's own rights.
 * Opened from the plugin's screen on its building's back wall (place `plugin:<docId>`), or from the doc itself.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { Doc } from "@muster-town/schema";
import { api, type PluginWithPage } from "../api";
import { store, useTown } from "../state";
import { Sheet } from "./Sheet";
import { pageSrcDoc, townCssVars } from "./PageView";
import { BRIDGE_SHIM, bridgeDoc, checkBridgeMessage, type BridgeCall } from "./pluginBridge";
import { timeAgo } from "./ui";

export function PluginSheet({ id, onClose }: { id: string; onClose?: () => void }) {
  const [p, setP] = useState<PluginWithPage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const me = useTown((s) => s.me);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    api().plugin(id).then((r) => { if (live) setP(r); }, (e: Error) => { if (live) setErr(e.message); });
    return () => { live = false; };
  }, [id]);
  const srcDoc = useMemo(() => p ? pageSrcDoc(BRIDGE_SHIM + p.html.replace(/^\s*<!doctype[^>]*>/i, ""), townCssVars(), location.origin) : "", [p]);

  useEffect(() => {
    if (!p) return;
    const answer = async (call: BridgeCall): Promise<unknown> => {
      switch (call.method) {
        case "town.hello": {
          const { html: _html, ...rest } = p;
          return { plugin: rest.plugin, viewer: me ? { signedIn: true, id: me.user.id, name: me.user.name, isAdmin: me.isAdmin } : { signedIn: false } };
        }
        case "docs.list": return (await api().pluginDocs(id, call.params)).map(bridgeDoc);
        case "docs.read": return bridgeDoc(await api().pluginDoc(id, call.params.id));
        case "docs.write":
          if (!me) throw Object.assign(new Error("Sign in to write."), { code: "unauthorized" });
          return bridgeDoc(await api().writePluginDoc(id, call.params));
      }
    };
    const onMessage = (e: MessageEvent) => {
      const win = frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const checked = checkBridgeMessage(e.data, p.plugin.scopes);
      if (!checked) return;
      const reply = (m: object) => win.postMessage({ muster: "plugin", id: checked.id, ...m }, "*");
      if (!checked.ok) { reply({ ok: false, error: checked.error, code: checked.code }); return; }
      answer(checked.call).then((result) => reply({ ok: true, result }),
        (x: Error & { code?: string }) => reply({ ok: false, error: x.message, code: x.code ?? "error" }));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [p, id, me]);

  const close = onClose ?? (() => store.open(null));
  const info = p?.plugin;
  return (
    <Sheet label={info?.name ?? "Plugin"} title={info?.name ?? "Plugin"} onClose={close} escFirst mainClass="page-main" maxWidth={1100} className="page-sheet"
      sub={info ? <>plugin by <b>{info.author}</b> · {timeAgo(info.updatedAt)}{info.scopes.length ? <> · may {info.scopes.map((s) => s === "docs.read" ? `read its ${info.docType}s` : `write ${info.docType}s as you`).join(" and ")}</> : null}</> : null}>
      {err ? <div className="error-line">{err}</div> : p ? <iframe ref={frame} className="page-frame" title={p.plugin.name} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} /> : <p className="muted">Loading…</p>}
    </Sheet>
  );
}

/** What a plugin doc shows where a doc's body would be: what it is and a button that opens its widget (a draft: its author's preview). */
export function PluginDoc({ doc }: { doc: Doc }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="page-doc">
      <p className="muted">{doc.state === "draft"
        ? "This is a plugin, not installed yet: a draft only its author sees. Publish it in a building to hang it on that building's back wall."
        : "This is a plugin: a town object hanging on its building's back wall. It runs in its own sandboxed frame and reaches the town only through the plugin bridge, as you."}</p>
      <button className="btn primary" onClick={() => setOpen(true)}>Open the plugin</button>
      {open ? <PluginSheet id={doc.id} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
