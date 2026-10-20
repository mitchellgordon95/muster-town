/**
 * Procedural pixel art, ported from legacy/town/src/sprites.ts (Phaser) to plain canvases.
 * Characters are 12x16 with three frames (stand, type, walk); tiles are 16x16.
 */
export const T = 16;
export const CHAR_W = 12, CHAR_H = 16;

/** Draw ASCII pixel art onto a canvas, frames side by side. `.` is transparent. */
export function pixelCanvas(frames: string[][], palette: Record<string, string>): HTMLCanvasElement {
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
export const PALETTES: Record<string, string>[] = [
  { H: "#3b2a22", B: "#c94f4f", P: "#2d3550", S: SKIN[0] }, // 0 librarian
  { H: "#1c1c1c", B: "#4f8fc9", P: "#2f2f3a", S: SKIN[1] },
  { H: "#d9a441", B: "#5aa66b", P: "#3a3a4a", S: SKIN[0] },
  { H: "#2b2b2b", B: "#b26fd1", P: "#2d3550", S: SKIN[2] },
  { H: "#111111", B: "#e0a030", P: "#3a2d2d", S: SKIN[3] },
  { H: "#c4553a", B: "#3fbfb0", P: "#2f2f3a", S: SKIN[0] },
  { H: "#6b4f3a", B: "#d85f8f", P: "#2d3550", S: SKIN[0] },
  { H: "#f0f0f0", B: "#ffffff", P: "#5b7aa6", S: SKIN[0] }, // 7 human player
  { H: "#5b5f6b", B: "#7a8a6a", P: "#33363f", S: SKIN[4] }, // 8 moderator
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
const TROPHY = [
  "................", ".KKKKKKKKKKKKKK.", ".KccccccccccccK.", ".KcYYYYYYYYYYcK.", ".KYcYYYYYYYYcYK.", ".KYcYYYYYYyYcYK.",
  ".KcYYYYYYyYYccK.", ".KccYYYYyYYcccK.", ".KcccYYYYYccccK.", ".KccccYYYcccccK.", ".KcccyYYYYccccK.",
  ".KccyyyyyyyyccK.", ".KKKKKKKKKKKKKK.", ".KDDDDDDDDDDDDK.", ".KKKKKKKKKKKKKK.", ".KK..........KK.",
];
const PAL: Record<string, string> = {
  G: "#5f9e4f", g: "#6fae5f", h: "#e9d77a", P: "#c9b587", p: "#b9a577", q: "#d6c497",
  F: "#b58a5a", f: "#9c7347", N: "#8b90a6", o: "#9499ae", n: "#767b92",
  W: "#4d5370", w: "#2e3248", m: "#3f4460", x: "#3a3f58", u: "#30344a", v: "#383c54",
  M: "#2a2d3a", s: "#5fb4ff", S: "#cfe9ff", D: "#6b4a2b", d: "#8a6236", K: "#2a2d3a", c: "#e8e2d0",
  B: "#5a3d22", r: "#c94f4f", b: "#4f8fc9", L: "#3f8f4f", l: "#6fbf6f", t: "#6b4a2b", O: "#a0522d",
  Y: "#e8b840", y: "#b8862a",
};
const TROPHY_PAL = { ...PAL, c: "#2b3d55", K: "#3a2a1a" };
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
    stone: pixelCanvas([STONE], PAL), wallFace: pixelCanvas([WALL_FACE], PAL), wallTop: pixelCanvas([WALL_TOP], PAL),
    deskL: half(0), deskR: half(T), deskPlain: plainDesk(deskSheet), shelf: pixelCanvas([SHELF], PAL), plant: pixelCanvas([PLANT], PLANT_PAL),
    trophy: pixelCanvas([TROPHY], TROPHY_PAL),
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
export function drawDoor(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "#b58a5a"; g.fillRect(px, py, T, T);
  g.fillStyle = "#6b4a2b"; g.fillRect(px, py, 2, T); g.fillRect(px + T - 2, py, 2, T);
  g.fillStyle = "#8c3b3b"; g.fillRect(px + 3, py + 4, T - 6, 9);
  g.fillStyle = "#a84a4a"; g.fillRect(px + 4, py + 5, T - 8, 7);
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
/** Donation box: a blue box with a coin slot and a gold coin going in. */
export function drawDonation(g: CanvasRenderingContext2D, px: number, py: number) {
  g.fillStyle = "rgba(0,0,0,.25)"; g.fillRect(px + 3, py + 14, 11, 2);
  g.fillStyle = "#2f5f93"; g.fillRect(px + 3, py + 6, 10, 9);
  g.fillStyle = "#3d78b5"; g.fillRect(px + 4, py + 7, 8, 7);
  g.fillStyle = "#24496f"; g.fillRect(px + 3, py + 5, 10, 2);
  g.fillStyle = "#14151c"; g.fillRect(px + 6, py + 5, 4, 1);
  g.fillStyle = "#e8b840"; g.fillRect(px + 7, py + 1, 2, 4);
  g.fillStyle = "#b8862a"; g.fillRect(px + 8, py + 1, 1, 4);
  // heart
  g.fillStyle = "#ff8fa3"; g.fillRect(px + 6, py + 9, 1, 2); g.fillRect(px + 9, py + 9, 1, 2); g.fillRect(px + 7, py + 10, 2, 2);
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

export type IconKind = "library" | "trophy" | "outbox" | "meeting" | "building" | "admin" | "intray" | "board" | "cabinet" | "donation" | "schedule" | "mod" | "planning";
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
    case "trophy": g.drawImage(tl.trophy, 0, 0); break;
    case "outbox": drawCounter(g, 0, 2, { l: false, r: false }, true); break;
    case "meeting": drawChair(g, 0, -4, "down"); drawTable(g, 0, 2, { l: false, r: false, u: false, d: false }); break;
    case "admin": g.drawImage(tl.plant, 2, 0); break;
    case "intray": drawManagerDesk(g, 0, 0); break;
    case "board": g.drawImage(tl.wallFace, 0, 0); drawBoard(g, 0, 0); break;
    case "cabinet": g.drawImage(tl.wallFace, 0, 0); drawCabinet(g, 0, 0); break;
    case "donation": drawDonation(g, 0, 0); break;
    case "schedule": drawSchedule(g, 0, 0); break;
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
