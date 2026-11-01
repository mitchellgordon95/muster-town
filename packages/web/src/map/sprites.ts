/**
 * Procedural pixel art, ported from legacy/town/src/sprites.ts (Phaser) to plain canvases.
 * Characters are 12x16 with three frames (stand, type, walk); tiles are 16x16.
 */
export const T = 16;
export const CHAR_W = 12, CHAR_H = 16;

/** Draw ASCII pixel art onto a canvas, frames side by side. `.` is transparent. */
function pixelCanvas(frames: string[][], palette: Record<string, string>): HTMLCanvasElement {
  const h = frames[0].length, w = frames[0][0].length;
  const c = document.createElement("canvas");
  c.width = w * frames.length; c.height = h;
  const g = c.getContext("2d")!;
  frames.forEach((rows, f) => rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === "." || !palette[ch]) return;
    g.fillStyle = palette[ch]; g.fillRect(f * w + x, y, 1, 1);
  })));
  return c;
}

const HEAD = ["....HHHH....", "...HHHHHH...", "...HSSSSH...", "...SSESES...", "...SSSSSS...", "....SSSS....", "...BBBBBB..."];
const STAND = [...HEAD, "..BBBBBBBB..", "..SBBBBBBS..", "..SBBBBBBS..", "...BBBBBB...", "...PPPPPP...", "...PP..PP...", "...PP..PP...", "...FF..FF...", "............"];
const TYPE = [...HEAD, "..SBBBBBBS..", "..SBBBBBBS..", "..BBBBBBBB..", "...BBBBBB...", "...PPPPPP...", "...PP..PP...", "...PP..PP...", "...FF..FF...", "............"];
const WALK = [...HEAD, "..BBBBBBBB..", "..SBBBBBBS..", "..SBBBBBBS..", "...BBBBBB...", "...PPPPPP...", "..PP....PP..", "..PP....PP..", "..FF....FF..", "............"];

const SKIN = ["#f1c9a5", "#c68642", "#f6d7bd", "#8d5524", "#e0ac69"];
const PALETTES: Record<string, string>[] = [
  { H: "#3b2a22", B: "#c94f4f", P: "#2d3550", S: SKIN[0] }, // 0 red
  { H: "#1c1c1c", B: "#4f8fc9", P: "#2f2f3a", S: SKIN[1] },
  { H: "#d9a441", B: "#5aa66b", P: "#3a3a4a", S: SKIN[0] },
  { H: "#2b2b2b", B: "#b26fd1", P: "#2d3550", S: SKIN[2] },
  { H: "#111111", B: "#e0a030", P: "#3a2d2d", S: SKIN[3] },
  { H: "#c4553a", B: "#3fbfb0", P: "#2f2f3a", S: SKIN[0] },
  { H: "#6b4f3a", B: "#d85f8f", P: "#2d3550", S: SKIN[0] },
  { H: "#f0f0f0", B: "#ffffff", P: "#5b7aa6", S: SKIN[0] }, // 7 human player
  { H: "#5b5f6b", B: "#7a8a6a", P: "#33363f", S: SKIN[4] }, // 8 grey
  { H: "#2a1d14", B: "#e86a3a", P: "#2f2f3a", S: SKIN[2] },
  { H: "#8a6236", B: "#6a7de0", P: "#3a3a4a", S: SKIN[1] },
  { H: "#101010", B: "#9ac23f", P: "#2d3550", S: SKIN[3] },
].map((p) => ({ ...p, E: "#1a1a1a", F: "#2a1d14" }));
export const HUMAN_SPRITE = 7;

const charCache = new Map<number, HTMLCanvasElement>();
/** Sprite sheet for palette `i`: frames 0 stand, 1 type, 2 walk. */
export function charSheet(i: number): HTMLCanvasElement {
  const k = ((i % PALETTES.length) + PALETTES.length) % PALETTES.length;
  let c = charCache.get(k);
  if (!c) { c = pixelCanvas([STAND, TYPE, WALK], PALETTES[k]); charCache.set(k, c); }
  return c;
}
/** The character sheet's 1-px outline in `color` (the silhouette grown by one pixel, minus the sprite): a fork's ghost. */
const outlineCache = new Map<string, HTMLCanvasElement>();
export function outlineSheet(i: number, color: string): HTMLCanvasElement {
  const key = `${i}|${color}`;
  let c = outlineCache.get(key);
  if (!c) {
    const src = charSheet(i);
    c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    const g = c.getContext("2d")!;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) g.drawImage(src, dx, dy);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-out";
    g.drawImage(src, 0, 0);
    outlineCache.set(key, c);
  }
  return c;
}
/** A single frame scaled up, as a data URL (for panel headers). */
export function portraitUrl(i: number, scale = 3): string {
  const src = charSheet(i);
  const c = document.createElement("canvas");
  c.width = CHAR_W * scale; c.height = CHAR_H * scale;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, CHAR_W, CHAR_H, 0, 0, c.width, c.height);
  return c.toDataURL();
}

