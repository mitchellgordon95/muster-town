/**
 * The Start form's rules (home/StartCard.tsx), kept pure so they test without a DOM: the address a name gets and what
 * the form refuses before it posts. The server (`POST /api/collectives`) checks the same rules from @muster-town/schema.
 */
import { apiKeyProblem, slugify, slugProblem } from "@muster-town/schema";

export interface StartDraft { name: string; goal: string; tagline: string; apiKey: string }
export type StartProblems = Partial<Record<keyof StartDraft, string>>;

/** The address the name gets (`""` until the name has a letter or digit). */
export const addressOf = (name: string): string => slugify(name);

/** Field → what's wrong with it; empty when the draft can be posted. */
export function startProblems(d: StartDraft): StartProblems {
  const out: StartProblems = {};
  const slug = addressOf(d.name);
  if (!d.name.trim()) out.name = "Give it a name.";
  else if (d.name.trim().length > 80) out.name = "Keep the name under 80 characters.";
  else { const bad = slugProblem(slug); if (bad) out.name = bad; }
  if (!d.goal.trim()) out.goal = "Say in one sentence what it works toward.";
  else if (d.goal.trim().length > 300) out.goal = "Keep the goal to one sentence (300 characters at most).";
  if (d.tagline.trim().length > 200) out.tagline = "Keep the tagline under 200 characters.";
  const key = apiKeyProblem(d.apiKey);
  if (key) out.apiKey = key;
  return out;
}

/** The request body: trimmed, the slug from the name, the key only when there is one. */
export function startBody(d: StartDraft): { name: string; goal: string; tagline: string; slug: string; apiKey?: string } {
  const apiKey = d.apiKey.trim();
  return { name: d.name.trim(), goal: d.goal.trim(), tagline: d.tagline.trim(), slug: addressOf(d.name), ...(apiKey ? { apiKey } : {}) };
}

/** Which field a server error belongs to (409 taken / reserved → name; key wording → apiKey), else the form. */
export function errorField(status: number, message: string): keyof StartDraft | "form" {
  if (status === 409 || (status === 400 && /address|reserved|muster\.town\//.test(message))) return "name";
  if (status === 400 && /key|token/i.test(message)) return "apiKey";
  return "form";
}

/** Where sign-in sends a signed-out visitor: GitHub, then back to this form. */
export const SIGN_IN_TO_START = `/auth/github?return_to=${encodeURIComponent("/#start")}`;
