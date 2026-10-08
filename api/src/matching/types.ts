/**
 * Data shared by Luna's agents. A Listing plus its Items is the Food Passport
 * that the Food Agent produces and every other agent works from. Field names
 * from the Food Agent (servings, grade, confidence, safeTime, ...) are
 * provisional: they are read in one place, parseListing() in routes.ts.
 */

export type Grade = "A" | "B" | "C" | "D";
/** What the food is. Recipients list which of these they accept. */
export type Diet = "veg" | "jain" | "egg" | "nonveg" | "unknown";
export const KNOWN_DIETS: Diet[] = ["veg", "jain", "egg", "nonveg"];
export type Storage = "room" | "fridge" | "hot";
export type Travel = "two_wheeler" | "bicycle" | "car" | "foot" | "transit";
export type RecipientKind =
  | "ngo"
  | "shelter"
  | "orphanage"
  | "old_age_home"
  | "community_fridge"
  | "animal_shelter"
  | "compost";

export interface LatLng {
  lat: number;
  lng: number;
}

/** "6 kg", "4 L", "40 pieces". */
export interface Quantity {
  amount: number;
  unit: string;
}

export interface Item {
  id: string;
  /** Dish name: "veg biryani". */
  name?: string;
  tags?: string[];
  /** How it's packed: "foil trays", "steel vessel". */
  packing?: string;
  /** How much, as the restaurant measures it. */
  quantity?: Quantity;
  servings: number; // checker
  /** Kind of food ("cooked_meal", "bakery", …), for NGOs that only take some kinds. */
  category?: string;
  /** For packing and containers (spec §9.5): container type, and litres per serving for loose food. */
  container?: "box" | "leakproof" | "tray" | "bag";
  litresPerServing?: number | null;
  grade: Grade; // checker
  confidence: number; // checker, 0–100
  safeTime: number; // checker, minutes safe from listing time
  diet: Diet; // donor
  halal?: boolean; // donor
  allergens?: string[]; // donor
  /** A meal made of a staple and a side (spec §7.5): one serving of each per serving of this. See engine/bundles.ts. */
  bundle?: { staple: string; side: string };
}

export type ListingStatus = "review" | "matching" | "matched" | "partially_matched" | "unmatched" | "closed";

export interface Listing extends LatLng {
  id: string;
  donorPhone: string;
  donorName: string;
  areaId: string;
  pickupAddress: string;
  pickupNotes?: string;
  pickupContactPhone?: string;
  readyFrom: number;
  collectBy: number;
  storage: Storage;
  cookedAt?: number;
  /** Containers the delivery partner must bring. */
  containers: string[];
  items: Item[];
  status: ListingStatus;
  /** Servings no recipient could safely take. */
  unplacedServings: number;
  createdAt: number;
  /** The Luna API listing (food check, photo, tags) this case came from. */
  sourceListingId?: string;
  /** One pickup code for the whole session, whichever partners come (restaurants shouldn't juggle codes). */
  pickupCode?: string;
  /** The partner must bring containers (else the food is packed and only needs carry bags). */
  partnerBrings?: boolean;
  /** Staples and sides as the restaurant gave them, before pairing into meals: for packing amounts only. */
  parts?: Item[];
  /** Last time the Decision Agent asked the NGO Agent again for servings nobody could take. */
  lastReplanAt?: number;
  /** Last "still on it" sent to the donor while waiting. */
  lastHeartbeatAt?: number;
}

export interface Recipient extends LatLng {
  id: string;
  /** 10-digit phone once a real person claims this seeded recipient. */
  phone?: string;
  name: string;
  areaId: string;
  kind: RecipientKind;
  vulnerable: boolean;
  fridge: boolean;
  /** "13:00", "20:00" (India time); empty = serves on arrival. */
  servingTimes: string[];
  /** How soon after arrival they serve, when they serve on arrival. */
  servesWithinMin: number;
  acceptsDiet: Diet[];
  halalOnly: boolean;
  avoidAllergens: string[];
  capacityPerDelivery: number;
  /** Preference only: lowers the score, never filters. */
  acceptRadiusKm: number;
  active: boolean;
  /** "sample" for seeded demo NGOs; "listed" for NGOs that listed themselves in the app. */
  source?: "sample" | "listed";
  /** When the NGO takes deliveries (India time); food can't arrive outside these. */
  receivingHours?: { start: string; end: string };
  /** Kinds of food it accepts; empty or unset = any. */
  acceptsCategories?: string[];
}

/** A delivery partner: one of an NGO's own riders, or an independent. */
export interface Partner extends LatLng {
  id: string;
  /** 10-digit phone once a real person claims or registers this partner. */
  phone?: string;
  name: string;
  areaId: string;
  travel: Travel;
  online: boolean;
  /** The NGO this partner rides for; unset for independents. */
  ngoId?: string;
  /** Rides for an NGO but will also deliver for other NGOs when needed (asked after their own riders). */
  helpsOthers?: boolean;
  /** Added by an NGO coordinator for this run only (not on the app). */
  manual?: boolean;
  /** Set while the partner is being asked or is on a trip. */
  activeShareId?: string;
  /** "sample" for seeded demo partners; "volunteer" for signed-up volunteer accounts. */
  source?: "sample" | "volunteer";
  /** Reliability the Decision Agent keeps from how trips went; updated live while a trip runs late. */
  reliability?: Reliability;
}

/** One trip's mark in a partner's reliability: rewritten while the trip runs, final at the drop. */
export interface TripMark {
  shareId: string;
  at: number;
  /** 0–5 */
  score: number;
  kind: "on_time" | "late" | "reassigned" | "unsafe_delay";
  lateMin: number;
  /** The partner warned us with "Running late" before we noticed. */
  reported: boolean;
  final: boolean;
}

