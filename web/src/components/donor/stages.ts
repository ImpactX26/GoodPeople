import type { ListingView } from "@/lib/luna/listing";
import type { TripView } from "@/lib/luna/trip";

/** The donation ticket's coupons, in order (four; three when the food went to biogas). */
export type StageKey = "check" | "ngo" | "pickup" | "delivered" | "biogas";
export type StageState = "waiting" | "active" | "done" | "failed";
export interface Stage { key: StageKey; title: string; state: StageState }

export const GRADE_LABEL: Record<"A" | "B" | "C" | "D", string> = { A: "Premium", B: "Good", C: "Serve now", D: "Not for people" };

/** Friendly names for the models the Food Agent can fall back through (api config llm.food_fallbacks). */
const MODEL_NAMES: Record<string, string> = {
  "gemini-3.5-flash": "Gemini 3.5 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
  "meta-llama/llama-4-scout-17b-16e-instruct": "Llama 4 Scout on Groq",
  "qwen/qwen3.8-27b": "Qwen 3.8 on Groq",
};
/** "gemini:gemini-2.5-flash" → "Gemini 2.5 Flash"; null when no model judged it. */
export function modelName(label: string | null | undefined) {
  if (!label || label === "rules") return null;
  const model = label.includes(":") ? label.slice(label.indexOf(":") + 1) : label;
  const backup = label.startsWith("gemini[key_2]") ? " (backup key)" : "";
  return (MODEL_NAMES[model] ?? model) + backup;
}

export const servingsOf = (l: Pick<ListingView, "count" | "feedsEach" | "assessment">) => l.assessment?.servings ?? l.count * l.feedsEach;

type CaseShare = NonNullable<ListingView["agentCase"]>["shares"][number];
const ORDER: CaseShare["status"][] = ["delivered", "picked_up", "assigned", "finding_partner", "offering"];
/** The share that says most about where the food is: furthest along first. */
export function leadShare(l: ListingView): CaseShare | null {
  const live = l.agentCase?.shares.filter(x => x.status !== "unplaced" && x.status !== "failed") ?? [];
  for (const st of ORDER) { const x = live.find(y => y.status === st); if (x) return x; }
  return null;
}

export function stagesOf(l: ListingView, t: TripView | null): Stage[] {
  if (l.agentCase) {
    const s = leadShare(l)?.status, failed = l.agentCase.shares.some(x => x.status === "failed");
    // No NGO could take it, and the restaurant sent it to a biogas plant: the plant's pickup is the last step.
    const gas = l.agentCase.biogas ?? [];
    if (!s && gas.length) return [
      { key: "check", title: "Food check", state: "done" },
      { key: "ngo", title: "NGO", state: "failed" },
      { key: "biogas", title: "Biogas pickup", state: gas.every(b => b.status === "collected") ? "done" : "active" },
    ];
    const stuck = !s && (l.agentCase.leftover?.servings ?? 0) > 0;
    const at = (k: CaseShare["status"]) => !!s && ORDER.indexOf(s) <= ORDER.indexOf(k);
    return [
      { key: "check", title: "Food check", state: "done" },
      { key: "ngo", title: "NGO", state: at("finding_partner") ? "done" : stuck ? "failed" : "active" },
      { key: "pickup", title: "Pickup", state: failed && !at("picked_up") ? "failed" : at("picked_up") ? "done" : at("finding_partner") ? "active" : "waiting" },
      { key: "delivered", title: "Delivered", state: s === "delivered" ? "done" : s === "picked_up" ? "active" : "waiting" },
    ];
  }
  const unsafe = l.state === "not_for_people", unplaced = l.state === "unplaced", held = l.state === "tags_held";
  const accepted = !!l.trackingUrl || !!t?.shareAcceptedAt, pickedUp = !!t?.pickedUpAt || !!l.deliveredAt;
  return [
    { key: "check", title: "Food check", state: unsafe ? "failed" : l.foodCheck ? "done" : "active" },
    { key: "ngo", title: "NGO", state: unsafe ? "waiting" : unplaced || held ? "failed" : accepted ? "done" : l.foodCheck ? "active" : "waiting" },
    { key: "pickup", title: "Pickup", state: t?.status === "failed_at_pickup" ? "failed" : pickedUp ? "done" : accepted ? "active" : "waiting" },
    { key: "delivered", title: "Delivered", state: l.deliveredAt ? "done" : pickedUp ? "active" : "waiting" },
  ];
}

/** One short line for lists: what is happening now. */
export function nowLine(l: ListingView, t: TripView | null) {
  if (l.state === "not_for_people") return "Not safe for people";
  if (l.state === "tags_held") return l.replacedBy ? "Relisted with corrected tags" : l.foodCheck?.tagsVerdict === "wrong" ? "Tags don’t match the photo · relist" : "Check your tags";
  if (l.agentCase && !l.deliveredAt) return l.progress;
  if (l.deliveredAt) return `Delivered to ${l.recipientName}`;
  if (t?.pickedUpAt) return `On the way to ${l.recipientName ?? "the NGO"}`;
  if (l.trackingUrl) return t?.partnerName ? `${t.partnerName} is collecting` : `${l.recipientName} accepted · finding a partner`;
  if (l.offerRecipientName) return `Offered to ${l.offerRecipientName}`;
  if (!l.foodCheck) return "Checking your food";
  if (l.state === "in_review") return "Luna team is reviewing your first listing";
  if (l.state === "unplaced") return "No NGO could take it in time";
  return "Food checked · finding an NGO";
}

/** What each grade means for where the food can go (PRODUCT.md quality grades). */
export const GRADE_MEANING: Record<"A" | "B" | "C" | "D", string> = {
  A: "Fresh for 6+ hours. Any NGO, including children and the elderly.",
  B: "Good for 3 to 6 hours. Goes to general NGOs.",
  C: "Under 3 hours left. Only places that serve it within the hour.",
  D: "Not for people. Animal shelters, compost or biogas only.",
};
