import { config } from "../config.ts";
import type { Grade, Item } from "../types.ts";

const ORDER: Grade[] = ["A", "B", "C", "D"];

export function safeUntil(item: Item, listedAt: number) {
  return listedAt + item.safeTime * 60_000;
}

/** The grade the SRS grade table gives for this many safe minutes. */
export function gradeFromSafeTime(minutes: number): Grade {
  const g = config.gradeMinutes;
  return minutes >= g.A ? "A" : minutes >= g.B ? "B" : minutes >= g.C ? "C" : "D";
}

/**
 * Grade and safe time can disagree ("Grade A, safe for 60 min"). The stricter
 * of the two always wins, because safety is never relaxed.
 */
export function effectiveGrade(item: Item): Grade {
  const byTime = gradeFromSafeTime(item.safeTime);
  return ORDER[Math.max(ORDER.indexOf(item.grade), ORDER.indexOf(byTime))];
}

export function isUnsure(item: Item) {
  return item.confidence < config.unsureThreshold;
}