// ---------- tiles ----------
const grid16 = (f: (x: number, y: number) => string) => Array.from({ length: T }, (_, y) => Array.from({ length: T }, (_, x) => f(x, y)).join(""));
const GRASS = grid16((x, y) => ((x === 3 && y === 11) || (x === 12 && y === 4) ? "h" : (x * 7 + y * 13) % 11 === 0 ? "g" : "G"));
const PATH = grid16((x, y) => ((x * 5 + y * 3) % 9 === 0 ? "p" : (x * 11 + y * 7) % 23 === 0 ? "q" : "P"));
/** The town square: warm cobbles in a running bond, mortar lines between, the odd darker stone. */
const PAVING = grid16((x, y) => {
  const row = y >> 2, off = row % 2 ? 3 : 0;
  if (y % 4 === 3 || (x + off) % 6 === 5) return "j";
  return ((((x + off) / 6) | 0) * 5 + row * 3) % 7 === 0 ? "k" : y % 4 === 0 ? "J" : "i";
});
const WOOD = grid16((x, y) => (y % 8 === 7 || (x + (y < 8 ? 0 : 8)) % 16 === 15 ? "f" : "F"));
const STONE = grid16((x, y) => (x % 8 === 7 || y % 8 === 7 ? "n" : ((x >> 3) + (y >> 3)) % 2 ? "N" : "o"));
const WALL_FACE = grid16((x, y) => (y === 0 ? "w" : y > 12 ? "x" : (x + (y % 4 < 2 ? 0 : 4)) % 8 === 7 || y % 4 === 1 ? "m" : "W"));
const WALL_TOP = grid16((x, y) => (x === 0 || x === 15 ? "w" : (x + y) % 6 === 0 ? "v" : "u"));
const DESK = [
  "................................",
  "................................",
  "..........MMMMMMMMMMMM..........",
  "..........MssssssssssM..........",
  "..........MsssssssssSM..........",
  "..........MssssssssssM..........",
  "..........MMMMMMMMMMMM..........",
  ".............MM.MM......cc......",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  "DddddddddddddddddddddddddddddddD",
  "Ddddddddddd.KKKKKKKK.ddddddddddD",
  "DddddddddddKKKKKKKKKKddddddddddD",
  "DddddddddddddddddddddddddddddddD",
  "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
  ".DD..........................DD.",
  ".DD..........................DD.",
];
const SHELF = [
  "BBBBBBBBBBBBBBBB", "BrrggbbrrggbbrrB", "BrrggbbrrggbbrrB", "BrrggbbrrggbbrrB", "BBBBBBBBBBBBBBBB",
  "BggbbrrggbbrrggB", "BggbbrrggbbrrggB", "BggbbrrggbbrrggB", "BBBBBBBBBBBBBBBB", "BbbrrggbbrrggbbB",
  "BbbrrggbbrrggbbB", "BbbrrggbbrrggbbB", "BBBBBBBBBBBBBBBB", "BBBBBBBBBBBBBBBB", ".BB..........BB.", ".BB..........BB.",
];
const PLANT = [
  "................", "......LL........", "....LLLLLL......", "...LLLlLLLL.....", "..LLlLLLLlLL....", "..LLLLlLLLLL....",
  "...LLLLLLLL.....", "....LLLLLL......", ".....LLLL.......", "......tt........", "......tt........",
  "....oooooo......", "....oooooo......", ".....oooo.......", ".....oooo.......", "................",
];
const PAL: Record<string, string> = {
  G: "#5f9e4f", g: "#6fae5f", h: "#e9d77a", P: "#c9b587", p: "#b9a577", q: "#d6c497",
  F: "#b58a5a", f: "#9c7347", N: "#8b90a6", o: "#9499ae", n: "#767b92",
  W: "#4d5370", w: "#2e3248", m: "#3f4460", x: "#3a3f58", u: "#30344a", v: "#383c54",
  M: "#2a2d3a", s: "#5fb4ff", S: "#cfe9ff", D: "#6b4a2b", d: "#8a6236", K: "#2a2d3a", c: "#e8e2d0",
  B: "#5a3d22", r: "#c94f4f", b: "#4f8fc9", L: "#3f8f4f", l: "#6fbf6f", t: "#6b4a2b", O: "#a0522d",
  Y: "#e8b840", y: "#b8862a", i: "#cdbfa6", J: "#ddd1bb", j: "#a3967f", k: "#bfae92",
};
/** The Bank: the same wall art in gold, and a cream marble floor with gold inlay. */
const GOLD_PAL = { ...PAL, W: "#d9a92c", w: "#6e4f0e", m: "#b3851a", x: "#8f6a12", u: "#e8bf3f", v: "#f7dc78" };
const MARBLE = grid16((x, y) => (x % 8 === 0 || y % 8 === 0 ? ((x + y) % 8 === 0 ? "Y" : "y") : (x * 3 + y * 5) % 17 === 0 ? "a" : "A"));
const MARBLE_PAL = { ...PAL, A: "#efe8d6", a: "#d9cfb6", Y: "#f2cf5b", y: "#d7ad3a" };
const PLANT_PAL = { ...PAL, o: "#a0522d" };

/** A lone desk tile (odd-length runs, e.g. the 3-seat mod station): the desk body without the half monitor. */
function plainDesk(sheet: HTMLCanvasElement) {
  const c = document.createElement("canvas"); c.width = T; c.height = T;
  const g = c.getContext("2d")!;
  g.drawImage(sheet, 0, 8, T, 8, 0, 8, T, 8);
  g.drawImage(sheet, T * 2 - 2, 8, 2, 8, T - 2, 8, 2, 8); // right edge
  g.fillStyle = "#e8e2d0"; g.fillRect(4, 5, 7, 4); g.fillStyle = "#9a9db3"; g.fillRect(5, 6, 5, 1); // papers
  return c;
}

let tileCache: Record<string, HTMLCanvasElement> | null = null;
export function tiles(): Record<string, HTMLCanvasElement> {
  if (tileCache) return tileCache;
  const deskSheet = pixelCanvas([DESK], PAL);
  const half = (sx: number) => {
    const c = document.createElement("canvas"); c.width = T; c.height = T;
    c.getContext("2d")!.drawImage(deskSheet, sx, 0, T, T, 0, 0, T, T);
    return c;
  };
  tileCache = {
    grass: pixelCanvas([GRASS], PAL), path: pixelCanvas([PATH], PAL), wood: pixelCanvas([WOOD], PAL),
    stone: pixelCanvas([STONE], PAL), paving: pixelCanvas([PAVING], PAL), wallFace: pixelCanvas([WALL_FACE], PAL), wallTop: pixelCanvas([WALL_TOP], PAL),
    deskL: half(0), deskR: half(T), deskPlain: plainDesk(deskSheet), shelf: pixelCanvas([SHELF], PAL), plant: pixelCanvas([PLANT], PLANT_PAL),
    goldFace: pixelCanvas([WALL_FACE], GOLD_PAL), goldTop: pixelCanvas([WALL_TOP], GOLD_PAL), marble: pixelCanvas([MARBLE], MARBLE_PAL),
  };
  return tileCache;
}

