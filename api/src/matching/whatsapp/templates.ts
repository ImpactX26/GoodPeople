/**
 * Every message the agents send. Each has a plain version (text + up to three
 * reply buttons, allowed inside WhatsApp's 24-hour window) and, where Luna may
 * be first to speak, an approved-template version (used when WHATSAPP_TEMPLATES=1).
 *
 * Button payloads: share:<id>:accept|decline (NGO offer), redirect:<id>:accept|decline
 * (mid-trip redirect), ask:<id>:accept|decline (partner), trip:<id>:late,
 * fb:<id>:fewer|right|more (NGO feedback), gap:<id>:yes|no (donor).
 */
import { fmtTime } from "../time.ts";
import type { OutboxMessage } from "../types.ts";

export type Message = Pick<OutboxMessage, "text" | "buttons" | "template">;

const btn = (id: string, title: string) => ({ id, title });

export const TEMPLATES = {
  foodOffer: "luna_food_offer",
  partnerTask: "luna_partner_task",
  donationUpdate: "luna_donation_update",
  dropCode: "luna_delivery_update",
  gapRequest: "luna_gap_request",
} as const;

export function foodOffer(o: {
  shareId: string;
  servings: number;
  food: string;
  grade: string;
  safeUntil: number;
  arriveBy: number;
  minutes: number;
  /** A mid-trip redirect from the Decision Agent. */
  redirect?: boolean;
  /** Each food in the share with its own grade and safe-until, when there's more than one. */
  foods?: { name: string; servings: number; grade: string; safeUntil: number }[];
}): Message {
  const p = [String(o.servings), o.food, o.grade, fmtTime(o.safeUntil), fmtTime(o.arriveBy), String(o.minutes)];
  const kind = o.redirect ? "redirect" : "share";
  const lead = o.redirect ? "Urgent food offer (a delivery nearby was delayed): " : "Food offer: ";
  // Several foods are checked one by one, so the NGO sees each one's grade, not just the strictest.
  const what =
    o.foods && o.foods.length > 1
      ? `${p[0]} servings, each food checked on its own:\n${o.foods.map((f) => `• ${f.servings} × ${f.name}: Grade ${f.grade}, safe until ${fmtTime(f.safeUntil)}`).join("\n")}\n`
      : `${p[0]} servings of ${p[1]} (Grade ${p[2]}), safe until ${p[3]}. `;
  return {
    text: `${lead}${what}Can arrive by ${p[4]}. Please reply within ${p[5]} min.`,
    buttons: [btn(`${kind}:${o.shareId}:accept`, "Accept"), btn(`${kind}:${o.shareId}:decline`, "Decline")],
    template: { name: TEMPLATES.foodOffer, params: p },
  };
}

export function partnerAsk(o: {
  shareId: string;
  pickupKm: number;
  pickupPlace: string;
  dropName: string;
  dropKm: number;
  minutes: number;
  safeUntil: number;
  replyMinutes: number;
  containers: string[];
}): Message {
  const p = [o.pickupKm.toFixed(1), o.pickupPlace, o.dropName, o.dropKm.toFixed(1), String(o.minutes), fmtTime(o.safeUntil)];
  const bring = o.containers.length ? ` Bring: ${o.containers.join(", ")}.` : "";
  const reply = o.replyMinutes >= 2 ? `${o.replyMinutes} min` : `${Math.round(o.replyMinutes * 60)} s`;
  return {
    text: `Pickup ${p[0]} km away at ${p[1]}, drop at ${p[2]} (${p[3]} km). About ${p[4]} min. Food safe until ${p[5]}.${bring} Reply within ${reply}.`,
    buttons: [btn(`ask:${o.shareId}:accept`, "Accept"), btn(`ask:${o.shareId}:decline`, "Can't")],
    template: { name: TEMPLATES.partnerTask, params: [...p, o.containers.join(", ") || "nothing extra"] },
  };
}

export function donationUpdate(text: string): Message {
  return { text: `Update on your donation: ${text}`, template: { name: TEMPLATES.donationUpdate, params: [text] } };
}

export function dropCode(o: { partner: string; servings: number; arriveBy: number; code: string }): Message {
  const p = [o.partner, String(o.servings), fmtTime(o.arriveBy), o.code];
  return {
    text: `${p[0]} is on the way with ${p[1]} servings, arriving about ${p[2]}. Your drop code is ${p[3]}. Show it to the partner when the food arrives.`,
    template: { name: TEMPLATES.dropCode, params: p },
  };
}

export function feedbackAsk(o: { shareId: string; servings: number; donor: string }): Message {
  return {
    text: `Handover confirmed: ${o.servings} servings from ${o.donor}. How did it go?`,
    buttons: [btn(`fb:${o.shareId}:fewer`, "Fed fewer"), btn(`fb:${o.shareId}:right`, "About right"), btn(`fb:${o.shareId}:more`, "Fed more")],
  };
}

export function gapRequest(o: { pledgeId: string; area: string; when: string }): Message {
  const p = [o.area, o.when];
  return {
    text: `${p[0]} is expected to be short of food around ${p[1]} today. If you'll have surplus, tap Yes and we'll arrange pickup.`,
    buttons: [btn(`gap:${o.pledgeId}:yes`, "Yes"), btn(`gap:${o.pledgeId}:no`, "Not today")],
    template: { name: TEMPLATES.gapRequest, params: p },
  };
}

/** Free-form, in-session messages. */
export const text = (t: string, buttons?: { id: string; title: string }[]): Message => ({ text: t, buttons });

export const lateButton = (shareId: string) => [btn(`trip:${shareId}:late`, "Running late")];

export const PICKUP_CHECKLIST =
  "The food checker wasn't sure about this food. At pickup, please check: it smells normal; no mould, slime or odd colour; " +
  "it's still warm if it was hot, or cold if it was in a fridge. If anything seems off, don't take it and tap Running late to tell us.";
