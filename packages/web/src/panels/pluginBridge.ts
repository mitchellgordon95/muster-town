/**
 * The plugin bridge (docs/plugins.md): the only way a plugin's sandboxed page talks to the town. The page calls
 * `town.docs.list()` and friends from the shim below; the shim posts `{ muster: "plugin", id, method, params }` to the
 * parent window; the parent (PluginSheet) checks it here against the manifest's scopes, calls the town's plugin routes as
 * the viewing human, and posts back `{ muster: "plugin", id, ok, result | error, code }`. The server enforces the
 * scopes again (core plugins.ts): this check only gives the page a quick, clear refusal. Pure: no DOM, no fetch.
 */

/** The bridge methods, with the scope each needs (null: none). */
const BRIDGE_METHODS = {
  "town.hello": null,
  "docs.list": "docs.read",
  "docs.read": "docs.read",
  "docs.write": "docs.write",
} as const;
type BridgeMethod = keyof typeof BRIDGE_METHODS;

export type BridgeCall =
  | { method: "town.hello" }
  | { method: "docs.list"; params: { state?: "draft" | "building"; limit?: number } }
  | { method: "docs.read"; params: { id: string } }
  | { method: "docs.write"; params: { id?: string; title: string; body: string; state: "draft" | "building"; tags?: string[] } };

type Checked = { id: string | number; ok: true; call: BridgeCall } | { id: string | number; ok: false; error: string; code: string };

const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const state = (v: unknown): v is "draft" | "building" => v === "draft" || v === "building";

/**
 * Read one message from the page: null when it is not a bridge request (ignore it), else the call to make or the
 * refusal to send back. `scopes` are the manifest's.
 */
export function checkBridgeMessage(data: unknown, scopes: readonly string[]): Checked | null {
  if (!data || typeof data !== "object") return null;
  const m = data as { muster?: unknown; id?: unknown; method?: unknown; params?: unknown };
  if (m.muster !== "plugin" || !(typeof m.id === "number" || (typeof m.id === "string" && m.id.length <= 64))) return null;
  const id = m.id;
  const no = (error: string, code = "bad_request"): Checked => ({ id, ok: false, error, code });
  if (typeof m.method !== "string" || !(m.method in BRIDGE_METHODS)) return no(`Unknown bridge method ${JSON.stringify(m.method)}. Methods: ${Object.keys(BRIDGE_METHODS).join(", ")}.`);
  const method = m.method as BridgeMethod;
  const need = BRIDGE_METHODS[method];
  if (need && !scopes.includes(need)) return no(`This plugin did not ask for the ${need} scope in its manifest.`, "forbidden");
  const p = (m.params && typeof m.params === "object" ? m.params : {}) as Record<string, unknown>;
  switch (method) {
    case "town.hello": return { id, ok: true, call: { method } };
    case "docs.list": {
      if (p.state !== undefined && !state(p.state)) return no('docs.list: state is "draft" or "building".');
      if (p.limit !== undefined && !(Number.isInteger(p.limit) && (p.limit as number) > 0 && (p.limit as number) <= 200)) return no("docs.list: limit is a whole number from 1 to 200.");
      return { id, ok: true, call: { method, params: { ...(p.state ? { state: p.state as "draft" | "building" } : {}), ...(p.limit ? { limit: p.limit as number } : {}) } } };
    }
    case "docs.read":
      if (!str(p.id, 64) || !p.id) return no("docs.read: give the doc's id.");
      return { id, ok: true, call: { method, params: { id: p.id } } };
    case "docs.write": {
      if (!str(p.title, 200) || !p.title.trim()) return no("docs.write: a title (at most 200 characters) is needed.");
      if (!str(p.body, 200_000)) return no("docs.write: a body (at most 200,000 characters) is needed.");
      if (p.id !== undefined && (!str(p.id, 64) || !p.id)) return no("docs.write: id is the doc's id (leave it out to create one).");
      if (p.state !== undefined && !state(p.state)) return no('docs.write: state is "draft" or "building".');
      if (p.tags !== undefined && !(Array.isArray(p.tags) && p.tags.length <= 10 && p.tags.every((t) => str(t, 40)))) return no("docs.write: tags is a list of at most 10 short words.");
      return { id, ok: true, call: { method, params: { ...(p.id ? { id: p.id as string } : {}), title: p.title, body: p.body, state: (p.state as "draft" | "building" | undefined) ?? "draft", ...(p.tags ? { tags: p.tags as string[] } : {}) } } };
    }
  }
}

/** A doc as the bridge hands it to a page: what a widget needs, nothing the town keeps for itself. */
interface BridgeDoc { id: string; title: string; body: string; state: string; tags: string[]; authorId: string; createdAt: string; updatedAt: string }
export const bridgeDoc = (d: BridgeDoc): BridgeDoc => ({ id: d.id, title: d.title, body: d.body, state: d.state, tags: d.tags, authorId: d.authorId, createdAt: d.createdAt, updatedAt: d.updatedAt });

/**
 * The shim put in front of every plugin page: `window.town` with `call(method, params)`, `hello()` and
 * `docs.list(q)`, `docs.read(id)`, `docs.write(doc)`, each a Promise. It answers only messages from its parent.
 */
export const BRIDGE_SHIM = `<script>(function(){var n=0,w={};addEventListener("message",function(e){var m=e.data;if(e.source!==parent||!m||m.muster!=="plugin"||!(m.id in w))return;var p=w[m.id];delete w[m.id];if(m.ok)p[0](m.result);else{var x=new Error(m.error);x.code=m.code;p[1](x)}});function call(method,params){return new Promise(function(res,rej){var id=++n;w[id]=[res,rej];parent.postMessage({muster:"plugin",id:id,method:method,params:params||{}},"*")})}window.town={call:call,hello:function(){return call("town.hello")},docs:{list:function(q){return call("docs.list",q||{})},read:function(id){return call("docs.read",{id:id})},write:function(d){return call("docs.write",d)}}}})();</script>`;