/** Neighbour-aware furniture drawn with rects: meeting table, outbox counter, door. */
export function drawTable(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean; u: boolean; d: boolean }) {
  const x0 = px + (n.l ? 0 : 1), x1 = px + T - (n.r ? 0 : 1), top = py + (n.u ? 0 : 2), front = py + T - (n.d ? 0 : 5);
  // legs at the run's ends, then the apron and the top with a lighter rim
  g.fillStyle = "#4a3018";
  if (!n.d && !n.l) g.fillRect(x0 + 1, front, 2, py + T - front);
  if (!n.d && !n.r) g.fillRect(x1 - 3, front, 2, py + T - front);
  g.fillStyle = "#5a3a1f"; g.fillRect(x0, front, x1 - x0, n.d ? 0 : 2);
  g.fillStyle = "#946538"; g.fillRect(x0, top, x1 - x0, front - top);
  g.fillStyle = "#a8774a"; if (!n.u) g.fillRect(x0 + (n.l ? 0 : 1), top, x1 - x0 - (n.l ? 0 : 1) - (n.r ? 0 : 1), 1);
  g.fillStyle = "#7a5230"; if (!n.l) g.fillRect(x0, top, 1, front - top); if (!n.r) g.fillRect(x1 - 1, top, 1, front - top);
  // papers and mugs so a table reads as a meeting table
  if ((px + py) % 48 === 0) { g.fillStyle = "#e8e2d0"; g.fillRect(px + 4, top + 2, 6, 4); g.fillStyle = "#9a9db3"; g.fillRect(px + 5, top + 3, 4, 1); }
  else { g.fillStyle = "#cfe9ff"; g.fillRect(px + 9, top + 3, 3, 3); g.fillStyle = "#7cc4ff"; g.fillRect(px + 9, top + 3, 3, 1); }
}
/** A chair drawn on the floor tile next to a meeting table; `facing` is where the sitter looks. */
export function drawChair(g: CanvasRenderingContext2D, px: number, py: number, facing: "up" | "down") {
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(px + 4, py + (facing === "down" ? 13 : 4), 8, 2);
  if (facing === "down") {
    // above the table: the back stands behind the seat
    g.fillStyle = "#3d4a6b"; g.fillRect(px + 4, py + 4, 8, 6);
    g.fillStyle = "#56648c"; g.fillRect(px + 5, py + 5, 6, 4);
    g.fillStyle = "#2e3650"; g.fillRect(px + 4, py + 10, 8, 3);
    g.fillStyle = "#56648c"; g.fillRect(px + 4, py + 10, 8, 1);
  } else {
    // below the table: we see the seat edge and the back from behind
    g.fillStyle = "#2e3650"; g.fillRect(px + 4, py + 0, 8, 3);
    g.fillStyle = "#3d4a6b"; g.fillRect(px + 4, py + 3, 8, 7);
    g.fillStyle = "#56648c"; g.fillRect(px + 4, py + 3, 8, 1);
    g.fillStyle = "#2e3650"; g.fillRect(px + 5, py + 10, 1, 3); g.fillRect(px + 10, py + 10, 1, 3);
  }
}
export function drawCounter(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean }, mail: boolean) {
  g.fillStyle = "#4a3320"; g.fillRect(px, py + 6, T, 10);
  g.fillStyle = "#c9a26b"; g.fillRect(px, py + 3, T, 4);
  g.fillStyle = "#e0bd86"; g.fillRect(px, py + 3, T, 1);
  if (!n.l) { g.fillStyle = "#3a2716"; g.fillRect(px, py + 3, 1, 13); }
  if (!n.r) { g.fillStyle = "#3a2716"; g.fillRect(px + T - 1, py + 3, 1, 13); }
  g.fillStyle = "#5c4029"; g.fillRect(px + 2, py + 9, T - 4, 1); g.fillRect(px + 2, py + 13, T - 4, 1);
  if (mail) {
    g.fillStyle = "#7a8aa6"; g.fillRect(px + 3, py, 10, 4);
    g.fillStyle = "#f2efe6"; g.fillRect(px + 4, py - 2, 8, 4);
    g.fillStyle = "#c94f4f"; g.fillRect(px + 7, py - 1, 2, 2);
  }
}
/** `gold`: the Bank's door, gold frame and dark-green panels. */
export function drawDoor(g: CanvasRenderingContext2D, px: number, py: number, gold = false) {
  g.fillStyle = gold ? "#f2cf5b" : "#b58a5a"; g.fillRect(px, py, T, T);
  g.fillStyle = gold ? "#8f6a12" : "#6b4a2b"; g.fillRect(px, py, 2, T); g.fillRect(px + T - 2, py, 2, T);
  g.fillStyle = gold ? "#1f4a36" : "#8c3b3b"; g.fillRect(px + 3, py + 4, T - 6, 9);
  g.fillStyle = gold ? "#2c6a4c" : "#a84a4a"; g.fillRect(px + 4, py + 5, T - 8, 7);
  if (gold) { g.fillStyle = "#f2c94c"; g.fillRect(px + 7, py + 8, 2, 2); }
}

