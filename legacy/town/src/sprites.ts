import Phaser from "phaser";

/** Draw ASCII pixel art onto a canvas. `.` is transparent. */
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

export const CHAR_W = 12, CHAR_H = 16;
const BODY_A = [
  "....HHHH....",
  "...HHHHHH...",
  "...HSSSSH...",
  "...SSESES...",
  "...SSSSSS...",
  "....SSSS....",
  "...BBBBBB...",
  "..BBBBBBBB..",
  "..SBBBBBBS..",
  "..SBBBBBBS..",
  "...BBBBBB...",
  "...PPPPPP...",
  "...PP..PP...",
  "...PP..PP...",
  "...FF..FF...",
  "............",
];
const BODY_B = [
  "....HHHH....",
  "...HHHHHH...",
  "...HSSSSH...",
  "...SSESES...",
  "...SSSSSS...",
  "....SSSS....",
  "...BBBBBB...",
  "..SBBBBBBS..",
  "..SBBBBBBS..",
  "..BBBBBBBB..",
  "...BBBBBB...",
  "...PPPPPP...",
  "...PP..PP...",
  "...PP..PP...",
  "...FF..FF...",
  "............",
];
const PALETTES = [
  { H: "#3b2a22", B: "#c94f4f", P: "#2d3550", S: "#f1c9a5", E: "#222", F: "#2a1d14" }, // 0 librarian
  { H: "#1c1c1c", B: "#4f8fc9", P: "#2f2f3a", S: "#c68642", E: "#111", F: "#2a1d14" }, // 1
  { H: "#d9a441", B: "#5aa66b", P: "#3a3a4a", S: "#f1c9a5", E: "#222", F: "#2a1d14" }, // 2
  { H: "#2b2b2b", B: "#b26fd1", P: "#2d3550", S: "#f6d7bd", E: "#222", F: "#2a1d14" }, // 3
  { H: "#111", B: "#e0a030", P: "#3a2d2d", S: "#8d5524", E: "#000", F: "#2a1d14" },    // 4
  { H: "#c4553a", B: "#3fbfb0", P: "#2f2f3a", S: "#f1c9a5", E: "#222", F: "#2a1d14" }, // 5
  { H: "#6b4f3a", B: "#d85f8f", P: "#2d3550", S: "#f1c9a5", E: "#222", F: "#2a1d14" }, // 6
  { H: "#f0f0f0", B: "#ffffff", P: "#5b7aa6", S: "#f1c9a5", E: "#222", F: "#2a1d14" }, // 7 player
];
export const PLAYER_SPRITE = 7;

const T = 16;
const GRASS = Array.from({ length: T }, (_, y) => Array.from({ length: T }, (_, x) => ((x * 7 + y * 13) % 11 === 0 ? "g" : "G")).join(""));
const PATH = Array.from({ length: T }, (_, y) => Array.from({ length: T }, (_, x) => ((x * 5 + y * 3) % 9 === 0 ? "p" : "P")).join(""));
const FLOOR = Array.from({ length: T }, (_, y) => Array.from({ length: T }, (_, x) => (y % 8 === 7 || (x + (y < 8 ? 0 : 8)) % 16 === 15 ? "f" : "F")).join(""));
const WALL = Array.from({ length: T }, (_, y) => Array.from({ length: T }, (_, x) => (y === 0 ? "w" : y < 10 ? ((x + (y % 4 < 2 ? 0 : 4)) % 8 === 7 || y % 4 === 1 ? "m" : "W") : "W")).join(""));
const DESK = [
  "................................",
  "................................",
  "..........MMMMMMMMMMMM..........",
  "..........MssssssssssM..........",
  "..........MsssssssssSM..........",
  "..........MssssssssssM..........",
  "..........MMMMMMMMMMMM..........",
  ".............MM.MM..............",
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
  "BBBBBBBBBBBBBBBB","BrrggbbrrggbbrrB","BrrggbbrrggbbrrB","BrrggbbrrggbbrrB","BBBBBBBBBBBBBBBB","BggbbrrggbbrrggB","BggbbrrggbbrrggB","BggbbrrggbbrrggB","BBBBBBBBBBBBBBBB","BbbrrggbbrrggbbB","BbbrrggbbrrggbbB","BbbrrggbbrrggbbB","BBBBBBBBBBBBBBBB","BBBBBBBBBBBBBBBB",".BB..........BB.",".BB..........BB.",
];
const PLANT = [
  "................","......LL........","....LLLLLL......","...LLLlLLLL.....","..LLlLLLLlLL....","..LLLLlLLLLL....","...LLLLLLLL.....","....LLLLLL......",".....LLLL.......","......tt........","......tt........","....oooooo......","....oooooo......",".....oooo.......",".....oooo.......","................",
];
const TILE_PAL: Record<string, string> = {
  G: "#5f9e4f", g: "#6fae5f", P: "#c9b587", p: "#b9a577", F: "#b58a5a", f: "#9c7347",
  W: "#4d5370", w: "#2e3248", m: "#3f4460",
  M: "#2a2d3a", s: "#5fb4ff", S: "#cfe9ff", D: "#6b4a2b", d: "#8a6236", K: "#2a2d3a",
  B: "#5a3d22", r: "#c94f4f", b: "#4f8fc9", L: "#3f8f4f", l: "#6fbf6f", t: "#6b4a2b", o: "#a0522d",
};

export function makeTextures(scene: Phaser.Scene): void {
  const tiles: Record<string, string[]> = { grass: GRASS, path: PATH, floor: FLOOR, wall: WALL, desk: DESK, shelf: SHELF, plant: PLANT };
  for (const [k, rows] of Object.entries(tiles)) scene.textures.addCanvas(k, pixelCanvas([rows], TILE_PAL));
  PALETTES.forEach((pal, i) => {
    scene.textures.addSpriteSheet(`char${i}`, pixelCanvas([BODY_A, BODY_B], pal) as any, { frameWidth: CHAR_W, frameHeight: CHAR_H });
    scene.anims.create({ key: `type${i}`, frames: scene.anims.generateFrameNumbers(`char${i}`, { start: 0, end: 1 }), frameRate: 4, repeat: -1 });
  });
}
