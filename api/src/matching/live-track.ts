/**
 * The live map for one share (spec §12.7, §15.6): pickup and drop, the partner's last GPS fix, the road route
 * to the next stop and an ETA. The same shape the walkthrough's trip map draws, so every app reuses it:
 * the partner follows their own route, the restaurant watches the partner come, the NGO watches the food come.
 *
 * Routes come from Google (traffic-aware, turn by turn) when GOOGLE_MAPS_ROUTES_KEY is set; otherwise from the
 * public OSRM router, labelled approximate (LUNA_MAP_FALLBACK=off turns that off). Route geometry is kept in
 * memory only, never stored.
 */
import { TRIP_CONFIG as C } from "../trips/config.ts";
import { pathLength, project } from "../trips/geo.ts";
import { googleDirections, osrmDirections } from "../trips/routing.ts";
import type { Stop, TripPoint, TripRoute, Vehicle } from "../trips/types.ts";
import { areaById } from "./seed.ts";
import type { MatchingStore } from "./store.ts";
import type { Share, Travel } from "./types.ts";

export type Viewer = "donor" | "ngo" | "partner" | "admin";

export interface LiveTrack {
  id: string;
  sample: false;
  routeRevision: number;
  status: "finding_partner" | "to_pickup" | "to_drop" | "delivered" | "closed";
  partnerName: string | null;
  vehicle: Vehicle;
  pickup: Stop;
  drop: Stop | null;
  location: TripPoint | null;
  locationVisible: boolean;
  pickedUpAt: number | null;
  closedAt: number | null;
  route: TripRoute | null;
  routeError: string | null;
  /** When the partner reaches the next stop, from the route's remaining time. */
  eta: number | null;
  /** Road distance left to the next stop. */
  distanceM: number | null;
}

const VEHICLE: Record<Travel, Vehicle> = { two_wheeler: "two_wheeler", bicycle: "bicycle", car: "car", foot: "foot", transit: "foot" };
/** A fix older than this doesn't draw a route: the partner may have stopped sharing. */
const ROUTE_FIX_MS = 2 * 60_000;

interface Cached {
  key: string;
  route: TripRoute | null;
  error: string | null;
  at: number;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Cached>>();

async function directions(share: Share, origin: TripPoint, dest: Stop, vehicle: Vehicle, target: TripRoute["target"], now: number): Promise<Cached> {
  const key = `${target}:${dest.lat}:${dest.lng}:${vehicle}`;
  const prev = cache.get(share.id);
  const offRoute = !!(prev?.route && project(origin, prev.route.path).distanceM > C.offRouteM);
  const fresh = prev && prev.key === key && now - prev.at < (offRoute || prev.error ? C.routeRetryMs : C.routeRefreshMs);
  if (fresh) return prev;
  const running = inflight.get(share.id);
  if (running) return running;
  const task = (async (): Promise<Cached> => {
    let entry: Cached;
    try {
      const route = process.env.GOOGLE_MAPS_ROUTES_KEY
        ? await googleDirections(origin, dest, vehicle, target, now)
        : process.env.LUNA_MAP_FALLBACK !== "off"
          ? await osrmDirections(origin, dest, target, now)
          : null;
      entry = route ? { key, route, error: null, at: now } : { key, route: null, error: "Live directions need a Google Maps key. The partner's position still updates.", at: now };
    } catch (e) {
      entry = { key, route: prev?.key === key ? prev.route : null, error: (e as Error).message, at: now };
    }
    cache.set(share.id, entry);
    for (const [id, c] of cache) if (now - c.at > C.routeRefreshMs * 3) cache.delete(id);
    return entry;
  })();
  inflight.set(share.id, task);
  try {
    return await task;
  } finally {
    inflight.delete(share.id);
  }
}

export async function liveTrack(store: MatchingStore, share: Share, viewer: Viewer, now: number): Promise<LiveTrack> {
  const l = (await store.get("listing", share.listingId))!;
  const ngo = share.ngoId ? await store.get("recipient", share.ngoId) : null;
  const p = share.partnerId ? await store.get("partner", share.partnerId) : null;
  const vehicle = VEHICLE[p?.travel ?? "two_wheeler"];
  const area = (id: string) => areaById(id)?.name ?? id;
  const pickup: Stop = { name: l.donorName, address: l.pickupAddress, area: area(l.areaId), notes: l.pickupNotes ?? "", lat: l.lat, lng: l.lng };
  const drop: Stop | null = ngo ? { name: ngo.name, address: area(ngo.areaId), area: area(ngo.areaId), notes: "", lat: ngo.lat, lng: ngo.lng } : null;
  const status: LiveTrack["status"] =
    share.status === "assigned" ? "to_pickup" : share.status === "picked_up" ? "to_drop" : share.status === "delivered" ? "delivered" : share.status === "finding_partner" || share.status === "offering" ? "finding_partner" : "closed";
  const moving = status === "to_pickup" || status === "to_drop";
  // Who sees the partner: the partner and admins always; the NGO for the whole trip; the restaurant until
  // ten minutes after pickup (spec §12.7: its live tracking ends then, the status carries on).
  const locationVisible =
    moving && (viewer === "partner" || viewer === "admin" || viewer === "ngo" || (viewer === "donor" && (status === "to_pickup" || now - (share.pickedUpAt ?? now) < C.donorTrackAfterPickupMs)));
  const fix = share.lastFix ?? null;
  const location: TripPoint | null = moving && fix ? { lat: fix.lat, lng: fix.lng, at: fix.at, accuracyM: fix.accuracyM, speedMps: fix.speedMps, heading: fix.heading } : null;

  let route: TripRoute | null = null, routeError: string | null = null, eta: number | null = null, distanceM: number | null = null;
  const target = status === "to_pickup" ? "pickup" : "drop";
  const dest = target === "pickup" ? pickup : drop;
  if (moving && dest && location && now - location.at < ROUTE_FIX_MS) {
    const c = await directions(share, location, dest, vehicle, target, now);
    route = c.route;
    routeError = c.error;
    if (route && route.path.length > 1) {
      // Time left scales with the road left, so the ETA moves with every fix without a new route request.
      const total = pathLength(route.path) || route.distanceM;
      const left = Math.max(0, total - project(location, route.path).progressM);
      distanceM = Math.round(left);
      eta = location.at + (route.durationS * 1000 * left) / (total || 1);
    }
  } else if (moving && !location) routeError = "Waiting for the partner's location.";

  return {
    id: share.id,
    sample: false,
    routeRevision: 1 + (share.redirectTried?.length ?? 0),
    status,
    partnerName: p?.name ?? null,
    vehicle,
    pickup,
    drop,
    location: locationVisible ? location : null,
    locationVisible,
    pickedUpAt: share.pickedUpAt ?? null,
    closedAt: moving ? null : now,
    route: locationVisible ? route : null,
    routeError: locationVisible ? routeError : null,
    eta,
    distanceM,
  };
}
