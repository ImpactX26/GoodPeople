/**
 * The Food Agent's collect-by suggestion. The listing form starts at "collect within 1 hour", a guess made
 * before the food is checked. Once it is, the Food Agent knows how long each food stays safe, so it works out
 * how long the food can really wait for a partner (leaving time to reach an NGO and serve it) and, when that's
 * well off the restaurant's time, suggests it. The restaurant decides; nothing changes without them.
 */
import { config } from "./config.ts";
import { legFor, pickupEstimate } from "./engine/match.ts";
import { hhmm } from "./engine/reasons.ts";
import { checkRecipient, openAt } from "./engine/rules.ts";
import { safeUntil } from "./engine/safety.ts";
import { countdown, usable } from "./runtime.ts";
import type { MatchingStore } from "./store.ts";
import type { Listing, Recipient } from "./types.ts";

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

/* ---------- with the NGOs: the NGO Agent's view of who could take it, and when ---------- */


export interface CollectAdvice {
  suggested: number;
  safeUntil: number;
  /** In plain words, why this time (which NGOs it lets take the food, or the food's safety). */
  why: string;
}

/** NGOs that could safely take some of this food if it were collected at `pickupAt` (every NGO rule applies). */
function takersAt(l: Listing, ngos: Recipient[], pickupAt: number) {
  return ngos.filter((r) => l.items.some((i) => checkRecipient(i, l, r, legFor(r, l, { pos: l, startAt: pickupAt, travel: "two_wheeler", pickedUp: true })).ok));
}

const urgent = (r: Recipient) => r.urgency === "HIGH" || r.urgency === "CRITICAL";
const named = (rs: Recipient[], now: number) =>
  rs.slice(0, 2).map((r) => `${r.name}${r.receivingHours && !openAt(r.receivingHours, now) ? ` (opens ${hhmm(r.receivingHours.start)})` : urgent(r) ? " (needs food urgently)" : ""}`).join(" and ") + (rs.length > 2 ? ` and ${rs.length - 2} more` : "");

/**
 * The collect-by time, judged with the NGOs and the partners, not the food alone.
 *
 * Collecting later never lets an extra NGO take the food: an NGO's serving time only moves later with a later
 * pickup, and food that arrives before an NGO opens waits for it. What a longer window buys is time for the
 * agents to work: an NGO to say yes (the offer countdown), a partner to accept, and the partner to ride there.
 * So the question is whether the restaurant's time leaves enough of that:
 *   - the food won't stay safe until the restaurant's time: collect sooner (safety first);
 *   - an NGO that needs food urgently can take it, or the restaurant's time already leaves the agents enough
 *     time to get a partner there: nothing to suggest;
 *   - the restaurant's time is too tight to get a partner there, but an NGO could still serve the food safely if
 *     it's collected later: suggest the latest time that NGO still can (never past the food's own limit).
 */
export async function adviseCollectBy(store: MatchingStore, l: Listing, now: number): Promise<CollectAdvice | null> {
  const forPeople = l.items.filter((i) => i.grade !== "D");
  if (!forPeople.length) return null;
  const firstUnsafe = Math.min(...forPeople.map((i) => safeUntil(i, l.createdAt)));
  const latest = Math.floor(Math.min(firstUnsafe - DELIVER_AND_SERVE_MS, now + MAX_AHEAD_MS) / QUARTER) * QUARTER;
  if (latest < l.collectBy - WORTH_MS)
    return latest >= now + MIN_AHEAD_MS ? { suggested: latest, safeUntil: firstUnsafe, why: "the food is only safe until then, with time to reach an NGO and serve it" } : null;

  const ngos = usable(await store.list("recipient")).filter((r) => r.active && r.kind !== "biogas" && r.kind !== "compost" && r.kind !== "animal_shelter");
  // When the agents could realistically have a partner at the restaurant: an NGO's yes, a partner's yes, the ride.
  const lines = forPeople.map((i) => ({ itemId: i.id, servings: i.servings }));
  const ride = pickupEstimate(l, usable(await store.list("partner")), now).at - now;
  const ready = Math.max(l.readyFrom, now + countdown(l, lines, now) + config.partnerAcceptMs + ride);
  const takersSoon = takersAt(l, ngos, ready);
  if (!takersSoon.length) return null;                       // no NGO could take it at all: biogas handles that
  if (takersSoon.some(urgent) && l.collectBy >= ready) return null;
  if (l.collectBy >= ready) return null;                     // the restaurant's time already leaves enough
  // Too tight: the latest quarter hour, up to the food's limit, at which those NGOs could still take it.
  let last = 0;
  for (let t = Math.ceil(ready / QUARTER) * QUARTER; t <= latest; t += QUARTER) if (takersAt(l, takersSoon, t).length) last = t;
  if (!last || last < l.collectBy + WORTH_MS) return null;
  const who = takersAt(l, takersSoon, last).sort((a, b) => Number(urgent(b)) - Number(urgent(a)));
  return {
    suggested: last,
    safeUntil: firstUnsafe,
    why: `getting an NGO's yes and a partner to you takes about ${Math.round((ready - now) / 60_000)} minutes, more than your time allows, and ${named(who, now)} can still serve it safely if it's collected by then`,
  };
}
