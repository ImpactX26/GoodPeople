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

/**
 * Hours a food stays safe after cooking, by kind and storage: the same table the Food Agent uses
 * (config/ngo_agent.json food_safety.max_hours), so the fallback is never more lenient than the model's
 * rules. Sources for every number: docs/FOOD-SAFETY-BASIS.md (WHO, USDA, FDA Food Code, FSSAI).
 */
const SHELF_HOURS: Record<NonNullable<FoodListing["category"]>, Record<FoodListing["storage"], number>> = {
  cooked_meal: { hot: 4, room: 2, fridge: 24 },
  bakery: { hot: 4, room: 24, fridge: 72 },
  raw_produce: { hot: 2, room: 12, fridge: 72 },
  packaged: { hot: 4, room: 168, fridge: 168 },
  dairy: { hot: 2, room: 2, fridge: 24 },
  beverages: { hot: 4, room: 8, fridge: 48 },
};
/** Below this, "kept hot" isn't hot (FDA Food Code 135 °F); above this, a room is warm (USDA: 1 hour above 90 °F). */
const HOT_MIN_C = 57, WARM_ROOM_C = 32;
/** Cooked meat, egg and fish get less time (Luna's own margin, shared with the Food Agent). */
const NON_VEG_FACTOR = 0.75;
/** Less safe time than this can't reach an NGO in time (Food Agent's min_rescue_minutes). */
const MIN_RESCUE_MS = 30 * 60_000;
/** Typical temperatures when the donor doesn't give a reading. */
const ASSUMED_C = { hot: 65, room: 28, fridge: 4 } as const;
const STORAGE = { hot: "hot_held", room: "room_temp", fridge: "refrigerated" } as const;

export const servingsOf = (l: Pick<FoodListing, "count" | "feedsEach" | "entryMode">) => l.count * (l.entryMode === "shared_pack" ? l.feedsEach : 1);

function gradeFor(remainingMs: number): FoodCheck["grade"] {
  return remainingMs >= 6 * HOUR ? "A" : remainingMs >= 3 * HOUR ? "B" : remainingMs > 0 ? "C" : "D";
}

const STORED = { hot: "kept hot", room: "at room temperature", fridge: "in a fridge" } as const;

/** The safe window for this food, in hours since cooking, and the notes that changed it. */
export function shelfHours(l: Pick<FoodListing, "category" | "storage" | "temperatureC" | "diet">) {
  const category = l.category ?? "cooked_meal", t = l.temperatureC ?? null, notes: string[] = [];
  let storage = l.storage;
  if (storage === "hot" && t !== null && t < HOT_MIN_C) {
    storage = "room";
    notes.push(`it was below ${HOT_MIN_C}°C, so the room-temperature limit applies`);
  }
  let hours = SHELF_HOURS[category][storage];
  if (storage === "room" && t !== null && t > WARM_ROOM_C) {
    hours /= 2;
    notes.push(`a room above ${WARM_ROOM_C}°C halves the time`);
  }
  if (category === "cooked_meal" && l.diet !== "veg") {
    hours *= NON_VEG_FACTOR;
    notes.push("cooked meat, egg or fish gets a quarter less time");
  }
  return { hours, notes };
}

