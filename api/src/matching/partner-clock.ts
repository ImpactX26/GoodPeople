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
  then: "next_ngo" | "window_closes" | "released";
}

export async function partnerClockOf(store: MatchingStore, share: Share, l: Listing, now: number): Promise<PartnerClock | null> {
  if (share.status !== "finding_partner" || !share.ngoId) return null;
  const accepted = share.acceptedAt ?? share.askedAt ?? share.waitingForPartnerSince ?? share.createdAt;
  const from = accepted;
  const closes = Math.min(l.collectBy, safeUntilOf(l, share.lines));
  const wait = itemsOf(l, share.lines).some((i) => effectiveGrade(i) === "C") ? config.partnerWaitBeforeNextNgoServeNowMs : config.partnerWaitBeforeNextNgoMs;
  const tried = new Set([...share.triedNgoIds, share.ngoId]);
  let another = false;
  for (const c of share.candidates) {
    if (tried.has(c.ngoId)) continue;
    const r = await store.get("recipient", c.ngoId);
    if (r?.active && (config.simulateUnclaimed || r.phone)) { another = true; break; }
  }
  // It moves on at the first of: the wait limit after asking ran out, or 30 minutes after the NGO accepted.
  const moveAt = Math.min(share.waitingForPartnerSince !== undefined ? share.waitingForPartnerSince + wait : Infinity, accepted + config.ngoHoldAfterAcceptMaxMs);
  if (another && moveAt > now && moveAt < closes) return { from, to: moveAt, then: "next_ngo" };
  // With nowhere else to go, the hold still ends 30 minutes after accepting (or sooner, if the window closes first).
  const holdEnds = accepted + config.ngoHoldAfterAcceptMaxMs;
  if (holdEnds < closes) return { from, to: Math.max(holdEnds, now), then: "released" };
  return { from, to: Math.max(closes, now), then: "window_closes" };
}
