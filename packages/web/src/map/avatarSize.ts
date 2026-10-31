/** Avatar size by model tier: bigger models get bigger bodies. XL (Fable, Astra) ~1.25x, standard (Opus, Sol) 1x, small (Sonnet, Luna, Haiku) ~0.85x; unknown or unset models are standard. */
import { CHAR_W, CHAR_H } from "./sprites";

type ModelTier = "xl" | "standard" | "small";

export function modelTier(model: string | null | undefined): ModelTier {
  const m = (model ?? "").toLowerCase();
  if (/fable|astra/.test(m)) return "xl";
  if (/sonnet|luna|haiku/.test(m)) return "small";
  return "standard";
}

/** drawn body size in world pixels, whole pixels so the pixel art stays crisp: 15×20 (1.25x), 12×16, 10×14 (~0.85x). Every size is narrower than a tile, so neighbours at desks and meeting seats don't overlap sideways. */
const AVATAR_SIZE: Record<ModelTier, { w: number; h: number }> = {
  xl: { w: 15, h: 20 },
  standard: { w: CHAR_W, h: CHAR_H },
  small: { w: 10, h: 14 },
};

/** the agent's configured model (its own, else its home building's), as a body size */
export function avatarSize(model: string | null | undefined, buildingModel?: string | null): { w: number; h: number } {
  return AVATAR_SIZE[modelTier(model || buildingModel)];
}
