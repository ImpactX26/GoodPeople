/**
 * Seam for Feature 4 (Fair Share). Another team owns hunger levels; until they
 * plug in, every recipient is "normal".
 */
import type { ReasonCode, Recipient } from "./types.ts";

export type HungerLevel = "normal" | "boost" | "relax" | "reserve" | "hunt" | "escalate";

export interface HungerProvider {
  level(recipientId: string, now: number): HungerLevel;
  /** Fair Share may widen preferences; it must never touch safety or diet rules. */
  relaxedPreferences?(r: Recipient, now: number): Partial<Pick<Recipient, "acceptRadiusKm" | "capacityPerDelivery">>;
  /** Told whenever a recipient is skipped and why, so Fair Share can learn from it. */
  onSkipped?(recipientId: string, code: ReasonCode, listingId: string): void;
}

export const defaultHunger: HungerProvider = { level: () => "normal" };

export const HUNGER_SCORE: Record<HungerLevel, number> = {
  normal: 0,
  boost: 0.25,
  relax: 0.4,
  reserve: 0.6,
  hunt: 0.8,
  escalate: 1,
};