/** The Bank's vault door, set in the back wall: a round steel door with a gold wheel. */
export function drawVault(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#5c6378"; g.beginPath(); g.arc(px + 8, py + 8, 7.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#8e96ad"; g.beginPath(); g.arc(px + 8, py + 8, 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#6f778f"; g.beginPath(); g.arc(px + 8, py + 8, 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#f2c94c"; g.fillRect(px + 7, py + 3, 2, 10); g.fillRect(px + 3, py + 7, 10, 2);
  g.fillStyle = "#fff1b0"; g.fillRect(px + 7, py + 7, 2, 2);
  g.fillStyle = "#c9ced9"; g.fillRect(px + 2, py + 2, 2, 2); g.fillRect(px + 12, py + 2, 2, 2); g.fillRect(px + 2, py + 12, 2, 2); g.fillRect(px + 12, py + 12, 2, 2);
}
/** Stacked gold bars on the Bank floor. */
export function drawGold(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(px + 1, py + 13, 14, 2);
  const bar = (x: number, y: number) => {
    g.fillStyle = "#a87a14"; g.fillRect(px + x, py + y, 7, 4);
    g.fillStyle = "#f2c94c"; g.fillRect(px + x + 1, py + y, 5, 3);
    g.fillStyle = "#fff1b0"; g.fillRect(px + x + 1, py + y, 5, 1);
  };
  bar(1, 10); bar(8, 10); bar(4, 6); bar(1, 2); bar(8, 2);
}
/** A goal's signpost at the end of its plaza: a wooden board on a post (the map labels it with the goal's words). */
export function drawSignpost(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(px + 5, py + 14, 7, 2);
  g.fillStyle = "#5a3a1a"; g.fillRect(px + 7, py + 6, 2, 9);
  g.fillStyle = "#3b2410"; g.fillRect(px + 1, py + 1, 14, 7);
  g.fillStyle = "#a8743c"; g.fillRect(px + 2, py + 2, 12, 5);
  g.fillStyle = "#fff4dc"; g.fillRect(px + 4, py + 3, 8, 1); g.fillRect(px + 4, py + 5, 6, 1);
}
/** A marble column with gold capitals (the Bank's interior). */
export function drawPillar(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(px + 2, py + 14, 13, 2);
  g.fillStyle = "#d7ad3a"; g.fillRect(px + 2, py, 12, 3); g.fillRect(px + 2, py + 13, 12, 3);
  g.fillStyle = "#f2cf5b"; g.fillRect(px + 2, py, 12, 1); g.fillRect(px + 2, py + 13, 12, 1);
  g.fillStyle = "#f5f0e2"; g.fillRect(px + 4, py + 3, 8, 10);
  g.fillStyle = "#d9cfb6"; g.fillRect(px + 6, py + 3, 1, 10); g.fillRect(px + 9, py + 3, 1, 10);
}
/** The Bank's spending board (Spending tab): a green-screen board on a post, a bar per building of what it spent. */
export function drawSpendingBoard(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.2)"; g.fillRect(px + 4, py + 14, 8, 2);
  g.fillStyle = "#6b4a12"; g.fillRect(px + 7, py + 10, 2, 5);
  g.fillStyle = "#b8862a"; g.fillRect(px + 1, py + 1, 14, 10);
  g.fillStyle = "#14251c"; g.fillRect(px + 2, py + 2, 12, 8);
  g.fillStyle = "#4fd18b";
  for (const [x, h] of [[3, 5], [6, 3], [9, 6], [12, 2]]) g.fillRect(px + x, py + 9 - h, 2, h);
  g.fillStyle = "#f2c94c"; g.fillRect(px + 3, py + 9, 11, 1);
}
/** The Bank's fountain (Free tokens tab), two tiles: a marble basin of water with coins in it; each tile draws its half. */
export function drawBankFountain(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean }) {
  g.fillStyle = "rgba(0,0,0,.18)"; g.fillRect(px, py + 14, T, 2);
  g.fillStyle = "#d9cfb6"; g.fillRect(px, py + 4, T, 11);
  g.fillStyle = "#f5f0e2"; g.fillRect(px, py + 4, T, 2);
  if (!n.l) { g.fillStyle = "#c2b79c"; g.fillRect(px, py + 4, 2, 11); }
  if (!n.r) { g.fillStyle = "#c2b79c"; g.fillRect(px + T - 2, py + 4, 2, 11); }
  g.fillStyle = "#3d7fc4"; g.fillRect(px + (n.l ? 0 : 2), py + 6, T - (n.l ? 0 : 2) - (n.r ? 0 : 2), 7);
  g.fillStyle = "#7fb6e8"; g.fillRect(px + (n.l ? 1 : 3), py + 7, 5, 1);
  g.fillStyle = "#f2c94c"; g.fillRect(px + (n.l ? 3 : 5), py + 10, 2, 2); g.fillRect(px + 10, py + 9, 2, 2);
  if (n.l) { // the spout rises from the middle seam
    g.fillStyle = "#f5f0e2"; g.fillRect(px - 1, py, 2, 6);
    g.fillStyle = "#9fd0f2"; g.fillRect(px - 2, py + 1, 1, 4); g.fillRect(px + 1, py + 1, 1, 4);
  }
}
/** The Bank's ledger desk (Tokens & sources tab), two tiles: a dark-wood desk with an open ledger and a quill; each tile draws its half. */
export function drawBankLedger(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean }) {
  g.fillStyle = "#3b2414"; g.fillRect(px, py + 6, T, 8);
  g.fillStyle = "#5a3920"; g.fillRect(px, py + 6, T, 2);
  g.fillStyle = "#d7ad3a"; g.fillRect(px, py + 5, T, 1);
  g.fillStyle = "#3b2414";
  if (!n.l) g.fillRect(px + 1, py + 14, 2, 2);
  if (!n.r) g.fillRect(px + T - 3, py + 14, 2, 2);
  if (!n.l) { // the open book across the seam
    g.fillStyle = "#f5f0e2"; g.fillRect(px + 8, py + 1, 8, 6);
    g.fillStyle = "#9a9db3"; for (let y = 2; y <= 5; y++) g.fillRect(px + 9, py + y, 6, 1);
  } else {
    g.fillStyle = "#efe6cf"; g.fillRect(px, py + 1, 8, 6);
    g.fillStyle = "#9a9db3"; for (let y = 2; y <= 5; y++) g.fillRect(px + 1, py + y, 5, 1);
    g.fillStyle = "#c0392b"; g.fillRect(px + 2, py + 5, 3, 1);
    g.fillStyle = "#f5f0e2"; g.fillRect(px + 11, py, 1, 6); g.fillRect(px + 12, py, 1, 2);
  }
}
/** The Bank's server rack (Hosting tab: what the Fly.io Machines cost): a black cabinet of blinking units. */
export function drawBankServer(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 2, py + 14, 12, 2);
  g.fillStyle = "#22242e"; g.fillRect(px + 3, py, 10, 15);
  g.fillStyle = "#3a3d4c"; g.fillRect(px + 3, py, 10, 1);
  for (const y of [2, 5, 8, 11]) {
    g.fillStyle = "#3a3d4c"; g.fillRect(px + 4, py + y, 8, 2);
    g.fillStyle = y === 5 ? "#e0a63a" : "#4fd18b"; g.fillRect(px + 10, py + y, 1, 1);
  }
}

