import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { loadBuildings, getBuilding, loadTown, ROOT } from "./town.js";
import { listReports, setDecision } from "./reports.js";
import { Runner } from "./runner.js";
import { chat } from "./chat.js";
import type { Decision } from "./types.js";

const PORT = Number(process.env.PORT || 4321);
const runner = new Runner();

function townState() {
  return {
    town: loadTown(),
    buildings: loadBuildings().map((b) => ({
      ...b,
      desks: b.desks.map((d) => ({ ...d, status: runner.status(b, d) })),
    })),
  };
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}
async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString("utf8");
  return s ? JSON.parse(s) : {};
}

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
function serveStatic(res: http.ServerResponse, urlPath: string): boolean {
  const dist = path.join(ROOT, "town", "dist");
  let p = path.join(dist, urlPath === "/" ? "index.html" : urlPath);
  if (!p.startsWith(dist) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dist, "index.html");
  if (!fs.existsSync(p)) return false;
  res.writeHead(200, { "content-type": MIME[path.extname(p)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(p));
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET,POST" }); return res.end(); }
    if (parts[0] !== "api") { if (!serveStatic(res, url.pathname)) json(res, 404, { error: "not found (build town/ first)" }); return; }

    // GET /api/town
    if (req.method === "GET" && parts[1] === "town") return json(res, 200, townState());

    // GET /api/reports/:building/:desk
    if (req.method === "GET" && parts[1] === "reports" && parts.length === 4) {
      return json(res, 200, { reports: listReports(parts[2], parts[3]) });
    }
    // POST /api/reports/:building/:desk/:run/decision {decision, note}
    if (req.method === "POST" && parts[1] === "reports" && parts[5] === "decision") {
      const body = await readBody(req);
      const decision = body.decision as Decision;
      if (!["approve", "redirect", "stop", "pending"].includes(decision)) return json(res, 400, { error: "bad decision" });
      const meta = setDecision(parts[2], parts[3], Number(parts[4]), decision, body.note ?? "");
      runner.emit("state");
      return json(res, 200, { report: meta });
    }
    // POST /api/desks/:building/:desk/start {note?}
    if (req.method === "POST" && parts[1] === "desks" && parts[4] === "start") {
      const b = getBuilding(parts[2]);
      const d = b?.desks.find((x) => x.id === parts[3]);
      if (!b || !d) return json(res, 404, { error: "no such desk" });
      const body = await readBody(req);
      const ok = runner.kick(b, d, body.note);
      return json(res, ok ? 200 : 409, { started: ok, status: runner.status(b, d) });
    }
    // POST /api/desks/:building/start-all
    if (req.method === "POST" && parts[1] === "desks" && parts[3] === "start-all") {
      const b = getBuilding(parts[2]);
      if (!b) return json(res, 404, { error: "no such building" });
      const started = b.desks.filter((d) => runner.kick(b, d)).map((d) => d.id);
      return json(res, 200, { started });
    }
    // POST /api/chat {building, agent, message, sessionId}
    if (req.method === "POST" && parts[1] === "chat") {
      const body = await readBody(req);
      const b = getBuilding(body.building);
      if (!b) return json(res, 404, { error: "no such building" });
      const out = await chat(b, body);
      return json(res, 200, out);
    }
    // GET /api/file/:building/<path>  (read a wiki/source/report file)
    if (req.method === "GET" && parts[1] === "file" && parts.length >= 4) {
      const base = path.join(ROOT, "buildings", parts[2]);
      const p = path.join(base, ...parts.slice(3));
      if (!p.startsWith(base) || !fs.existsSync(p)) return json(res, 404, { error: "no such file" });
      return json(res, 200, { path: parts.slice(3).join("/"), content: fs.readFileSync(p, "utf8") });
    }
    json(res, 404, { error: "unknown route" });
  } catch (e: any) {
    json(res, 500, { error: e?.message ?? String(e) });
  }
});

const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
}
runner.on("activity", (ev) => broadcast({ type: "activity", ...ev }));
runner.on("state", () => broadcast({ type: "state", ...townState() }));
wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "state", ...townState() })));

server.listen(PORT, () => {
  console.log(`agent-town server on http://localhost:${PORT}  (buildings: ${loadBuildings().map((b) => b.id).join(", ") || "none"})`);
  runner.start();
});
