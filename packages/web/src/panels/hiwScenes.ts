/**
 * Little pixel-art vignettes for the "How this works" overlay, composed from the town's own procedural sprites
 * (tiles, props, characters) so the pictures match the map. Each scene is 7x3 tiles, returned as a data URL at
 * native resolution; CSS scales it up with `image-rendering: pixelated`.
 */
import {
  T, CHAR_W, CHAR_H, HUMAN_SPRITE, tiles, charSheet,
  drawDoor, drawVault, drawGold, drawPillar, drawGoldCounter, drawManagerDesk, drawBoard, drawCabinet,
} from "../map/sprites";

export type SceneKind = "donate" | "bank" | "buildings" | "work" | "agent" | "connect" | "tasks" | "visit" | "read" | "talk";

const W = 7, H = 3;
type G = CanvasRenderingContext2D;

const fill = (g: G, tile: HTMLCanvasElement, y0 = 0, y1 = H) => { for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) g.drawImage(tile, x * T, y * T); };
/** A character at pixel (px, py); frame 0 stand, 1 type, 2 walk. */
const person = (g: G, i: number, px: number, py: number, frame = 0) => {
  g.fillStyle = "rgba(0,0,0,.22)"; g.fillRect(px + 2, py + CHAR_H - 2, CHAR_W - 4, 2);
  g.drawImage(charSheet(i), frame * CHAR_W, 0, CHAR_W, CHAR_H, px, py, CHAR_W, CHAR_H);
};
const coin = (g: G, px: number, py: number) => {
  g.fillStyle = "#a87a14"; g.fillRect(px, py + 1, 5, 3); g.fillRect(px + 1, py, 3, 5);
  g.fillStyle = "#f2c94c"; g.fillRect(px + 1, py + 1, 3, 3);
  g.fillStyle = "#fff1b0"; g.fillRect(px + 1, py + 1, 1, 1);
};
/** A speech bubble with three dots (or a coin) pointing down at (px, py). */
const bubble = (g: G, px: number, py: number, content: "dots" | "coin" | "doc" = "dots") => {
  g.fillStyle = "#1a1a1a"; g.fillRect(px - 7, py - 11, 15, 9); g.fillRect(px - 1, py - 2, 2, 2);
  g.fillStyle = "#f4f4f8"; g.fillRect(px - 6, py - 10, 13, 7); g.fillRect(px, py - 3, 1, 2);
  if (content === "coin") coin(g, px - 2, py - 9);
  else if (content === "doc") { g.fillStyle = "#4f8fc9"; g.fillRect(px - 4, py - 9, 9, 1); g.fillRect(px - 4, py - 7, 6, 1); g.fillRect(px - 4, py - 5, 8, 1); }
  else { g.fillStyle = "#3a3d4c"; g.fillRect(px - 4, py - 7, 2, 2); g.fillRect(px - 1, py - 7, 2, 2); g.fillRect(px + 2, py - 7, 2, 2); }
};
/** A small house: coloured roof on row `y`, wall with a door below. */
const house = (g: G, tx: number, roof: string, w = 2) => {
  const tl = tiles();
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(tx * T, 2 * T, w * T, 2);
  g.fillStyle = roof; g.fillRect(tx * T - 1, 4, w * T + 2, T - 4);
  g.fillStyle = "rgba(255,255,255,.18)"; g.fillRect(tx * T - 1, 4, w * T + 2, 2);
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(tx * T - 1, T - 2, w * T + 2, 2);
  for (let i = 0; i < w; i++) g.drawImage(tl.wallFace, (tx + i) * T, T);
  drawDoor(g, tx * T + (w * T - T) / 2, T);
};
/** Agents' laptop/terminal glowing on a desk tile. */
const screen = (g: G, px: number, py: number) => {
  g.fillStyle = "#1a1d2a"; g.fillRect(px, py, 10, 7);
  g.fillStyle = "#3fbfb0"; g.fillRect(px + 1, py + 1, 8, 5);
  g.fillStyle = "#0e2a2a"; g.fillRect(px + 2, py + 2, 4, 1); g.fillRect(px + 2, py + 4, 6, 1);
  g.fillStyle = "#6a6f80"; g.fillRect(px - 1, py + 7, 12, 1);
};

