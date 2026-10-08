/**
 * Food check for every new listing (spec §8–§9).
 *
 * With FOOD_AGENT_URL set, the photo and details go to the Food Agent (Python, `luna_ngo`,
 * Gemini vision + food-safety rules) and the result arrives in the background. Without it,
 * or when the agent can't be reached, Luna grades from cooking time and storage alone and
 * marks the food Unsure so the delivery partner checks it at pickup.
 */
import type { FoodCheck, FoodListing, TagCheck } from "./types.ts";

export const foodAgentUrl = () => (process.env.FOOD_AGENT_URL ?? "").replace(/\/+$/, "");
const TIMEOUT_MS = Number(process.env.FOOD_AGENT_TIMEOUT_MS ?? 120_000);
const HOUR = 60 * 60_000;

/** Spec Appendix B, high-risk cooked food: the strictest class, used when the photo can't be judged. */
const RULE_HOURS = { hot: 8, room: 4, fridge: 24 } as const;
/** Typical temperatures when the donor doesn't give a reading. */
const ASSUMED_C = { hot: 65, room: 28, fridge: 4 } as const;
const STORAGE = { hot: "hot_held", room: "room_temp", fridge: "refrigerated" } as const;

export const servingsOf = (l: Pick<FoodListing, "count" | "feedsEach" | "entryMode">) => l.count * (l.entryMode === "shared_pack" ? l.feedsEach : 1);

function gradeFor(remainingMs: number): FoodCheck["grade"] {
  return remainingMs >= 6 * HOUR ? "A" : remainingMs >= 3 * HOUR ? "B" : remainingMs > 0 ? "C" : "D";
}

const STORED = { hot: "kept hot", room: "at room temperature", fridge: "in a fridge" } as const;

export function rulesOnlyCheck(l: FoodListing, now: number, why: string): FoodCheck {
  const safeUntil = l.cookedAt + RULE_HOURS[l.storage] * HOUR, grade = gradeFor(safeUntil - now);
  const left = Math.max(0, (safeUntil - now) / HOUR), ago = (now - l.cookedAt) / HOUR;
  const reasoning: FoodCheck["reasoning"] = {
    summary: grade === "D" ? "Grade D, not for people: it has been kept too long for cooked food."
      : `Grade ${grade}: set by the time left (${left.toFixed(1)} h). Marked Unsure, so the delivery partner checks it at pickup.`,
    steps: [
      { title: "Time since cooking", detail: `Cooked ${ago.toFixed(1)} h ago and ${STORED[l.storage]}. Luna's strictest rule for cooked food ${STORED[l.storage]} allows ${RULE_HOURS[l.storage]} h, so about ${left.toFixed(1)} h are left.`,
        effect: `Time gives Grade ${grade} (A needs 6 h or more, B 3–6 h, C less than 3 h).`, status: grade === "D" ? "fail" : grade === "C" ? "warn" : "pass" },
      { title: "Photo check", detail: `The photo wasn't judged by an AI model this time (${why})`, effect: "Marked Unsure: the delivery partner checks the food at pickup.", status: "info" },
      { title: "Final grade", detail: grade === "D" ? "D · Not for people." : `${grade}.`, effect: "", status: grade === "D" ? "fail" : "pass" },
    ],
  };
  return {
    status: "done", at: now, source: "rules_only", grade, unsure: true, photoChecked: false, score: null, condition: null,
    safeUntil: grade === "D" ? null : safeUntil,
    message: grade === "D"
      ? `Cooked food kept ${l.storage === "room" ? "at room temperature" : l.storage === "hot" ? "hot" : "in a fridge"} for this long isn't safe for people.`
      : "We couldn't look at the photo right now, so this grade uses cooking time and storage only. The delivery partner will check the food at pickup.",
    reasons: [why], seen: "", models: { photo: null, reasoning: "rules" }, reasoning,
  };
}

