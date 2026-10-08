/**
 * Reason codes and scores → plain English for the admin feed (SRS "Transparent").
 */
import { fmtMinutes, fmtTime } from "../time.ts";
import type { Item, ReasonCode, Recipient } from "../types.ts";
import type { Factor, Scored } from "./rank.ts";
import { round1 } from "./geo.ts";

const KIND: Record<Recipient["kind"], string> = {
  ngo: "NGO",
  shelter: "shelter",
  orphanage: "children's home",
  old_age_home: "old-age home",
  community_fridge: "community fridge",
  animal_shelter: "animal shelter",
  compost: "compost unit",
  biogas: "biogas plant",
};

/** "08:00" → "8 am", "21:30" → "9:30 pm". */
export function hhmm(clock: string) {
  const [h, m] = clock.split(":").map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
}

export const itemName = (item: Item) => item.name ?? `${item.diet === "unknown" ? "" : item.diet + " "}food`.trim();

export function skipReason(code: ReasonCode, detail: Record<string, unknown>, r: Recipient, item: Item): string {
  const n = r.name;
  const food = itemName(item);
  switch (code) {
    case "INACTIVE":
      return `Skipped ${n}: not taking food right now.`;
    case "EXCLUDED":
      return `Skipped ${n}: already passed on or missed this food.`;
    case "GRADE_D_PEOPLE":
      return `Skipped ${n}: ${food} is Grade D, not fit for people, and ${n} is a ${KIND[r.kind]}.`;
    case "PEOPLE_FOOD_ONLY":
      return `Skipped ${n}: it only takes food unfit for people, and ${food} is Grade ${detail.grade}.`;
    case "VULNERABLE_NEEDS_A":
      return `Skipped ${n}: it's a ${KIND[r.kind]}, so it only gets Grade A food, and ${food} is Grade ${detail.grade}.`;
    case "NEEDS_FRIDGE":
      return `Skipped ${n}: ${food} was kept in a fridge and ${n} has no fridge.`;
    case "DIET":
      return `Skipped ${n}: dietary rules (${detail.why}).`;
    case "EXPIRES_BEFORE_SERVING":
      if (detail.opens)
        return `Skipped ${n}: it's closed now (takes food ${hhmm(detail.opens as string)}–${hhmm(detail.closes as string)}), so the earliest it could serve ${food} is ${fmtTime(detail.serveTime as number)}, after it stops being safe at ${fmtTime(detail.safeUntil as number)}.`;
      return `Skipped ${n}: ${food} is safe until ${fmtTime(detail.safeUntil as number)}, but ${n} would serve it at ${fmtTime(detail.serveTime as number)}.`;
    case "CLOSED_AT_ARRIVAL":
      return `Skipped ${n}: the food would arrive at ${fmtTime(detail.arrival as number)}, outside its receiving hours (${detail.start}–${detail.end}).`;
    case "CATEGORY":
      return `Skipped ${n}: it doesn't take ${String(detail.category).replace("_", " ")}.`;
    case "GRADE_C_SLOW":
      return `Skipped ${n}: Grade C must be served within an hour of arriving; ${n} would serve it ${fmtMinutes((detail.serveTime as number) - (detail.arrival as number))} after it arrives.`;
  }
}

const WHY: Record<Factor, (s: Scored) => string> = {
  urgency: (s) => `can serve it sooner (${fmtTime(s.leg.serveTime)})`,
  proximity: (s) => `is closer (${round1(s.leg.dropKm)} km)`,
  fit: () => "has room for this amount",
  specialisation: () => "has fewer options because of its dietary rules",
  underserved: () => "has been missing out on food",
  priority: () => "is owed priority after an earlier redirect",
  vulnerableBonus: () => "serves vulnerable people and this is Grade A food",
  pledgeBonus: () => "is in the area this donor pledged food to",
};

export function rankReason(item: Item, ranked: Scored[]): string {
  const [win, next] = ranked;
  const food = itemName(item);
  if (!win) return `No recipient can safely take ${food}.`;
  const where = `${win.recipient.name} (${round1(win.leg.dropKm)} km)`;
  if (!next) return `${where} is the only recipient that can safely take ${food}.`;
  const edges = (Object.keys(win.factors) as Factor[])
    .map((f) => ({ f, d: win.factors[f] - next.factors[f] }))
    .filter((e) => e.d > 0.005)
    .sort((a, b) => b.d - a.d)
    .slice(0, 2)
    .map((e) => WHY[e.f](win));
  const because = edges.length ? `: it ${edges.join(" and ")}` : "";
  return `Chose ${where} over ${next.recipient.name} (${round1(next.leg.dropKm)} km) for ${food}${because}.`;
}
