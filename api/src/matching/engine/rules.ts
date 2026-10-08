/**
 * Step 1: rule out recipients that can't safely take an item. These rules are
 * never relaxed, by preferences, Fair Share or anything else. First failure wins.
 */
import { config } from "../config.ts";
import { istClock, nextClockTime, parseClock } from "../time.ts";
import { KNOWN_DIETS, type Item, type Listing, type ReasonCode, type Recipient } from "../types.ts";
import { effectiveGrade, safeUntil } from "./safety.ts";

export interface Leg {
  /** When the food reaches the recipient. */
  arrival: number;
  /** When the recipient actually serves it. */
  serveTime: number;
  dropKm: number;
  /** The NGO is closed when the food could get there, so the drop waits for it to open. */
  waitsForOpening?: boolean;
}

export type RuleResult = { ok: true } | { ok: false; code: ReasonCode; detail: Record<string, unknown> };

const ANIMAL_OR_COMPOST = new Set(["animal_shelter", "compost"]);

/** Whether a delivery arriving at `ms` lands inside the NGO's receiving hours (India time). */
export function openAt(hours: { start: string; end: string }, ms: number) {
  const m = istClock(ms).minutes, from = parseClock(hours.start), to = parseClock(hours.end);
  return from <= to ? m >= from && m <= to : m >= from || m <= to;   // overnight hours wrap past midnight
}

/**
 * When the NGO serves food that reaches it at `arrival`. Outside its receiving hours it's taken in at the next
 * opening (e.g. listed at 6:40 am, NGO opens at 8 am); EXPIRES_BEFORE_SERVING then decides if that's still safe.
 */
export function serveTimeFor(r: Recipient, arrival: number) {
  const received = r.receivingHours && !openAt(r.receivingHours, arrival) ? nextClockTime(arrival, [r.receivingHours.start]) : arrival;
  return r.servingTimes.length ? nextClockTime(received, r.servingTimes) : received + r.servesWithinMin * 60_000;
}

function dietProblem(item: Item, r: Recipient): string | null {
  if (item.diet === "unknown") {
    if (!KNOWN_DIETS.every((d) => r.acceptsDiet.includes(d))) return "diet not stated; they have dietary rules";
  } else if (!r.acceptsDiet.includes(item.diet)) {
    return `food is ${item.diet}; they accept ${r.acceptsDiet.join(", ")}`;
  }
  if (r.halalOnly && (item.diet === "nonveg" || item.diet === "unknown") && !item.halal) return "not halal";
  const clash = (item.allergens ?? []).filter((a) => r.avoidAllergens.includes(a));
  if (clash.length) return `contains ${clash.join(", ")}`;
  return null;
}

export function checkRecipient(
  item: Item,
  listing: Listing,
  r: Recipient,
  leg: Leg,
  exclude: ReadonlySet<string> = new Set(),
): RuleResult {
  const grade = effectiveGrade(item);
  const fail = (code: ReasonCode, detail: Record<string, unknown> = {}): RuleResult => ({ ok: false, code, detail });

  // Biogas plants are the restaurant's choice once no NGO can take the food, never part of NGO matching.
  if (!r.active || r.kind === "biogas") return fail("INACTIVE");
  if (exclude.has(r.id)) return fail("EXCLUDED");
  if (grade === "D" && !ANIMAL_OR_COMPOST.has(r.kind)) return fail("GRADE_D_PEOPLE", { kind: r.kind });
  if (grade !== "D" && ANIMAL_OR_COMPOST.has(r.kind)) return fail("PEOPLE_FOOD_ONLY", { grade });
  if (r.vulnerable && grade !== "A") return fail("VULNERABLE_NEEDS_A", { grade, kind: r.kind });
  if (r.acceptsCategories?.length && item.category && !r.acceptsCategories.includes(item.category)) return fail("CATEGORY", { category: item.category });
  if (listing.storage === "fridge" && !r.fridge) return fail("NEEDS_FRIDGE");
  const diet = dietProblem(item, r);
  if (diet) return fail("DIET", { why: diet });
  const until = safeUntil(item, listing.createdAt);
  if (until < leg.serveTime) {
    // Closed when the food would arrive: say so, it's the real reason (not the serving time it leads to).
    const closed = r.receivingHours && (leg.waitsForOpening || !openAt(r.receivingHours, leg.arrival)) ? r.receivingHours : undefined;
    return fail("EXPIRES_BEFORE_SERVING", { safeUntil: until, serveTime: leg.serveTime, ...(closed ? { opens: closed.start, closes: closed.end } : {}) });
  }
  if (grade === "C" && leg.serveTime - leg.arrival > config.gradeCServeWithinMin * 60_000)
    return fail("GRADE_C_SLOW", { arrival: leg.arrival, serveTime: leg.serveTime });
  return { ok: true };
}
