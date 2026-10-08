/**
 * The Food Agent's collect-by suggestion. The listing form starts at "collect within 1 hour", a guess made
 * before the food is checked. Once it is, the Food Agent knows how long each food stays safe, so it works out
 * how long the food can really wait for a partner (leaving time to reach an NGO and serve it) and, when that's
 * well off the restaurant's time, suggests it. The restaurant decides; nothing changes without them.
 */
import { safeUntil } from "./engine/safety.ts";
import type { Listing } from "./types.ts";

/** Time to leave between collection and the food stopping being safe: the ride to an NGO and serving it. */
export const DELIVER_AND_SERVE_MS = 45 * 60_000;
/** Only worth suggesting when it moves the time by at least this much. */
const WORTH_MS = 15 * 60_000;
/** Never suggest a window shorter than this from now. */
const MIN_AHEAD_MS = 20 * 60_000;
/** Nor longer than the restaurant would plausibly keep food aside. */
const MAX_AHEAD_MS = 6 * 60 * 60_000;

const QUARTER = 15 * 60_000;

/**
 * The latest the food can be collected so every food in it still reaches an NGO and is served while it's safe,
 * rounded down to the quarter hour; null when the restaurant's own time is already about right.
 */
export function suggestCollectBy(l: Listing, now: number): { suggested: number; safeUntil: number } | null {
  const forPeople = l.items.filter((i) => i.grade !== "D");
  if (!forPeople.length) return null;
  const firstUnsafe = Math.min(...forPeople.map((i) => safeUntil(i, l.createdAt)));
  const latest = Math.min(firstUnsafe - DELIVER_AND_SERVE_MS, now + MAX_AHEAD_MS);
  const suggested = Math.floor(latest / QUARTER) * QUARTER;
  if (suggested < now + MIN_AHEAD_MS) return null;
  if (Math.abs(suggested - l.collectBy) < WORTH_MS) return null;
  return { suggested, safeUntil: firstUnsafe };
}
