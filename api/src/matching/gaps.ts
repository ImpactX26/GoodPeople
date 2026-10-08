/**
 * Proactive mode: when the heat map expects a gap in the next few hours, ask
 * nearby donors who usually have surplus then, within the contact caps.
 */
import { AREAS, computeWindow, SLOT_COUNT, type DonorKind } from "../map/model.ts";
import { config } from "./config.ts";
import { distanceKm, round1 } from "./engine/geo.ts";
import { fmtTime, istClock, istMidnight } from "./time.ts";
import type { ContactLog } from "./types.ts";

const SLOT_MS = 3 * 3_600_000;
const DAY_MS = 86_400_000;

export interface GapDonor {
  /** Phone for signed-up donors; "map:…" for the heat map's sample donors. */
  key: string;
  phone?: string;
  name: string;
  areaId: string;
  kind: DonorKind;
}

export interface Gap {
  areaId: string;
  areaName: string;
  day: number;
  slot: number;
  start: number;
  end: number;
  gapRatio: number;
  short: number;
}

export interface Outreach {
  gap: Gap;
  donors: (GapDonor & { km: number })[];
}

export const windowLabel = (g: Pick<Gap, "start" | "end">) => `${fmtTime(g.start)}–${fmtTime(g.end)}`;

/** Gap windows starting 3–6 hours from now (India time). */
export function findGaps(now: number): Gap[] {
  const gaps: Gap[] = [];
  const midnight = istMidnight(now);
  for (let d = 0; d <= 1; d++) {
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const start = midnight + d * DAY_MS + slot * SLOT_MS;
      if (start < now + config.gapLookaheadFromMs || start > now + config.gapLookaheadToMs) continue;
      const day = istClock(start).day;
      for (const a of AREAS) {
        const w = computeWindow(a, day, slot);
        if (w.isGap) gaps.push({ areaId: a.id, areaName: a.name, day, slot, start, end: start + SLOT_MS, gapRatio: w.gapRatio, short: w.short });
      }
    }
  }
  return gaps;
}

/** Within the respectful-messaging caps? */
export function canContact(key: string, contacts: ContactLog[], now: number) {
  const mine = contacts.filter((c) => c.donorKey === key);
  return (
    mine.filter((c) => c.at > now - DAY_MS).length < config.gapContactPerDay &&
    mine.filter((c) => c.at > now - 7 * DAY_MS).length < config.gapContactPerWeek
  );
}

export function planOutreach(gaps: Gap[], donors: GapDonor[], contacts: ContactLog[], now: number): Outreach[] {
  const used = new Set<string>();
  const out: Outreach[] = [];
  for (const gap of gaps) {
    const gapArea = AREAS.find((a) => a.id === gap.areaId)!;
    const picks = donors
      .filter((d) => !used.has(d.key) && canContact(d.key, contacts, now))
      .map((d) => {
        const area = AREAS.find((a) => a.id === d.areaId);
        if (!area) return null;
        const km = distanceKm(area, gapArea);
        // How much this kind of donor in that area usually has spare in the gap's slot.
        const usual = computeWindow(area, gap.day, gap.slot).surplus * (area.surplus[d.kind] / Object.values(area.surplus).reduce((a, b) => a + b, 1));
        return { ...d, km: round1(km), usual };
      })
      .filter((d): d is GapDonor & { km: number; usual: number } => d !== null && d.km <= config.gapNeighbourKm)
      .sort((a, b) => b.usual - a.usual || a.km - b.km)
      .slice(0, config.gapDonorsPerArea)
      .map(({ usual: _usual, ...d }) => d);
    picks.forEach((p) => used.add(p.key));
    if (picks.length) out.push({ gap, donors: picks });
  }
  return out;
}

/** The heat map's sample donors, who can't receive messages (simulated). */
export function mapDonors(): GapDonor[] {
  return AREAS.flatMap((a) => a.donors.map((d, i) => ({ key: `map:${a.id}:${i}`, name: d.name, areaId: a.id, kind: d.kind })));
}