/** The manager's desk: a one-tile desk with an in-tray of papers on it. */
export function drawManagerDesk(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#6b4a2b"; g.fillRect(px, py + 7, T, 7);
  g.fillStyle = "#8a6236"; g.fillRect(px + 1, py + 8, T - 2, 5);
  g.fillStyle = "#a8774a"; g.fillRect(px + 1, py + 8, T - 2, 1);
  g.fillStyle = "#6b4a2b"; g.fillRect(px + 1, py + 14, 2, 2); g.fillRect(px + T - 3, py + 14, 2, 2);
  // the tray: a slate box with papers sticking out
  g.fillStyle = "#f2efe6"; g.fillRect(px + 3, py + 1, 7, 5);
  g.fillStyle = "#e8e2d0"; g.fillRect(px + 4, py + 0, 6, 2);
  g.fillStyle = "#9a9db3"; g.fillRect(px + 4, py + 2, 5, 1); g.fillRect(px + 4, py + 4, 4, 1);
  g.fillStyle = "#4a5070"; g.fillRect(px + 2, py + 5, 9, 4);
  g.fillStyle = "#6a7194"; g.fillRect(px + 2, py + 5, 9, 1);
  // nameplate
  g.fillStyle = "#e8b840"; g.fillRect(px + 12, py + 5, 3, 3);
  g.fillStyle = "#b8862a"; g.fillRect(px + 12, py + 7, 3, 1);
}
/** A cork board hung on a wall face (the building board). Draw the wall first. */
export function drawBoard(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#5a3d22"; g.fillRect(px + 1, py + 2, T - 2, 11);
  g.fillStyle = "#c9a26b"; g.fillRect(px + 2, py + 3, T - 4, 9);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 3, py + 4, 4, 4); g.fillRect(px + 9, py + 5, 4, 5);
  g.fillStyle = "#cfe9ff"; g.fillRect(px + 4, py + 8, 4, 3);
  g.fillStyle = "#9a9db3"; g.fillRect(px + 10, py + 7, 2, 1); g.fillRect(px + 4, py + 6, 2, 1);
  g.fillStyle = "#c94f4f"; g.fillRect(px + 5, py + 4, 1, 1); g.fillRect(px + 11, py + 5, 1, 1);
  g.fillStyle = "#4f8fc9"; g.fillRect(px + 6, py + 8, 1, 1);
}
/**
 * The Town Hall goal tree (TILE.GOAL_CHART, place `goal-tree`): a white chart on the back wall with a tiny org chart,
 * one root box over two branches over three leaves. Draw the wall first.
 */
export function drawGoalChart(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#2a2d3a"; g.fillRect(px + 1, py + 2, T - 2, 12);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 2, py + 3, T - 4, 10);
  g.fillStyle = "#6b6f85"; g.fillRect(px + 7, py + 6, 1, 2); g.fillRect(px + 4, py + 7, 8, 1); g.fillRect(px + 4, py + 7, 1, 2); g.fillRect(px + 11, py + 7, 1, 2);
  g.fillStyle = "#e0b04a"; g.fillRect(px + 6, py + 4, 3, 2);
  g.fillStyle = "#4f8fc9"; g.fillRect(px + 3, py + 9, 3, 2); g.fillRect(px + 10, py + 9, 3, 2);
  g.fillStyle = "#5fb36a"; g.fillRect(px + 7, py + 10, 2, 2);
}
/** Filing cabinet stood against a wall face: a grey steel cabinet with three drawers, the top one ajar. Draw the wall first. */
export function drawCabinet(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 3, py + 15, 11, 1);
  g.fillStyle = "#4b5266"; g.fillRect(px + 3, py + 1, 10, 15);
  g.fillStyle = "#7d869e"; g.fillRect(px + 4, py + 2, 8, 13);
  g.fillStyle = "#4b5266"; g.fillRect(px + 4, py + 6, 8, 1); g.fillRect(px + 4, py + 10, 8, 1);
  // drawer pulls and label slots
  g.fillStyle = "#e8e9f0"; g.fillRect(px + 6, py + 8, 4, 1); g.fillRect(px + 6, py + 12, 4, 1);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 7, py + 7, 2, 1); g.fillRect(px + 7, py + 11, 2, 1);
  // top drawer pulled out, folders showing
  g.fillStyle = "#99a2b8"; g.fillRect(px + 3, py + 2, 10, 4);
  g.fillStyle = "#e8b840"; g.fillRect(px + 4, py + 0, 3, 3);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 7, py + 0, 2, 3);
  g.fillStyle = "#7cc4ff"; g.fillRect(px + 9, py + 1, 3, 2);
  g.fillStyle = "#e8e9f0"; g.fillRect(px + 6, py + 4, 4, 1);
}
/** Schedule board: a free-standing whiteboard with a calendar grid. */
export function drawSchedule(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#3a2716"; g.fillRect(px + 2, py + 11, 2, 5); g.fillRect(px + T - 4, py + 11, 2, 5);
  g.fillStyle = "#2a2d3a"; g.fillRect(px, py + 1, T, 11);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 1, py + 2, T - 2, 9);
  g.fillStyle = "#c79bff"; g.fillRect(px + 1, py + 2, T - 2, 2);
  g.fillStyle = "#c5c8d6";
  for (let x = 5; x < T - 1; x += 4) g.fillRect(px + x, py + 4, 1, 7);
  g.fillRect(px + 1, py + 7, T - 2, 1);
  g.fillStyle = "#6fdc8c"; g.fillRect(px + 2, py + 5, 2, 1);
  g.fillStyle = "#ffcf5e"; g.fillRect(px + 10, py + 5, 2, 1); g.fillRect(px + 6, py + 9, 2, 1);
  g.fillStyle = "#7cc4ff"; g.fillRect(px + 2, py + 9, 2, 1);
}

