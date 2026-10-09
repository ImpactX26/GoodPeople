/**
 * Step 2: score the recipients that passed Step 1. Returns each factor so the
 * reason text can explain why the winner won.
 */
import { config } from "../config.ts";
import { HUNGER_SCORE, type HungerProvider } from "../hooks.ts";
import { KNOWN_DIETS, type Item, type Listing, type Recipient } from "../types.ts";
import type { Leg } from "./rules.ts";
import { effectiveGrade, safeUntil } from "./safety.ts";

export type Factor = keyof typeof config.weights;

export interface Scored {
  recipient: Recipient;
  leg: Leg;
  score: number;
  /** Weighted contribution of each factor. */
  factors: Record<Factor, number>;
}

export interface RankContext {
  now: number;
  hunger: HungerProvider;
  /** Recipients owed priority after an earlier redirect. */
  credits: ReadonlySet<string>;
  /** Areas a donor pledged food to after a gap request. */
  pledgedAreas: ReadonlySet<string>;
  capLeft(r: Recipient): number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** How much an NGO's own "we need food" counts. */
const NEED = { LOW: 0, MEDIUM: 0, HIGH: 0.7, CRITICAL: 1 } as const;

export function rank(item: Item, listing: Listing, feasible: { recipient: Recipient; leg: Leg }[], ctx: RankContext): Scored[] {
  const w = config.weights;
  const until = safeUntil(item, listing.createdAt);
  const window = Math.max(1, until - ctx.now);
  const gradeA = effectiveGrade(item) === "A";

  const scored = feasible.map(({ recipient: r, leg }) => {
    const accepted = KNOWN_DIETS.filter((d) => r.acceptsDiet.includes(d)).length;
    const raw: Record<Factor, number> = {
      urgency: 1 - clamp01((leg.serveTime - ctx.now) / window),
      proximity: 1 - clamp01(leg.dropKm / config.proximityZeroKm),
      fit: 0.6 * clamp01(ctx.capLeft(r) / item.servings) + 0.4 * (leg.dropKm <= r.acceptRadiusKm ? 1 : 0),
      specialisation: clamp01(1 - (accepted - 1) / (KNOWN_DIETS.length - 1)),
      underserved: HUNGER_SCORE[ctx.hunger.level(r.id, ctx.now)],
      priority: ctx.credits.has(r.id) ? 1 : 0,
      vulnerableBonus: gradeA && r.vulnerable ? 1 : 0,
      pledgeBonus: ctx.pledgedAreas.has(r.areaId) ? 1 : 0,
      needBonus: NEED[r.urgency ?? "MEDIUM"],
    };
    const factors = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v * w[k as Factor]])) as Record<Factor, number>;
    const score = Object.values(factors).reduce((a, b) => a + b, 0);
    return { recipient: r, leg, score, factors };
  });
  return scored.sort((a, b) => b.score - a.score || a.recipient.id.localeCompare(b.recipient.id));
}