export function rulesOnlyCheck(l: FoodListing, now: number, why: string): FoodCheck {
  const { hours, notes } = shelfHours(l);
  const ruleUntil = l.cookedAt + hours * HOUR, grade = ruleUntil - now < MIN_RESCUE_MS ? "D" : gradeFor(ruleUntil - now), safeUntil = ruleUntil;
  const limit = `${Math.round(hours * 10) / 10} h${notes.length ? ` (${notes.join("; ")})` : ""}`;
  const left = Math.max(0, (safeUntil - now) / HOUR), ago = (now - l.cookedAt) / HOUR;
  const reasoning: FoodCheck["reasoning"] = {
    summary: grade === "D" ? "Grade D, not for people: it has been kept too long for cooked food."
      : `Grade ${grade}: set by the time left (${left.toFixed(1)} h). Marked Unsure, so the delivery partner checks it at pickup.`,
    steps: [
      { title: "Time since cooking", detail: `Cooked ${ago.toFixed(1)} h ago and ${STORED[l.storage]}. Luna's food-safety rule for this food allows ${limit}, so about ${left.toFixed(1)} h are left.`,
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
  photo: { checked: boolean; seen: string; matches?: "yes" | "partly" | "no" | "unknown"; diet_seen?: "veg" | "egg" | "nonveg" | "unclear"; tag_checks?: TagCheck[]; tags_verdict?: "ok" | "unsure" | "wrong" };
  models?: { photo: string | null; reasoning: string };
  explanation?: FoodCheck["reasoning"];
}

export function fromAgent(r: AgentResponse, l: FoodListing, now: number): FoodCheck {
  const f = r.freshness;
  if (!f || r.decision === "ERROR") return rulesOnlyCheck(l, now, "The Food Agent couldn't finish the check.");
  const grade = r.decision === "INELIGIBLE" ? "D" : f.grade;
  const dietSeen = r.photo?.checked ? r.photo.diet_seen ?? "unclear" : "unclear";
  // The photo doesn't look like the dish named: always a warning; clearly not it makes the food Unsure, so the
  // partner checks it at pickup (a wrong photo means the grade was judged on something else).
  const dishMatch = r.photo?.checked ? r.photo.matches ?? "unknown" : undefined;
  return {
    status: "done", at: now, source: "food_agent", grade, unsure: f.unsure || r.decision === "NEEDS_REVIEW" || dishMatch === "no", dishMatch,
    photoChecked: f.photo_checked, score: f.score, condition: f.condition,
    safeUntil: grade === "D" || !f.safe_until ? null : Date.parse(f.safe_until),
    message: (r.restaurant_message ?? "").trim(), reasons: r.reasons ?? [], seen: r.photo?.seen ?? "",
    models: { photo: r.models?.photo ?? null, reasoning: r.models?.reasoning ?? "rules" },
    reasoning: r.explanation ?? null,
    dietSeen, tagChecks: r.photo?.checked ? r.photo.tag_checks ?? [] : [],
    tagsVerdict: r.photo?.checked ? r.photo.tags_verdict ?? "ok" : "ok",
  };
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });

/**
 * The restaurant knows its food best: when it says how long the food stays good, no check may promise
 * longer. Its time caps the safe-until, and the grade can only go down to match (never up). Too little time
 * left to deliver means Grade D. Applied once per check (`donorSafeUntil` marks it).
 */
export function capByDonor(check: FoodCheck, donorSafeUntil: number | null | undefined): FoodCheck {
  if (!donorSafeUntil || check.donorSafeUntil || check.grade === "D" || !check.safeUntil) return check;
  const said = `You said it stays good until about ${clock(donorSafeUntil)}.`;
  if (donorSafeUntil >= check.safeUntil) {
    const step = { title: "Your estimate", detail: `${said} Luna's food-safety rules give ${clock(check.safeUntil)}, which is sooner, so that stands.`, effect: "No change.", status: "info" as const };
    return { ...check, donorSafeUntil, reasoning: check.reasoning ? { ...check.reasoning, steps: [...check.reasoning.steps, step] } : check.reasoning };
  }
  const left = donorSafeUntil - check.at;
  const timeGrade = left < MIN_RESCUE_MS ? "D" : gradeFor(left);
  const grade = GRADE_ORDER.indexOf(timeGrade) > GRADE_ORDER.indexOf(check.grade) ? timeGrade : check.grade;
  const step = {
    title: "Your estimate", detail: `${said} That's sooner than the ${clock(check.safeUntil)} Luna's rules allow, so Luna uses your time.`,
    effect: grade === "D" ? "Not enough time left to get it to an NGO." : grade !== check.grade ? `The grade drops to ${grade}.` : `Grade stays ${grade}.`,
    status: grade === "D" ? ("fail" as const) : ("warn" as const),
  };
  return {
    ...check, donorSafeUntil, grade, safeUntil: grade === "D" ? null : donorSafeUntil,
    message: grade === "D" ? `You said this stays good only until about ${clock(donorSafeUntil)}, which isn't enough time to get it to an NGO.` : check.message,
    reasons: [...check.reasons, `Capped at the restaurant's own estimate: good until ${clock(donorSafeUntil)}.`],
    reasoning: check.reasoning ? { ...check.reasoning, steps: [...check.reasoning.steps, step] } : check.reasoning,
  };
}
const GRADE_ORDER = ["A", "B", "C", "D"] as const;

/** Calls the Food Agent; never throws (falls back to the rules). The restaurant's own estimate caps the result. */
export async function requestFoodCheck(l: FoodListing, now = Date.now, fetchImpl: typeof fetch = fetch): Promise<FoodCheck> {
  return capByDonor(await rawFoodCheck(l, now, fetchImpl), l.donorSafeUntil);
}

async function rawFoodCheck(l: FoodListing, now: () => number, fetchImpl: typeof fetch): Promise<FoodCheck> {
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