/**
 * A building's schedule board: the Town Hall's calendar (same frame, page and purple header) hung on the back wall
 * with two binder rings, its days blank. The map draws the active schedules on it (`scheduleMarks`). Draw the wall first.
 */
export function drawWallSchedule(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#2a2d3a"; g.fillRect(px + 1, py + 2, T - 2, 12);
  g.fillStyle = "#f2efe6"; g.fillRect(px + 2, py + 3, T - 4, 10);
  g.fillStyle = "#c79bff"; g.fillRect(px + 2, py + 3, T - 4, 2);
  g.fillStyle = "#c5c8d6";
  for (let x = 5; x < T - 2; x += 3) g.fillRect(px + x, py + 5, 1, 8);
  g.fillRect(px + 2, py + 9, T - 4, 1);
  g.fillStyle = "#9a9db3"; g.fillRect(px + 4, py + 1, 1, 3); g.fillRect(px + T - 5, py + 1, 1, 3);
}

/** v1.4 visitor bench (Town Hall, by the door): a wooden slatted bench against the bottom wall. */
export function drawBench(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean }) {
  g.fillStyle = "rgba(0,0,0,.22)"; g.fillRect(px, py + 13, T, 2);
  // back rest against the wall, then the seat with slats
  g.fillStyle = "#5a3a1f"; g.fillRect(px + (n.l ? 0 : 1), py + 2, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 5);
  g.fillStyle = "#946538"; g.fillRect(px + (n.l ? 0 : 1), py + 3, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 1); g.fillRect(px + (n.l ? 0 : 1), py + 5, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 1);
  g.fillStyle = "#a8774a"; g.fillRect(px + (n.l ? 0 : 1), py + 7, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 4);
  g.fillStyle = "#c08a55"; g.fillRect(px + (n.l ? 0 : 1), py + 7, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 1);
  g.fillStyle = "#7a5230"; g.fillRect(px + (n.l ? 0 : 1), py + 9, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 1);
  // legs at the run's ends
  g.fillStyle = "#4a3018";
  if (!n.l) g.fillRect(px + 2, py + 11, 2, 3);
  if (!n.r) g.fillRect(px + T - 4, py + 11, 2, 3);
}

/** The Bank's town map: a parchment map of little buildings on a gold-framed stand, with a gold route between them. */
export function drawBankMap(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 2, py + 14, 12, 2);
  // legs, then the gold frame and the parchment
  g.fillStyle = "#6b4a12"; g.fillRect(px + 3, py + 11, 2, 4); g.fillRect(px + T - 5, py + 11, 2, 4);
  g.fillStyle = "#b8862a"; g.fillRect(px, py + 1, T, 11);
  g.fillStyle = "#f2c94c"; g.fillRect(px, py + 1, T, 1); g.fillRect(px, py + 1, 1, 11);
  g.fillStyle = "#efe2bf"; g.fillRect(px + 1, py + 2, T - 2, 9);
  g.fillStyle = "#d9c79a"; g.fillRect(px + 1, py + 7, T - 2, 1);
  // three little buildings, the bank (gold) in the middle
  g.fillStyle = "#7a8fb5"; g.fillRect(px + 2, py + 4, 3, 2);
  g.fillStyle = "#e8b840"; g.fillRect(px + 6, py + 3, 4, 3);
  g.fillStyle = "#86b06b"; g.fillRect(px + 11, py + 4, 3, 2);
  // the flow: a gold dotted route from the bank to each
  g.fillStyle = "#c9962c";
  g.fillRect(px + 3, py + 8, 1, 1); g.fillRect(px + 5, py + 9, 1, 1); g.fillRect(px + 7, py + 8, 2, 1);
  g.fillRect(px + 10, py + 9, 1, 1); g.fillRect(px + 12, py + 8, 1, 1);
}

