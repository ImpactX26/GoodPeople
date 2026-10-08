/**
 * The Food Agent's work, on the agent dashboards, from the moment a restaurant posts food: the listing
 * arriving, the photo check running (and which model judged it, and why), and the result for each food.
 * Before this, a listing only showed up once it reached the Decision Agent, and one held for a tag fix or
 * judged not for people never showed at all. Kept in the decision log too, so it survives restarts.
 */
import { randomUUID } from "node:crypto";
import { matchingStore } from "../matching/index.ts";
import { trace } from "../matching/reasoning/trace.ts";
import type { Thought, Verdict } from "../matching/reasoning/types.ts";
import type { Decision, DecisionKind } from "../matching/types.ts";
import type { FoodCheck, FoodListing } from "./types.ts";

/** "7:28 pm", or "tomorrow 7:28 pm" when it isn't today (India time). */
const day = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
const clock = (ms: number) => {
  const time = new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  if (day(ms) === day(Date.now())) return time;
  return `${day(ms) === day(Date.now() + 24 * 60 * 60_000) ? "tomorrow" : new Date(ms).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })} ${time}`;
};
const servings = (l: FoodListing) => (l.items ? l.items.reduce((n, i) => n + i.servings, 0) : l.count * (l.entryMode === "shared_pack" ? l.feedsEach : 1));
/** One entry per food: the session's items, or the single dish. */
const foods = (l: FoodListing) => (l.items ? l.items.map((it) => ({ id: it.id, name: it.dish, check: it.foodCheck ?? null })) : [{ id: "dish", name: l.dish, check: l.foodCheck }]);

async function say(l: FoodListing, kind: DecisionKind, reason: string, at = Date.now()) {
  const d: Decision = { id: `d-food-${randomUUID().slice(0, 8)}`, at, agent: "food", kind, subject: `${servings(l)} servings from ${l.donorName}`, reason, listingId: l.id };
  if (await matchingStore.insert("decision", d)) trace.decision(d);
}

/** A restaurant posted food. */
export async function foodListed(l: FoodListing) {
  const list = foods(l).map((f) => f.name).join(", ");
  await say(l, "listed", `${l.donorName} listed ${list}: ${servings(l)} servings. Checking the food now.${l.reviewPending ? " It's their first listing, so the Luna team double-checks it too." : ""}`, l.createdAt);
}

const thoughtId = (l: FoodListing, foodId: string) => `fc-${l.id}-${foodId}`;

/** The photo checks have started: one thinking slip per food. */
export function foodChecking(l: FoodListing) {
  for (const f of foods(l))
    trace.thought({ id: thoughtId(l, f.id), at: Date.now(), agent: "food", point: "intake", listingId: l.id, about: `Photo check: ${f.name}`, status: "thinking" });
}

function thoughtOf(l: FoodListing, f: { id: string; name: string }, c: FoodCheck): Thought {
  const verdict: Verdict = c.grade === "D" || (c.tagsVerdict && c.tagsVerdict !== "ok") ? "would_change" : c.grade === "C" || c.unsure ? "concern" : "agree";
  const steps = (c.reasoning?.steps ?? []).filter((s) => s.title !== "Final grade").map((s) => `${s.title}: ${s.detail}${s.effect ? ` ${s.effect}` : ""}`);
  return {
    id: thoughtId(l, f.id),
    at: c.at,
    doneAt: c.at,
    agent: "food",
    point: "intake",
    listingId: l.id,
    about: `Photo check: ${f.name}`,
    status: "done",
    verdict,
    headline: `Grade ${c.grade}${c.safeUntil ? `, safe until ${clock(c.safeUntil)}` : ", not for people"}${c.unsure ? " · unsure, the rider checks it" : ""}`,
    reasoning: [c.reasoning?.summary ?? c.message, ...steps].filter(Boolean).slice(0, 4),
    model: c.models.photo ?? "rules: cooking time and storage only",
  };
}

/** The checks are back: each food's verdict, then what happens to the listing. */
export async function foodChecked(l: FoodListing) {
  for (const f of foods(l)) {
    if (!f.check) continue;
    const t = thoughtOf(l, f, f.check);
    await matchingStore.put("thought", t);
    trace.thought(t);
  }
  const graded = foods(l).filter((f) => f.check).map((f) => `${f.name}: Grade ${f.check!.grade}${f.check!.safeUntil ? `, safe until ${clock(f.check!.safeUntil)}` : " (not for people)"}`).join("; ");
  if (l.state === "not_for_people") await say(l, "escalated", `Not for people: ${graded}. ${l.foodCheck?.message ?? ""}`.trim());
  else if (l.state === "tags_held") {
    const asks = (l.foodCheck?.tagChecks ?? []).map((t) => `${t.itemName ? `${t.itemName}'s ` : ""}${t.tag.replace("contains:", "contains ")} tag (${t.seen})`).join(", ");
    await say(l, "review", `Held for the restaurant: the photo questions ${asks || "a tag"}. ${graded}.`);
  } else await say(l, "graded", `${graded}. Handing the Food Passport to the Decision Agent.`);
}

/**
 * A listing held for its tags was relisted with corrected ones: the old one closes, pointing at the new one, so
 * the agent boards don't show it waiting forever. Once per listing (safe to call again from the sweep).
 */
export async function foodRelisted(old: FoodListing, newId: string) {
  const d: Decision = { id: `d-food-relisted-${old.id}`, at: Date.now(), agent: "food", kind: "closed", subject: `${servings(old)} servings from ${old.donorName}`,
    reason: `Relisted with corrected tags as a new listing (${newId}), which carries on. This one is closed.`, listingId: old.id };
  if (await matchingStore.insert("decision", d)) trace.decision(d);
}
