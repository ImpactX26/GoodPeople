/**
 * Calls to Luna's agents (Food, NGO, Logistics, Decision) on the API.
 * Shapes mirror api/src/matching/types.ts; only the fields screens use.
 */
import { api, API_URL } from "./api";
import { getSession } from "./auth";

const token = () => getSession()?.token ?? null;
/** The agents are mounted under /agents on the Luna API. */
const get = <T>(path: string) => api<T>(`/agents${path}`, { token: token() });
const post = <T = Result>(path: string, body: unknown = {}) => api<T>(`/agents${path}`, { method: "POST", token: token(), body: JSON.stringify(body) });

export type Result = { ok: true; message?: string } | { ok: false; error: string };
export type Grade = "A" | "B" | "C" | "D";
export type Diet = "veg" | "jain" | "egg" | "nonveg" | "unknown";
export type Storage = "room" | "fridge" | "hot";
export type ShareStatus = "offering" | "finding_partner" | "assigned" | "picked_up" | "delivered" | "unplaced" | "failed";
export type ListingStatus = "review" | "matching" | "matched" | "partially_matched" | "unmatched" | "closed";

export interface Quantity {
  amount: number;
  unit: string;
}

export interface NewItem {
  name: string;
  servings: number;
  quantity?: Quantity;
  diet: Diet;
  /** Food Agent fields; entered by hand until the AI checker is connected. */
  grade: Grade;
  confidence: number;
  safeTime: number;
}

export interface NewListing {
  items: NewItem[];
  storage: Storage;
  containers: string[];
  pickupNotes?: string;
}

export interface Item extends Omit<NewItem, "name"> {
  id: string;
  name?: string;
  halal?: boolean;
  allergens?: string[];
  category?: string;
  /** Includes the role: "meal", "staple", "side" or "extra". */
  tags?: string[];
}

export interface Listing {
  id: string;
  donorName: string;
  items: Item[];
  status: ListingStatus;
  unplacedServings: number;
  createdAt: number;
  containers: string[];
}

export interface Share {
  id: string;
  listingId: string;
  lines: { itemId: string; servings: number }[];
  status: ShareStatus;
  ngoId?: string;
  offerDeadlineAt?: number;
  arriveBy?: number;
  partnerId?: string;
  askedPartnerId?: string;
  askDeadlineAt?: number;
  redirect?: { ngoId: string; deadlineAt: number; arriveBy: number };
  feedback?: "fewer" | "right" | "more";
  held?: boolean;
  createdAt: number;
  pickupCode?: string;
  dropCode?: string;
}

export interface Decision {
  id: string;
  at: number;
  agent?: "food" | "ngo" | "logistics" | "decision";
  kind: string;
  subject: string;
  reason: string;
  listingId?: string;
}

export interface Track {
  shareId: string;
  status: ShareStatus;
  pickup: { name: string; lat: number; lng: number };
  drop: { name: string; lat: number; lng: number } | null;
  partner: { name: string; lat: number; lng: number; manual: boolean; rating?: string | null } | null;
  eta: number | null;
  /** Minutes behind the arrival promised when the partner was assigned. */
  lateMin?: number;
  containers: string[];
  keepReady: string;
}

/** Restaurant */
export const listFood = (l: NewListing) => post<Listing>("/listings", l);
export const myListings = () => get<Listing[]>("/listings");
export const listingDetail = (id: string) =>
  get<{ listing: Listing; shares: (Share & { ngoName?: string })[]; timeline: Decision[] }>(`/listings/${id}`);
export const track = (shareId: string) => get<Track>(`/shares/${shareId}/track`);

/** NGO and partner: which sample NGO or partner this phone stands in for. */
export const linked = (refresh = false) =>
  get<{ recipients: { id: string; name: string }[]; partners: LinkedPartner[] }>(`/linked${refresh ? "?refresh=1" : ""}`);
export interface LinkedPartner {
  id: string; name: string; online: boolean; ngoId?: string; helpsOthers?: boolean;
  reliability?: { line: string; score: number | null; trips: number; onTime: number };
}

/** What the agents told me, newest first (the same words WhatsApp would carry). */
export const myUpdates = () => get<{ id: string; at: number; text: string }[]>("/me/updates");

