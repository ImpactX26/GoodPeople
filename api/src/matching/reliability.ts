/**
 * Delivery partner reliability, kept by the Decision Agent. Deterministic: every trip leaves one mark
 * (0–5) that's rewritten live while the trip runs late and fixed at the drop; the score is a
 * recency-weighted average of the last marks over a neutral prior, so one bad day doesn't sink a
 * newcomer and a steady record recovers. A heads-up ("Running late") costs less than silence.
 */
import { config } from "./config.ts";
import type { Reliability, TripMark } from "./types.ts";

const C = () => config.reliability;

export function emptyReliability(): Reliability {
  return { score: C().prior, trips: 0, onTime: 0, late: 0, marks: [] };
}

/** The mark for a trip `lateMin` behind its promised arrival. */
export function markFor(kind: TripMark["kind"], lateMin: number, reported: boolean): number {
  if (kind === "unsafe_delay") return 1.5;
  if (kind === "reassigned") return 2;
  if (lateMin <= config.lateness.graceMin) return 5;
  const base = lateMin <= 15 ? 3.8 : lateMin <= 30 ? 2.8 : 1.8;
  return Math.min(5, base + (reported ? 0.5 : 0));
}

function scoreOf(marks: TripMark[]) {
  // newest first: weight 1, decay, decay², …
  let sum = C().prior * C().priorWeight, weight = C().priorWeight, w = 1;
  for (const m of [...marks].sort((a, b) => b.at - a.at)) { sum += m.score * w; weight += w; w *= C().decay; }
  return Math.round((sum / weight) * 10) / 10;
}

/** Adds or rewrites this trip's mark and recomputes the score. */
export function withMark(r: Reliability | undefined, mark: TripMark): Reliability {
  const prev = r ?? emptyReliability();
  const marks = [mark, ...prev.marks.filter((m) => m.shareId !== mark.shareId)].sort((a, b) => b.at - a.at).slice(0, C().window);
  const finals = marks.filter((m) => m.final);
  return {
    score: scoreOf(marks),
    trips: finals.length,
    onTime: finals.filter((m) => m.kind === "on_time").length,
    late: marks.filter((m) => m.kind !== "on_time").length,
    marks,
  };
}

/** "4.6 / 5 · 9 of 10 on time", or "New partner". */
export function reliabilityLine(r: Reliability | undefined) {
  if (!r || r.trips < C().newUntilTrips && !r.late) return "New partner";
  return `${r.score.toFixed(1)} / 5 · ${r.onTime} of ${r.trips} on time`;
}
