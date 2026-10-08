/**
 * When no NGO can take food and nothing is left to try, the restaurant can send it to a biogas plant in
 * Bengaluru instead, which collects it. This works out what is left over and why, and which plant is nearest.
 * The Decision Agent books the pickup (decision-agent.ts, sendToBiogas).
 */
import { config } from "./config.ts";
import { distanceKm, round1 } from "./engine/geo.ts";
import { itemName } from "./engine/reasons.ts";
import type { MatchingStore } from "./store.ts";
import type { Listing, OfferLine, Recipient, Share } from "./types.ts";

const LIVE = new Set<Share["status"]>(["offering", "finding_partner", "assigned", "picked_up"]);

export interface Leftover {
  /** Servings no NGO can take, with no NGO left to ask: these can go to biogas. */
  lines: OfferLine[];
  servings: number;
  /** Servings an NGO would take but no delivery partner can collect yet: Luna keeps trying, so not leftover. */
  waitingOnPartner: number;
  /** Why no NGO can take it ("" when nothing is left over). */
  why: string;
}

/**
 * Food on its way, delivered, still being offered, or waiting only for a partner isn't leftover. What remains
 * has no NGO that can safely take it, or every NGO that could has said no.
 */
export async function leftoverOf(store: MatchingStore, l: Listing): Promise<Leftover> {
  const none: Leftover = { lines: [], servings: 0, waitingOnPartner: 0, why: "" };
  if (l.status === "review" || l.status === "closed") return none;
  const shares = await store.list("share", { listingId: l.id });
  const passed = new Map<string, Set<string>>();
  for (const d of await store.list("decision", { listingId: l.id }))
    if (d.kind === "declined" || d.kind === "expired") {
      const id = (d.data as { shareId?: string } | undefined)?.shareId;
      if (id) passed.set(id, (passed.get(id) ?? new Set()).add(d.subject));
    }

  const taken = new Map<string, number>();
  const add = (lines: OfferLine[]) => lines.forEach((ln) => taken.set(ln.itemId, (taken.get(ln.itemId) ?? 0) + ln.servings));
  let waitingOnPartner = 0;
  for (const s of shares) {
    if (LIVE.has(s.status) || s.status === "delivered") add(s.lines);
    else if (s.status === "unplaced" && !s.held) {
      // An NGO in its list never said no: it was skipped only because nobody could collect, and gets asked again.
      const no = passed.get(s.id) ?? new Set();
      const open = await Promise.all(s.candidates.filter((c) => !no.has(c.ngoId)).map((c) => store.get("recipient", c.ngoId)));
      if (open.some((r) => r?.active && (config.simulateUnclaimed || r.phone))) {
        add(s.lines);
        waitingOnPartner += s.lines.reduce((n, ln) => n + ln.servings, 0);
      }
    }
  }
  for (const b of await store.list("biogas", { listingId: l.id })) add(b.lines);

  const lines = l.items
    .map((i) => ({ itemId: i.id, servings: i.servings - (taken.get(i.id) ?? 0) }))
    .filter((ln) => ln.servings > 0);
  const servings = lines.reduce((n, ln) => n + ln.servings, 0);
  return { lines, servings, waitingOnPartner, why: l.stuckWhy ?? (servings ? "every NGO that could take it has passed" : "") };
}

/** The nearest active biogas plant; one that has claimed a phone (a real plant) wins over a sample one. */
export async function nearestCollector(store: MatchingStore, at: Listing): Promise<(Recipient & { km: number }) | null> {
  const plants = (await store.list("recipient", { kind: "biogas" }))
    .filter((r) => r.active)
    .map((r) => ({ ...r, km: round1(distanceKm(at, r)) }))
    .filter((r) => r.km <= r.acceptRadiusKm)
    .sort((a, b) => Number(!a.phone) - Number(!b.phone) || a.km - b.km);
  return plants[0] ?? null;
}

/** "10 × paneer manchurian, 8 × samosa". */
export const linesText = (l: Listing, lines: OfferLine[]) =>
  lines.map((ln) => `${ln.servings} × ${itemName(l.items.find((i) => i.id === ln.itemId) ?? { id: ln.itemId, servings: 0, grade: "C", confidence: 0, safeTime: 0, diet: "unknown" })}`).join(", ");

/** About when a plant this far away can come: half an hour to set out, then city traffic. */
export const comeByFor = (km: number, now: number) => now + Math.round(30 + km * 4) * 60_000;
