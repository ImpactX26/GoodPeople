import type { DonationLabel } from "../impact/label.ts";
import type { Stop } from "../trips/types.ts";
import type { BulkUnit, ContainerHint, EntryMode, Role } from "./portions.ts";

export interface ListingInput {
  dish: string;
  diet: "veg" | "egg" | "nonveg";
  jain: boolean;
  halal: "yes" | "no" | "unsure";
  contains: string[];
  spice: "mild" | "medium" | "hot";
  entryMode: "per_person_pack" | "shared_pack";
  count: number;
  feedsEach: number;
  photo: string;
  cookedAt: number;
  storage: "hot" | "room" | "fridge";
  /** Food Agent category; defaults to cooked_meal. */
  category?: FoodCategory;
  /** Thermometer reading, if the donor took one. */
  temperatureC?: number | null;
  /** The restaurant's own estimate of when the food stops being good (from `safeForHours`): no check may promise longer. */
  donorSafeUntil?: number | null;
  readyFrom: number;
  collectBy: number;
  containers: "donor_packs" | "partner_brings";
  pickup: Stop;
  contactName: string;
  contactPhone: string;
  declarationAccepted: boolean;
}
/** One food in a listing session: its own photo, tags, quantity, cooking time and food check (spec §6.3–6.5). */
export interface ListingItem {
  id: string;
  dish: string;
  category?: FoodCategory;
  diet: "veg" | "egg" | "nonveg";
  jain: boolean;
  halal: "yes" | "no" | "unsure";
  contains: string[];
  spice: "mild" | "medium" | "hot";
  /** How the donor gave the amount (§6.3). */
  quantity: { mode: EntryMode; count?: number; feedsEach?: number; amount?: number; unit?: BulkUnit };
  /** What the donor confirmed: the recommendation, or their own number. */
  servings: number;
  /** What the portion table recommends (§7.4), shown to the donor in yellow. */
  recommended: number;
  role: Role;
  /** "about N": category default, near spelling or a guess (§7.4). */
  estimate: boolean;
  /** The donor's number is more than 40% off the recommendation (§7.8). */
  donorOverride: boolean;
  dishId: string | null;
  container: ContainerHint;
  litres: number | null;
  photo: string;
  cookedAt: number;
  storage: "hot" | "room" | "fridge";
  temperatureC?: number | null;
  /** The restaurant's own estimate of when this food stops being good: no check may promise longer. */
  donorSafeUntil?: number | null;
  /** This item's food check; null while it runs. */
  foodCheck?: FoodCheck | null;
}