/** The Town Hall map table, 5 x 2 tiles (TILE.TOWN_MAP; place `town-map` opens town planning): one sheet, each tile draws its slice. */
const TOWN_MAP_SIZE = { w: 5, h: 2 } as const;
let townMapSheet: HTMLCanvasElement | null = null;
function townMapArt(): HTMLCanvasElement {
  if (townMapSheet) return townMapSheet;
  const W = TOWN_MAP_SIZE.w * T, H = TOWN_MAP_SIZE.h * T;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d")!;
  const r = (x: number, y: number, w: number, h: number, col: string) => { g.fillStyle = col; g.fillRect(x, y, w, h); };
  // shadow and legs, the wooden table, then the map spread on it
  r(3, H - 3, W - 6, 3, "rgba(0,0,0,.25)");
  r(3, H - 7, 3, 6, "#4a3018"); r(W - 6, H - 7, 3, 6, "#4a3018");
  r(0, 1, W, H - 7, "#5a3a1f"); r(0, 1, W, 1, "#a8774a"); r(1, 2, W - 2, H - 10, "#946538");
  const mx = 3, my = 3, mw = W - 6, mh = H - 13;
  r(mx, my, mw, mh, "#e9dcb4"); r(mx, my, mw, 1, "#f6edcf"); r(mx, my + mh - 1, mw, 1, "#cdbb8c");
  // grass patches, the river, the road across the middle with the Bank south of it
  r(mx + 1, my + 1, mw - 2, mh - 2, "#cfe0a8");
  for (let x = 0; x < mw - 2; x++) r(mx + 1 + x, my + 2 + Math.round(1.5 + 1.5 * Math.sin(x / 5)), 1, 2, "#7fb3d9");
  const ry = my + Math.floor(mh / 2);
  r(mx + 1, ry, mw - 2, 2, "#c9b587"); r(mx + 1, ry, mw - 2, 1, "#d6c497");
  // buildings north of the road (the Town Hall the biggest, stone grey), more to the south, the Bank in gold
  const lots: [number, number, number, number, string][] = [
    [6, ry - 6, 8, 5, "#8b90a6"], [17, ry - 5, 6, 4, "#b58a5a"], [26, ry - 5, 7, 4, "#b58a5a"], [36, ry - 6, 9, 5, "#4f8fc9"], [48, ry - 5, 6, 4, "#b58a5a"], [57, ry - 5, 7, 4, "#86b06b"], [66, ry - 6, 6, 5, "#b58a5a"],
    [10, ry + 3, 7, 4, "#b58a5a"], [22, ry + 3, 8, 4, "#e8b840"], [35, ry + 3, 6, 4, "#c94f4f"], [46, ry + 3, 8, 4, "#b58a5a"], [60, ry + 3, 7, 4, "#86b06b"],
  ];
  for (const [x, y, w, h, col] of lots) { r(mx + x, y, w, h, "#2e3248"); r(mx + x + 1, y + 1, w - 2, h - 2, col); r(mx + x + Math.floor(w / 2), y + h - 1, 1, 1, "#efe2bf"); }
  // a red pin on the Town Hall and a compass rose in the corner
  r(mx + 9, ry - 9, 2, 2, "#d9483b"); r(mx + 9, ry - 7, 1, 2, "#5a3a1f");
  r(mx + mw - 6, my + 1, 1, 5, "#5a3a1f"); r(mx + mw - 8, my + 3, 5, 1, "#5a3a1f"); r(mx + mw - 6, my + 1, 1, 1, "#d9483b");
  townMapSheet = c;
  return c;
}
/** One tile of the map table: `ix`, `iy` = the tile's column and row within the table. */
export function drawTownMap(g: CanvasRenderingContext2D, px: number, py: number, ix: number, iy: number) {
  g.drawImage(townMapArt(), (ix % TOWN_MAP_SIZE.w) * T, (iy % TOWN_MAP_SIZE.h) * T, T, T, px, py, T, T);
}

export type IconKind = "library" | "outbox" | "meeting" | "building" | "admin" | "intray" | "board" | "cabinet" | "schedule" | "mod" | "planning" | "bank" | "goals";
const iconCache = new Map<string, string>();
/** Tile-art icons for panel headers (2x scale). */
export function iconUrl(kind: IconKind): string {
  const hit = iconCache.get(kind);
  if (hit) return hit;
  const tl = tiles();
  const c = document.createElement("canvas");
  c.width = T * 2; c.height = T * 2;
  const g = c.getContext("2d")!;
  g.imageSmoothingEnabled = false;
  g.scale(2, 2);
  switch (kind) {
    case "library": g.drawImage(tl.shelf, 0, 0); break;
    case "outbox": drawCounter(g, 0, 2, { l: false, r: false }, true); break;
    case "meeting": drawChair(g, 0, -4, "down"); drawTable(g, 0, 2, { l: false, r: false, u: false, d: false }); break;
    case "admin": g.drawImage(tl.plant, 2, 0); break;
    case "intray": drawManagerDesk(g, 0, 0); break;
    case "board": g.drawImage(tl.wallFace, 0, 0); drawBoard(g, 0, 0); break;
    case "cabinet": g.drawImage(tl.wallFace, 0, 0); drawCabinet(g, 0, 0); break;
    case "bank": drawGold(g, 0, 0); break;
    case "schedule": drawSchedule(g, 0, 0); break;
    case "goals": g.drawImage(tl.wallFace, 0, 0); drawGoalChart(g, 0, 0); break;
    case "mod": g.drawImage(tl.deskL, 0, 0); g.fillStyle = "#7a8a6a"; g.fillRect(9, 9, 5, 4); g.fillStyle = "#e8e9f0"; g.fillRect(10, 10, 3, 1); break;
    case "planning": {
      g.drawImage(tl.deskL, 0, 0);
      // a rolled-out plan
      g.fillStyle = "#cfe9ff"; g.fillRect(3, 6, 10, 5);
      g.fillStyle = "#4f8fc9"; g.fillRect(4, 7, 3, 3); g.fillRect(8, 8, 4, 1); g.fillRect(8, 10, 3, 1);
      break;
    }
    case "building": {
      g.drawImage(tl.wallFace, 0, 2);
      g.fillStyle = "#2e3248"; g.fillRect(0, 0, T, 3);
      g.fillStyle = "#b58a5a"; g.fillRect(5, 8, 6, 8);
      g.fillStyle = "#8c3b3b"; g.fillRect(6, 9, 4, 7);
      g.fillStyle = "#ffcf5e"; g.fillRect(2, 6, 2, 2); g.fillRect(12, 6, 2, 2);
      break;
    }
  }
  const url = c.toDataURL();
  iconCache.set(kind, url);
  return url;
}

