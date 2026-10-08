import type { TripView } from "../../../../api/src/trips/types";
import { TRIP_CONFIG } from "../../../../api/src/trips/config";
export type { TripView, TripPoint, TripRoute, LatLng, LegStatus, PickupCheck } from "../../../../api/src/trips/types";
export { TRIP_CONFIG } from "../../../../api/src/trips/config";
export { along, bearing, distance, interpolate, pathLength, predict, project, smoothPosition } from "../../../../api/src/trips/geo";
export const TRIP_STATUS: Record<TripView["status"], string> = {
  assigned: "Delivery partner assigned", to_pickup: "Heading to pickup", at_pickup: "At the pickup",
  picked_up: "Checking the food", to_drop: "On the way to the NGO", at_drop: "At the NGO",
  delivered: "Delivered. Thank you!", held: "Luna team review needed", failed_at_pickup: "Food did not pass the pickup check",
};
export const tripTime = (at: number) => new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit", hour12: true }).format(at);

/** Cached offline snapshots still obey time-based visibility restrictions. */
export function visibleTrip(trip: TripView | null, role: string, now: number): TripView | null {
  if (!trip) return null;
  const hidden = !!trip.closedAt || role === "donor" && !!trip.pickedUpAt && now > trip.pickedUpAt + TRIP_CONFIG.donorTrackAfterPickupMs;
  const addressesExpired = !!trip.closedAt && now > trip.closedAt + TRIP_CONFIG.contactAfterCloseMs;
  return { ...trip, ...(hidden ? { location: null, locationVisible: false, route: null } : {}),
    ...(addressesExpired ? { pickup: null, drop: null } : {}), ...(trip.closedAt ? { code: undefined, offlineCodes: undefined } : {}) };
}

export interface QueuedAction { key: string; action: string; body: Record<string, unknown> }
export interface TripCache { trip: TripView | null; queue: QueuedAction[]; codeTries: { pickup: number; drop: number } }
let database: Promise<IDBDatabase> | null = null;
function db() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("luna-delivery-trips", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("trips");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Offline storage is unavailable. Keep your connection active."));
  });
  return database;
}
export async function readTripCache(key: string): Promise<TripCache | null> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("trips").objectStore("trips").get(key);
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
  });
}
export async function writeTripCache(key: string, value: TripCache) {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("trips", "readwrite");
    // Google geometry/instructions are ephemeral; retain only our own delivery snapshot.
    tx.objectStore("trips").put({ ...value, trip: value.trip ? { ...value.trip, route: null } : null }, key);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export async function offlineCodeMatches(salt: string, hash: string, code: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${salt}:${code}`));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, "0")).join("") === hash;
}