export interface Reliability {
  /** 0–5, recency-weighted, starting from a neutral prior. */
  score: number;
  trips: number;
  onTime: number;
  late: number;
  marks: TripMark[];
}

export interface OfferLine {
  itemId: string;
  servings: number;
}

/** One NGO the NGO Agent ranked for a share, best first. */
export interface ShareCandidate {
  ngoId: string;
  /** Projected arrival if this NGO takes it. */
  arriveBy: number;
}

export type ShareStatus =
  | "offering" // waiting for the current NGO to accept
  | "finding_partner" // NGO accepted; asking delivery partners
  | "assigned" // partner on the way to the restaurant
  | "picked_up" // pickup code matched; on the way to the NGO
  | "delivered" // drop code matched
  | "unplaced" // every candidate NGO passed; handed back to the Decision Agent
  | "failed"; // stopped and escalated

/**
 * The unit the Logistics Agent runs: part of a listing for one NGO, from the
 * offer to the drop.
 */
export interface Share {
  id: string;
  listingId: string;
  lines: OfferLine[];
  status: ShareStatus;
  candidates: ShareCandidate[];
  /** The NGO currently offered (offering) or delivering to (later states). */
  ngoId?: string;
  offerSentAt?: number;
  offerDeadlineAt?: number;
  arriveBy?: number;
  triedNgoIds: string[];
  partnerId?: string;
  askedPartnerId?: string;
  askedAt?: number;
  askDeadlineAt?: number;
  triedPartnerIds: string[];
  assignedAt?: number;
  pickedUpAt?: number;
  pickupBy: number;
  deliverBy: number;
  /** The partner reported being stuck until this time ("Running late"). */
  delayUntil?: number;
  lastPos?: LatLng;
  /** The restaurant shows it; the partner enters it at pickup. */
  pickupCode: string;
  /** The NGO shows it; the partner enters it at drop. */
  dropCode: string;
  pickupTriesLeft: number;
  dropTriesLeft: number;
  needsPickupCheck: boolean;
  /** Escalated to an admin; the agents stop re-planning it. */
  held?: boolean;
  /** A closer NGO offered the food mid-trip (Decision Agent redirect). */
  redirect?: { ngoId: string; sentAt: number; deadlineAt: number; arriveBy: number };
  redirectTried: string[];
  /** How it went, from the NGO. */
  feedback?: "fewer" | "right" | "more";
  /** Last time the Logistics Agent looked again at this share after it went unplaced. */
  retriedAt?: number;
  /** What the Logistics Agent promised when the partner was assigned. */
  promisedPickupAt?: number;
  promisedArrival?: number;
  /** Minutes behind the promised arrival at the last notice, and whether the partner warned first. */
  lateNoticeMin?: number;
  lateReported?: boolean;
  lastEtaCheckAt?: number;
  /** Accepted, but no partner was free: since when it has been waiting, and when it last looked. */
  waitingForPartnerSince?: number;
  lastPartnerTryAt?: number;
  createdAt: number;
}

export type ReasonCode =
  | "INACTIVE"
  | "EXCLUDED"
  | "GRADE_D_PEOPLE"
  | "PEOPLE_FOOD_ONLY"
  | "VULNERABLE_NEEDS_A"
  | "NEEDS_FRIDGE"
  | "DIET"
  | "EXPIRES_BEFORE_SERVING"
  | "GRADE_C_SLOW"
  | "CLOSED_AT_ARRIVAL"
  | "CATEGORY";

export type AgentName = "food" | "ngo" | "logistics" | "decision";

export type DecisionKind =
  | "review"
  | "graded"
  | "filtered"
  | "ranked"
  | "offered"
  | "accepted"
  | "declined"
  | "expired"
  | "assigned"
  | "picked_up"
  | "delayed"
  | "redirected"
  | "escalated"
  | "gap_outreach"
  | "pledged"
  | "delivered"
  | "feedback"
  | "closed"
  | "message_failed"
  | "replanned"
  | "rated"
  | "reassigned";

export interface Decision {
  id: string;
  at: number;
  /** Tie-breaker for decisions in the same millisecond. */
  seq?: number;
  /** Which agent made it. */
  agent?: AgentName;
  listingId?: string;
  /** Who or what the decision is about (NGO, partner, area…). */
  subject: string;
  kind: DecisionKind;
  /** Plain English. */
  reason: string;
  data?: unknown;
}

/** One outgoing WhatsApp message. `to` is unset for simulated (unclaimed) people. */
export interface OutboxMessage {
  id: string;
  to?: string;
  /** Who it is for, for logs: "recipient:r-…", "partner:p-…", "donor:98…". */
  audience: string;
  text: string;
  buttons?: { id: string; title: string }[];
  /** Approved template to use when templates are switched on. */
  template?: { name: string; params: string[] };
  status: "pending" | "sent" | "simulated" | "failed";
  attempts: number;
  nextAt: number;
  createdAt: number;
  error?: string;
}

export interface PriorityCredit {
  id: string;
  recipientId: string;
  status: "open" | "used";
  reason: string;
  createdAt: number;
}

export interface ContactLog {
  id: string;
  donorKey: string;
  at: number;
}

export interface Pledge {
  id: string;
  donorKey: string;
  areaId: string;
  status: "asked" | "yes" | "no" | "used";
  until: number;
  createdAt: number;
}

export interface InboundSeen {
  id: string;
  at: number;
}