// ---------- the town's dressing (map shape "fountain": core world/square.ts) ----------
/** A round-crowned tree on the grass: its crown spills up over the tile above (tiles are drawn top to bottom). */
export function drawTree(g: CanvasRenderingContext2D, px: number, py: number, alt: boolean) {
  g.fillStyle = "rgba(0,0,0,.22)"; g.fillRect(px + 2, py + 12, 12, 3);
  g.fillStyle = "#6b4a2b"; g.fillRect(px + 7, py + 7, 3, 8);
  g.fillStyle = "#57391f"; g.fillRect(px + 9, py + 7, 1, 8);
  const [dark, mid, light] = alt ? ["#2f6e3a", "#3f8f4f", "#6fbf6f"] : ["#356b2c", "#4c8a3a", "#86c25a"];
  g.fillStyle = dark; g.fillRect(px + 1, py - 4, 14, 12); g.fillRect(px + 3, py - 6, 10, 16);
  g.fillStyle = mid; g.fillRect(px + 2, py - 5, 11, 10); g.fillRect(px + 4, py - 6, 7, 13);
  g.fillStyle = light; g.fillRect(px + 4, py - 4, 4, 3); g.fillRect(px + 3, py - 2, 2, 2); g.fillRect(px + 9, py - 3, 2, 1);
  if (alt) { g.fillStyle = "#e86a6a"; g.fillRect(px + 10, py, 2, 2); g.fillRect(px + 5, py + 3, 2, 2); g.fillRect(px + 11, py - 4, 1, 1); }
}
/** A street lamp: an iron post with a warm lantern, its glow on the ground. */
export function drawLamp(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(255,214,120,.18)"; g.fillRect(px + 2, py + 11, 12, 4);
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 6, py + 14, 5, 2);
  g.fillStyle = "#2a2d3a"; g.fillRect(px + 7, py - 2, 2, 16); g.fillRect(px + 5, py + 13, 6, 2);
  g.fillStyle = "#2a2d3a"; g.fillRect(px + 4, py - 8, 8, 7);
  g.fillStyle = "#ffe08a"; g.fillRect(px + 5, py - 7, 6, 5);
  g.fillStyle = "#fff6cf"; g.fillRect(px + 6, py - 6, 2, 2);
  g.fillStyle = "#3a3f58"; g.fillRect(px + 3, py - 9, 10, 2); g.fillRect(px + 6, py - 11, 4, 2);
}
/** A flower bed: a low stone kerb round soil and mixed blooms. */
export function drawFlowers(g: CanvasRenderingContext2D, px: number, py: number, n: { l: boolean; r: boolean }) {
  g.fillStyle = "#8f8370"; g.fillRect(px, py + 4, T, 11);
  g.fillStyle = "#6b4a2b"; g.fillRect(px + (n.l ? 0 : 1), py + 5, T - (n.l ? 0 : 1) - (n.r ? 0 : 1), 9);
  g.fillStyle = "#3f8f4f"; for (let x = 1; x < T; x += 3) g.fillRect(px + x, py + 6 + (x % 2), 2, 6);
  const blooms = ["#f2c94c", "#e86a6a", "#f5f0e2", "#b26fd1", "#e86a6a", "#f2c94c"];
  for (let i = 0; i < 6; i++) { g.fillStyle = blooms[(i + px / T) % blooms.length | 0]; g.fillRect(px + 1 + i * 2.5, py + 5 + ((i * 7) % 5), 2, 2); }
  g.fillStyle = "#a89c87"; g.fillRect(px, py + 4, T, 1);
}
let fountainCache: HTMLCanvasElement | null = null;
/** The town square's fountain, three tiles by three: a round stone basin, water, a tiered spout in the middle. */
function grandFountain(): HTMLCanvasElement {
  if (fountainCache) return fountainCache;
  const c = document.createElement("canvas"); c.width = 3 * T; c.height = 3 * T;
  const g = c.getContext("2d")!;
  const disc = (cx: number, cy: number, r: number, color: string) => {
    g.fillStyle = color;
    for (let y = -r; y <= r; y++) { const dx = Math.floor(Math.sqrt(r * r - y * y)); g.fillRect(cx - dx, cy + y, 2 * dx + 1, 1); }
  };
  disc(24, 27, 22, "rgba(0,0,0,.2)");
  disc(24, 25, 22, "#7d766a");
  disc(24, 24, 22, "#c9c1ae");
  disc(24, 24, 19, "#9c9486");
  disc(24, 25, 18, "#2f6fae");
  disc(24, 25, 16, "#3d7fc4");
  g.fillStyle = "#7fb6e8"; g.fillRect(12, 18, 6, 1); g.fillRect(30, 30, 5, 1); g.fillRect(14, 32, 4, 1); g.fillRect(31, 17, 4, 1);
  // ripples round the middle, the tiered spout, its spray
  g.fillStyle = "#9fd0f2"; g.fillRect(16, 25, 2, 1); g.fillRect(31, 25, 2, 1); g.fillRect(23, 33, 3, 1);
  disc(24, 25, 6, "#7d766a"); disc(24, 24, 6, "#c9c1ae"); disc(24, 24, 4, "#5fb4ff");
  g.fillStyle = "#c9c1ae"; g.fillRect(22, 12, 5, 12);
  g.fillStyle = "#e3dccb"; g.fillRect(22, 12, 2, 12);
  disc(24, 12, 3, "#c9c1ae"); disc(24, 11, 2, "#5fb4ff");
  g.fillStyle = "#cfe8fa"; g.fillRect(23, 3, 3, 8); g.fillRect(20, 5, 2, 6); g.fillRect(27, 5, 2, 6); g.fillRect(18, 9, 1, 4); g.fillRect(30, 9, 1, 4);
  g.fillStyle = "#ffffff"; g.fillRect(24, 3, 1, 4);
  fountainCache = c;
  return c;
}
/** One tile of the square's fountain: (ix, iy) is the tile's place in its 3×3 block. */
export function drawGrandFountain(g: CanvasRenderingContext2D, px: number, py: number, ix: number, iy: number) {
  g.drawImage(grandFountain(), ix * T, iy * T, T, T, px, py, T, T);
}
