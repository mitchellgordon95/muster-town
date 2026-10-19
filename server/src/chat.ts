import { query } from "@anthropic-ai/claude-agent-sdk";
import type { BuildingConfig } from "./types.js";
import { buildingDir } from "./town.js";
import { chatSystemPrompt } from "./prompts.js";

export interface ChatRequest {
  building: string;
  agent: string; // desk id or "librarian"
  message: string;
  sessionId?: string;
}

export async function chat(b: BuildingConfig, req: ChatRequest): Promise<{ reply: string; sessionId?: string }> {
  const desk = b.desks.find((d) => d.id === req.agent);
  const who = desk
    ? { name: desk.name, role: desk.title, deskId: desk.id }
    : { name: b.librarian.name, role: "librarian" };
  let reply = "";
  let sessionId: string | undefined;
  const q = query({
    prompt: req.message,
    options: {
      cwd: buildingDir(b.id),
      model: b.model,
      maxTurns: 8,
      resume: req.sessionId,
      allowedTools: ["Read", "Glob", "Grep"],
      disallowedTools: ["Bash", "Write", "Edit", "WebSearch", "WebFetch", "Task", "Agent"],
      permissionMode: "default",
      systemPrompt: { type: "preset", preset: "claude_code", append: chatSystemPrompt(b, who) },
    },
  });
  for await (const m of q) {
    if (m.type === "system" && (m as any).subtype === "init") sessionId = (m as any).session_id;
    if (m.type === "result") {
      reply = (m as any).result ?? "";
      sessionId = (m as any).session_id ?? sessionId;
    }
  }
  return { reply: reply || "(no reply)", sessionId };
}
