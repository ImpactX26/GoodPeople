/**
 * Luna's agents, wired together:
 *
 *   restaurant ─▶ Food Agent (Food Passport) ─▶ Decision Agent ─▶ NGO Agent (shares)
 *                                                   ▲   │
 *                                     events ───────┘   ▼
 *                                              Logistics Agent (offer, partner, codes, trip)
 *
 * Every entry point runs through one queue, so only one operation changes
 * state at a time; agents call each other only from inside that operation.
 */
import { createDecisionAgent, type NewListing } from "./decision-agent.ts";
import type { GapDonor } from "./gaps.ts";
import { defaultHunger, type HungerProvider } from "./hooks.ts";
import { createLogisticsAgent, type LogisticsEvent } from "./logistics-agent.ts";
import { createNgoAgent } from "./ngo-agent.ts";
import { createRuntime, fail, ok, type Actor, type Result } from "./runtime.ts";
import { seedPartners, seedRecipients } from "./seed.ts";
import type { MatchingStore } from "./store.ts";
import type { LatLng } from "./types.ts";
import * as msg from "./whatsapp/templates.ts";

export type { Actor, NewListing, Result };

export interface LunaDeps {
  store: MatchingStore;
  /** Fair Share's hunger levels (Feature 4); "normal" for everyone until connected. */
  hunger?: HungerProvider;
  /** Signed-up donors for gap outreach. */
  listDonors?: () => Promise<GapDonor[]>;
}

export function createLuna(deps: LunaDeps) {
  const rt = createRuntime(deps.store);
  const { store, serial } = rt;
  const ngo = createNgoAgent(rt, deps.hunger ?? defaultHunger);
  let onLogistics: (e: LogisticsEvent, now: number) => Promise<void> = async () => {};
  const logistics = createLogisticsAgent(rt, { emit: (e, now) => onLogistics(e, now) });
  const decision = createDecisionAgent(rt, { ngo, logistics, listDonors: deps.listDonors });
  onLogistics = decision.onLogistics;

  async function seed() {
    const recipients = seedRecipients();
    for (const r of recipients) await store.insert("recipient", r);
    for (const p of seedPartners(recipients)) await store.insert("partner", p);
  }

  /** Bind a real phone to a seeded NGO or partner, so a team member can stand in for it. */
  function claim(kind: "recipient" | "partner", key: string, phone: string): Promise<Result> {
    return serial(async () => {
      const doc = await store.get(kind, key);
      if (!doc) return fail(`Unknown ${kind}.`, 404);
      for (const other of await store.list(kind, { phone })) if (other.id !== key) await store.put(kind, { ...other, phone: undefined } as never);
      await store.put(kind, { ...doc, phone } as never);
      return ok(`${doc.name} is now reachable on ${phone}.`);
    });
  }

  return {
    seed,
    claim,
    // Decision Agent
    submitListing: (input: NewListing, now: number, opts?: { reviewed?: boolean }) => serial(() => decision.submitListing(input, now, opts)),
    approveListing: (id: string, now: number) => serial(() => decision.approveListing(id, now)),
    feedback: (shareId: string, result: "fewer" | "right" | "more", by: Actor, now: number) => serial(() => decision.feedback(shareId, result, by, now)),
    gapReply: (pledgeId: string, yes: boolean, by: Actor, now: number) => serial(() => decision.gapReply(pledgeId, yes, by, now)),
    runGaps: (now: number) => serial(() => decision.runGaps(now)),
    tick: (now: number) => serial(() => decision.tick(now)),
    // Logistics Agent
    ngoReply: (shareId: string, accept: boolean, by: Actor, now: number) => serial(() => logistics.ngoReply(shareId, accept, by, now)),
    redirectReply: (shareId: string, accept: boolean, by: Actor, now: number) => serial(() => logistics.redirectReply(shareId, accept, by, now)),
    partnerReply: (shareId: string, accept: boolean, by: Actor, now: number) => serial(() => logistics.partnerReply(shareId, accept, by, now)),
    assignManual: (shareId: string, person: { name: string; phone?: string }, by: Actor, now: number) =>
      serial(() => logistics.assignManual(shareId, person, by, now)),
    enterCode: (shareId: string, which: "pickup" | "drop", code: string, by: Actor, now: number) => serial(() => logistics.enterCode(shareId, which, code, by, now)),
    late: (shareId: string, by: Actor, now: number) => serial(() => logistics.late(shareId, by, now)),
    location: (shareId: string, pos: LatLng, by: Actor, now: number) => serial(() => logistics.location(shareId, pos, by, now)),
    setOnline: (phone: string, online: boolean, pos?: LatLng) => serial(() => logistics.setOnline(phone, online, pos)),
    activeTripFor: (phone: string) => logistics.activeTripFor(phone),
    track: logistics.track,
    /** Free-form reply to someone who wrote in (stale buttons, wrong codes…). */
    notify: (phone: string, text: string, now: number) => rt.send(now, phone, `phone:${phone}`, msg.text(text)),
  };
}

export type Luna = ReturnType<typeof createLuna>;