/** One of a share's food photos (`i`: which food), loaded with my sign-in (img tags can't send it). */
export async function sharePhoto(shareId: string, i = 0): Promise<string | null> {
  const res = await fetch(`${API_URL}/agents/shares/${shareId}/photo?i=${i}`, { headers: { Authorization: `Bearer ${token() ?? ""}` } });
  return res.ok ? URL.createObjectURL(await res.blob()) : null;
}

/** Which photos a share has: one per food in the listing, with the food's name. */
export async function sharePhotoList(shareId: string): Promise<{ i: number; dish: string }[]> {
  const res = await fetch(`${API_URL}/agents/shares/${shareId}/photos`, { headers: { Authorization: `Bearer ${token() ?? ""}` } });
  if (!res.ok) return [{ i: 0, dish: "" }];   // an older server: just the one photo
  return ((await res.json()) as { photos: { i: number; dish: string }[] }).photos;
}

/** NGO */
/** Each food carries its own grade and safe-until: foods in one listing are checked one by one. */
export type NgoShare = Share & { donorName?: string; food: (Partial<Item> & { servings: number; safeUntil?: number })[] };
export const ngoShares = () => get<NgoShare[]>("/shares");
export const answerOffer = (id: string, accept: boolean) => post(`/shares/${id}/${accept ? "accept" : "decline"}`);
export const answerRedirect = (id: string, accept: boolean) => post(`/shares/${id}/redirect/${accept ? "accept" : "decline"}`);
export const assignByHand = (id: string, name: string, phone?: string) => post(`/shares/${id}/assign`, phone ? { name, phone } : { name });
export const sendFeedback = (id: string, result: "fewer" | "right" | "more") => post(`/shares/${id}/feedback`, { result });

/** Delivery partner */
export type Trip = Share & Track & {
  pickupDetails?: { address: string; notes?: string; contact?: string };
  /** From this partner to the restaurant, then on to the NGO. */
  travel?: { toPickupMin: number; toDropMin: number | null } | null;
  servings?: number;
  hasPhoto?: boolean;
};
export const myTrips = () => get<Trip[]>("/trips");
/** Pickups an NGO accepted that no partner has taken and I could take; `missed`: I was asked and didn't answer. */
export type OpenPickup = Trip & { missed: boolean; waitingSince: number };
export const openPickups = () => get<OpenPickup[]>("/partner/open");
export const claimPickup = (id: string) => post(`/trips/${id}/claim`);
export const setOnline = (online: boolean, pos?: { lat: number; lng: number }) => post("/partner/online", { online, ...pos });
export const answerTrip = (id: string, accept: boolean) => post(`/trips/${id}/${accept ? "accept" : "decline"}`);
export const runningLate = (id: string) => post(`/trips/${id}/late`);
/** One GPS fix from the phone: position, and when it has them, accuracy (m), speed (m/s) and heading (degrees). */
export const sendLocation = (id: string, fix: { lat: number; lng: number; accuracyM?: number | null; speedMps?: number | null; heading?: number | null }) =>
  post(`/trips/${id}/location`, fix);
/** Pickup or drop code. NGO coordinators use this for someone they assigned by hand. */
export const enterCode = (id: string, which: "pickup" | "drop", code: string) => post(`/trips/${id}/${which}`, { code });

/** Admin */
export const decisions = (limit = 40) => get<Decision[]>(`/admin/decisions?limit=${limit}`);
export const escalations = () => get<Decision[]>("/admin/escalations");
export const reviewQueue = () => get<Listing[]>("/admin/listings?status=review");
export const approve = (id: string) => post(`/admin/listings/${id}/approve`);
export const adminRecipients = () => get<{ id: string; name: string; areaId: string; phone?: string }[]>("/admin/recipients");
export const adminPartners = () => get<{ id: string; name: string; areaId: string; phone?: string; ngoId?: string }[]>("/admin/partners");
export const linkPhone = (kind: "recipients" | "partners", id: string, phone: string) => post(`/admin/${kind}/${id}/claim`, { phone });

/** Times are Bengaluru time, whatever the device's zone. */
const clock = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });
export const fmtTime = (ms: number) => clock.format(new Date(ms)).toLowerCase();

export const foodLine = (items: { name?: string; servings: number }[]) => items.map((i) => `${i.servings} × ${i.name ?? "food"}`).join(", ");
