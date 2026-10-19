export interface DeskConfig {
  id: string;
  name: string;      // persona name
  sprite: number;
  title: string;
  direction: string;
}

export interface BuildingConfig {
  id: string;
  name: string;
  owner: string;
  goal?: string;
  description: string;
  maxTurns?: number;
  model?: string;
  librarian: { id: string; name: string; sprite: number };
  desks: DeskConfig[];
}

export type Verdict = "continue" | "pivot" | "stop";
export type Decision = "pending" | "approve" | "redirect" | "stop";

export interface ReportMeta {
  desk: string;
  run: number;
  started: string;
  ended: string;
  verdict: Verdict;
  decision: Decision;
  note: string;
  title: string;
  file: string;
}

export interface Report extends ReportMeta {
  body: string;
}

export type DeskState = "idle" | "working" | "awaiting-review" | "stopped" | "error";

export interface ActivityEvent {
  building: string;
  desk: string;
  run: number;
  ts: string;
  kind: "tool" | "text" | "status";
  text: string;
}

export interface DeskStatus {
  state: DeskState;
  run: number;
  activity: ActivityEvent[];
  latestReport?: ReportMeta;
  error?: string;
}

export interface TownConfig { name: string; goal: string; goalNote?: string; tagline?: string; }
