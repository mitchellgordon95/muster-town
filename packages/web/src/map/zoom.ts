/**
 * The walking zoom the map starts at, from the viewport: a phone (canvas narrower than 600 CSS px, or a touch screen)
 * starts at 2 so more of the street shows around the guest; a laptop starts at 3. Signs and bubbles are drawn in screen
 * px, so their text stays the same size at either zoom. The -/+ keys still change it (2..5), and then it stays put.
 */
const PHONE_WIDTH = 600;

export function defaultZoom(canvasWidth: number, coarsePointer: boolean): number {
  return canvasWidth < PHONE_WIDTH || coarsePointer ? 2 : 3;
}

/** whether the main pointer is a finger (phones, tablets) */
export function coarsePointer(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
}
