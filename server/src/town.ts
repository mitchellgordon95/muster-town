import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildingConfig, TownConfig } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, "..", "..");
export const BUILDINGS_DIR = path.join(ROOT, "buildings");

export function buildingDir(id: string): string {
  return path.join(BUILDINGS_DIR, id);
}

export function loadBuildings(): BuildingConfig[] {
  if (!fs.existsSync(BUILDINGS_DIR)) return [];
  return fs
    .readdirSync(BUILDINGS_DIR)
    .filter((d) => fs.existsSync(path.join(BUILDINGS_DIR, d, "building.json")))
    .map((d) => {
      const cfg = JSON.parse(fs.readFileSync(path.join(BUILDINGS_DIR, d, "building.json"), "utf8")) as BuildingConfig;
      cfg.id = d;
      return cfg;
    });
}

export function getBuilding(id: string): BuildingConfig | undefined {
  return loadBuildings().find((b) => b.id === id);
}

export function mondayOf(d = new Date()): string {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Monday=0
  x.setDate(x.getDate() - day);
  return x.toISOString().slice(0, 10);
}

export function loadTown(): TownConfig {
  const f = path.join(ROOT, "town.json");
  if (!fs.existsSync(f)) return { name: "Agent Town", goal: "" };
  return JSON.parse(fs.readFileSync(f, "utf8")) as TownConfig;
}