export type FoodCategory = "cooked_meal" | "bakery" | "dairy" | "packaged" | "beverages" | "raw_produce";
export const FOOD_CATEGORIES: FoodCategory[] = ["cooked_meal", "bakery", "dairy", "packaged", "beverages", "raw_produce"];
/** Result of the Food Agent (or the rules-only fallback) for one listing. */
export interface TagCheck {
  /** "diet" | "jain" | "spice" | "category" | "contains:<allergen>" */
  tag: string;
  /** In a session: which food this is about. */
  itemId?: string;
  itemName?: string;
  verdict: "wrong" | "maybe";
  certainty: "sure" | "unsure";
  seen: string;
  /** The value to use instead ("nonveg", "no", "hot", "add", a category id). */
  suggest: string;
  confidence: number;
}
export interface FoodCheck {
  status: "done";
  at: number;
  source: "food_agent" | "rules_only";
  grade: "A" | "B" | "C" | "D";
  unsure: boolean;
  photoChecked: boolean;
  /** 0–100 freshness score from the Food Agent; null for rules-only. */
  score: number | null;
  condition: string | null;
  safeUntil: number | null;
  /** Plain-language note for the donor. */
  message: string;
  reasons: string[];
  /** What the photo model saw. */
  seen: string;
  /** Exact models that answered, e.g. "gemini:gemini-2.5-flash"; photo is null when no model judged it. */
  models: { photo: string | null; reasoning: string };
  /** Why this grade, step by step, for "Show reasoning". */
  /** What diet the photo shows. */
  dietSeen?: "veg" | "egg" | "nonveg" | "unclear";
  /** Tags the photo disagrees with. "sure" holds the listing until relisted; "unsure" asks the donor to double-check. */
  tagChecks?: TagCheck[];
  tagsVerdict?: "ok" | "unsure" | "wrong";
  reasoning?: { summary: string; steps: { title: string; detail: string; effect: string; status: "pass" | "warn" | "fail" | "info" }[] } | null;
  /** The restaurant's own "good until", when it gave one: this check was capped at it (foodCheck.ts capByDonor). */
  donorSafeUntil?: number;
}
export interface FoodListing extends ListingInput {
  id: string;
  version: number;
  donorPhone: string;
  donorName: string;
  createdAt: number;
  sample: boolean;
  fingerprint: string;
  state: "in_review" | "checking" | "offered" | "unplaced" | "not_for_people" | "tags_held";
  /** A new donor's first listing: matching goes ahead, and the Luna team double-checks it (POST /listings/:id/approve). */
  reviewPending?: boolean;
  /** The state a tags_held listing returns to if the donor keeps their tags. */
  heldFrom?: "in_review" | "checking";
  /** When the donor kept tags the photo check was unsure about. */
  tagsKeptAt?: number;
  /** Set when the donor relisted this food with corrected tags. */
  replacedBy?: string;
  /** The Decision Agent's case for this listing, once the Food Agent handed it over. */
  matchId?: string;
  approval: { by: string; at: number; reason: string; key: string } | null;
  assessment: { grade: "A" | "B" | "C"; safeUntil: number; servings: number; unsure: boolean; source: "rules_only_demo" | "food_agent" | "rules_only" } | null;
  /** null while the Food Agent is still checking. */
  foodCheck: FoodCheck | null;
  /**
   * A listing session: every food the restaurant gave away at once. The single-dish fields above then hold
   * a summary (names joined, strictest diet, total servings, the first photo) so older code keeps working.
   */
  items?: ListingItem[];
}
/** One share of a case as the donor or admin sees it (api/src/matching Share, flattened). */
export interface AgentShareView {
  id: string;
  /** What's in this share, item by item, in the restaurant's units (the packing list). */
  lines: { name: string; servings: number; amount: string | null }[];
  containers: string[];
  status: "offering" | "finding_partner" | "assigned" | "picked_up" | "delivered" | "unplaced" | "failed";
  servings: number;
  ngoName: string | null;
  offerDeadlineAt: number | null;
  partnerName: string | null;
  /** Shown to the restaurant; the partner enters it at pickup. */
  pickupCode: string | null;
  arriveBy: number | null;
  pickedUpAt: number | null;
  held: boolean;
  /** Nobody has taken the pickup yet: when the wait began, and when it moves to another NGO or the window closes. */
  partnerClock: { from: number; to: number; then: "next_ngo" | "window_closes" | "released" } | null;
}
/** The agents' case for a listing: shares and every decision with its reason, oldest first. */
export interface AgentCase {
  id: string;
  status: string;
  unplacedServings: number;
  shares: AgentShareView[];
  /** The NGO Agent's ranked list for this food, best first (from the first share's candidates). */
  ranked: { ngoName: string; arriveBy: number }[];
  timeline: { at: number; agent: "food" | "ngo" | "logistics" | "decision" | null; kind: string; reason: string }[];
  /** Spec §7.5: meals (dishes that are a meal, and staples paired with sides), add-ons and extras, in servings. */
  meals: { meals: number; addons: number; extras: number; bundles: { name: string; servings: number; diet: string }[] };
  /** Servings no NGO can take with none left to ask, why, and the biogas plant that would collect them. */
  leftover: { servings: number; what: string; why: string; waitingOnPartner: number; plant: { name: string; km: number; comeBy: number } | null };
  /** Nobody took it before its window closed: when, how many NGOs were offered it, and which limit ended it. */
  lapsed: { at: number; asked: number; ended: "unsafe" | "collect_by"; cause?: "in_transit" } | null;
  /** When the agents are working to for collection (the restaurant's time, or the Food Agent's once accepted). */
  collectBy: number;
  /** The Food Agent's collect-by suggestion from the food's safe time, and the restaurant's answer once given. */
  collectSuggestion: { suggested: number; was: number; safeUntil: number; answer: "yes" | "no" | null } | null;
  /** Food the restaurant sent to biogas. */
  biogas: { id: string; plantName: string; what: string; servings: number; status: "booked" | "collected"; comeBy: number; collectedAt: number | null }[];
}
export interface ListingView extends Omit<FoodListing, "donorPhone" | "fingerprint" | "contactPhone" | "pickup" | "approval"> {
  pickup: Stop | null;
  pickupArea: string;
  approval: { by: string; at: number; reason: string } | null;
  progress: string;
  tripId: string | null;
  trackingUrl: string | null;
  recipientName: string | null;
  deliveredAt: number | null;
  offerDeadline: number | null;
  offerRecipientName: string | null;
  serverNow: number;
  agentCase: AgentCase | null;
  /** The donation label FSSAI expects on donated food (impact/label.ts), for the restaurant to print. */
  label: DonationLabel | null;
}
