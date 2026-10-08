/**
 * The clock on a pickup nobody has taken: from when it started waiting for a partner to when it moves on (to the
 * next NGO with a partner free) or, with no other NGO to go to, when the restaurant's pickup window closes.
 * The restaurant and the NGO both see it run down (logistics-agent.ts handOnToNextNgo does the moving).
 */
import { config } from "./config.ts";
import { effectiveGrade } from "./engine/safety.ts";
import { itemsOf, safeUntilOf } from "./runtime.ts";
import type { MatchingStore } from "./store.ts";
import type { Listing, Share } from "./types.ts";

export interface PartnerClock {
  from: number;
  to: number;
  /** What happens at `to`: the food moves to another NGO, or the pickup window closes. */
  then: "next_ngo" | "window_closes";
}

export async function partnerClockOf(store: MatchingStore, share: Share, l: Listing, now: number): Promise<PartnerClock | null> {
  if (share.status !== "finding_partner" || !share.ngoId) return null;
  const from = share.waitingForPartnerSince ?? share.askedAt ?? share.createdAt;
  const closes = Math.min(l.collectBy, safeUntilOf(l, share.lines));
  const wait = itemsOf(l, share.lines).some((i) => effectiveGrade(i) === "C") ? config.partnerWaitBeforeNextNgoServeNowMs : config.partnerWaitBeforeNextNgoMs;
  const tried = new Set([...share.triedNgoIds, share.ngoId]);
  let another = false;
  for (const c of share.candidates) {
    if (tried.has(c.ngoId)) continue;
    const r = await store.get("recipient", c.ngoId);
    if (r?.active && (config.simulateUnclaimed || r.phone)) { another = true; break; }
  }
  if (another && from + wait > now && from + wait < closes) return { from, to: from + wait, then: "next_ngo" };
  return { from, to: Math.max(closes, now), then: "window_closes" };
}