export function foodCheckPayload(l: FoodListing) {
  const ingredients = [...l.contains.map(a => a.replace("_", " ")), ...(l.diet === "nonveg" ? ["meat"] : l.diet === "egg" ? ["egg"] : [])];
  return {
    food_name: l.dish, food_category: l.category ?? "cooked_meal", quantity: servingsOf(l),
    prepared_at: new Date(l.cookedAt).toISOString(), storage_method: STORAGE[l.storage],
    storage_temperature: l.temperatureC ?? ASSUMED_C[l.storage], ingredients, diet: l.diet,
    tags: { diet: l.diet, jain: l.jain, spice: l.spice, contains: l.contains }, allergens: l.contains, image: l.photo,
    donor: { id: `DONOR-${l.donorPhone}`, name: l.donorName, latitude: l.pickup.lat, longitude: l.pickup.lng },
  };
}

interface AgentResponse {
  decision: "ELIGIBLE" | "INELIGIBLE" | "NEEDS_REVIEW" | "ERROR";
  freshness: { score: number; grade: FoodCheck["grade"]; unsure: boolean; photo_checked: boolean; condition: string | null; safe_until: string | null } | null;
  restaurant_message: string | null;
  reasons: string[];
  photo: { checked: boolean; seen: string; diet_seen?: "veg" | "egg" | "nonveg" | "unclear"; tag_checks?: TagCheck[]; tags_verdict?: "ok" | "unsure" | "wrong" };
  models?: { photo: string | null; reasoning: string };
  explanation?: FoodCheck["reasoning"];
}

export function fromAgent(r: AgentResponse, l: FoodListing, now: number): FoodCheck {
  const f = r.freshness;
  if (!f || r.decision === "ERROR") return rulesOnlyCheck(l, now, "The Food Agent couldn't finish the check.");
  const grade = r.decision === "INELIGIBLE" ? "D" : f.grade;
  const dietSeen = r.photo?.checked ? r.photo.diet_seen ?? "unclear" : "unclear";
  return {
    status: "done", at: now, source: "food_agent", grade, unsure: f.unsure || r.decision === "NEEDS_REVIEW",
    photoChecked: f.photo_checked, score: f.score, condition: f.condition,
    safeUntil: grade === "D" || !f.safe_until ? null : Date.parse(f.safe_until),
    message: (r.restaurant_message ?? "").trim(), reasons: r.reasons ?? [], seen: r.photo?.seen ?? "",
    models: { photo: r.models?.photo ?? null, reasoning: r.models?.reasoning ?? "rules" },
    reasoning: r.explanation ?? null,
    dietSeen, tagChecks: r.photo?.checked ? r.photo.tag_checks ?? [] : [],
    tagsVerdict: r.photo?.checked ? r.photo.tags_verdict ?? "ok" : "ok",
  };
}

/** Calls the Food Agent; never throws (falls back to the rules). */
export async function requestFoodCheck(l: FoodListing, now = Date.now, fetchImpl: typeof fetch = fetch): Promise<FoodCheck> {
  const url = foodAgentUrl();
  if (!url) return rulesOnlyCheck(l, now(), "Photo check isn't connected (FOOD_AGENT_URL is not set).");
  try {
    const res = await fetchImpl(`${url}/api/luna/food-check`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(foodCheckPayload(l)), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return rulesOnlyCheck(l, now(), `Food Agent answered ${res.status}.`);
    return fromAgent(await res.json() as AgentResponse, l, now());
  } catch {
    return rulesOnlyCheck(l, now(), "The Food Agent couldn't be reached.");
  }
}

/** Applies a finished check to the listing: Grade D never goes to people; A–C become the assessment. */
export function applyFoodCheck(l: FoodListing, check: FoodCheck) {
  l.foodCheck = check;
  if (check.grade === "D" || !check.safeUntil) {
    l.assessment = null;
    l.state = "not_for_people";
    return;
  }
  l.assessment = { grade: check.grade, safeUntil: check.safeUntil, servings: servingsOf(l), unsure: check.unsure, source: check.source };
  // Dietary promises are never relaxed: tags the photo contradicts hold the listing until the donor relists
  // (sure) or confirms them (unsure).
  if (check.tagsVerdict && check.tagsVerdict !== "ok" && (l.state === "in_review" || l.state === "checking")) {
    l.heldFrom = l.state;
    l.state = "tags_held";
  }
}