const DRAW: Record<SceneKind, (g: G) => void> = {
  // you walk up to the Bank with a coin
  donate(g) {
    const tl = tiles();
    fill(g, tl.grass);
    for (let x = 0; x < W; x++) g.drawImage(tl.path, x * T, 2 * T);
    for (let x = 3; x < W; x++) { g.drawImage(tl.goldTop, x * T, 0); g.drawImage(tl.goldFace, x * T, T); }
    drawDoor(g, 5 * T, T, true);
    person(g, HUMAN_SPRITE, 14, 2 * T - 6, 2);
    bubble(g, 20, 2 * T - 6, "coin");
    coin(g, 34, 2 * T + 6); coin(g, 46, 2 * T + 8); coin(g, 58, 2 * T + 6);
  },
  // one shared balance: the Bank's hall
  bank(g) {
    const tl = tiles();
    fill(g, tl.marble, 1);
    for (let x = 0; x < W; x++) g.drawImage(tl.goldFace, x * T, 0);
    drawVault(g, 3 * T, 0);
    drawPillar(g, 0, T); drawPillar(g, 6 * T, T);
    person(g, 4, 2 * T + 2, T - 6);
    for (let x = 1; x <= 5; x++) drawGoldCounter(g, x * T, T + 4, { l: x > 1, r: x < 5 }, x % 2 === 0);
    drawGold(g, 1 * T, 2 * T); drawGold(g, 5 * T, 2 * T);
  },
  // buildings draw their share
  buildings(g) {
    const tl = tiles();
    fill(g, tl.grass);
    house(g, 0, "#4f6fa8"); house(g, 2.5, "#5aa66b"); house(g, 5, "#b26fd1");
    for (const x of [8, 20, 40, 52, 72, 84, 100]) coin(g, x, 2 * T + 7);
  },
  // agents at desks doing the work
  work(g) {
    const tl = tiles();
    fill(g, tl.wood, 1);
    for (let x = 0; x < W; x++) g.drawImage(tl.wallFace, x * T, 0);
    drawBoard(g, 1 * T, 0); g.drawImage(tl.shelf, 3 * T, 0); drawCabinet(g, 5 * T, 0);
    person(g, 2, T + 10, T - 2, 1); person(g, 5, 4 * T + 10, T - 2, 1);
    g.drawImage(tl.deskL, T, T + 6); g.drawImage(tl.deskR, 2 * T, T + 6);
    g.drawImage(tl.deskL, 4 * T, T + 6); g.drawImage(tl.deskR, 5 * T, T + 6);
    g.drawImage(tl.plant, 0, 2 * T); g.drawImage(tl.plant, 6 * T, 2 * T);
  },
  // your own agent at your own machine
  agent(g) {
    const tl = tiles();
    fill(g, tl.wood, 1);
    g.fillStyle = "#1b1e2c"; g.fillRect(0, 0, W * T, T);
    // a window onto the night, with stars
    g.fillStyle = "#3a3f56"; g.fillRect(4 * T, 2, 2 * T + 4, T - 4);
    g.fillStyle = "#101426"; g.fillRect(4 * T + 2, 4, 2 * T, T - 8);
    g.fillStyle = "#f4f4f8"; g.fillRect(4 * T + 6, 6, 1, 1); g.fillRect(5 * T + 4, 8, 1, 1); g.fillRect(5 * T + 12, 5, 1, 1);
    person(g, 10, 2 * T + 2, T - 6, 1);
    g.drawImage(tl.deskPlain, 2 * T, T + 6);
    screen(g, 2 * T + 3, T + 5);
    g.drawImage(tl.plant, 0, T); g.drawImage(tl.shelf, 6 * T, T - 4);
    bubble(g, 2 * T + 8, T - 6, "dots");
  },
  // it walks into town over API / MCP
  connect(g) {
    const tl = tiles();
    fill(g, tl.grass);
    for (let x = 0; x < W; x++) g.drawImage(tl.path, x * T, 2 * T);
    house(g, 4, "#8c3b3b", 3);
    person(g, 10, 1 * T + 8, 2 * T - 6, 2);
    // a cable trailing back to "your machine", off-screen left
    g.fillStyle = "#3fbfb0"; for (let x = 0; x < T + 8; x += 3) g.fillRect(x, 2 * T + 9, 2, 1);
  },
  // and does tasks like any resident
  tasks(g) {
    const tl = tiles();
    fill(g, tl.wood, 1);
    for (let x = 0; x < W; x++) g.drawImage(tl.wallFace, x * T, 0);
    drawBoard(g, 2 * T, 0); drawBoard(g, 3 * T, 0); g.drawImage(tl.shelf, 5 * T, 0);
    person(g, 10, 2 * T + 8, T + 2, 0);
    bubble(g, 2 * T + 14, T + 2, "doc");
    drawManagerDesk(g, 4 * T, T + 6);
    g.drawImage(tl.plant, 0, 2 * T);
  },
  // walk around town and in at any door
  visit(g) {
    const tl = tiles();
    fill(g, tl.grass);
    for (let x = 0; x < W; x++) g.drawImage(tl.path, x * T, 2 * T);
    house(g, 0, "#4f6fa8"); house(g, 4.5, "#5aa66b");
    person(g, HUMAN_SPRITE, 3 * T, 2 * T - 6, 2);
    person(g, 2, 5 * T + 2, 2 * T - 4, 0);
  },
  // every board, report and library shelf is readable
  read(g) {
    const tl = tiles();
    fill(g, tl.wood, 1);
    for (let x = 0; x < W; x++) g.drawImage(tl.wallFace, x * T, 0);
    g.drawImage(tl.shelf, 0, 0); g.drawImage(tl.shelf, T, 0);
    drawBoard(g, 3 * T, 0); drawCabinet(g, 5 * T, 0); drawCabinet(g, 6 * T, 0);
    person(g, HUMAN_SPRITE, 3 * T + 2, T + 2, 0);
    bubble(g, 3 * T + 8, T + 2, "doc");
  },
  // and you can talk to whoever is working
  talk(g) {
    const tl = tiles();
    fill(g, tl.wood, 1);
    for (let x = 0; x < W; x++) g.drawImage(tl.wallFace, x * T, 0);
    drawBoard(g, 5 * T, 0);
    person(g, 5, 4 * T + 10, T - 2, 1);
    g.drawImage(tl.deskL, 4 * T, T + 6); g.drawImage(tl.deskR, 5 * T, T + 6);
    person(g, HUMAN_SPRITE, 2 * T, T + 6, 0);
    bubble(g, 2 * T + 6, T + 6, "dots"); bubble(g, 4 * T + 16, T - 2, "dots");
  },
};

const cache = new Map<SceneKind, string>();
export function sceneUrl(kind: SceneKind): string {
  const hit = cache.get(kind);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = W * T; c.height = H * T;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  DRAW[kind](g);
  const url = c.toDataURL();
  cache.set(kind, url);
  return url;
}
