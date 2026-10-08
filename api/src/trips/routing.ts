import { TRIP_CONFIG as C } from "./config.ts";
import { decodePolyline, distance, pathLength, project } from "./geo.ts";
import { DEMO_ROADS } from "./demo-roads.ts";
import { pickupStage } from "./engine.ts";
import type { DeliveryTrip, LatLng, TripRoute, Vehicle } from "./types.ts";

interface GoogleStep { distanceMeters?: number; polyline?: { encodedPolyline: string }; navigationInstruction?: { instructions?: string; maneuver?: string } }
interface GoogleRoute {
  distanceMeters: number; duration: string; polyline: { encodedPolyline: string };
  legs?: { steps?: GoogleStep[] }[]; warnings?: string[];
}
export async function googleRoute(t: DeliveryTrip, now: number, fetcher: typeof fetch = fetch): Promise<TripRoute> {
  if (!process.env.GOOGLE_MAPS_ROUTES_KEY) throw new Error("Live directions are not configured yet. Your delivery status will still update.");
  if (!t.location || now - t.location.at > C.staleMs) throw new Error("Waiting for a fresh delivery partner location to calculate directions.");
  const target = pickupStage(t) ? "pickup" : "drop";
  return googleDirections(t.location, t[target], t.vehicle, target, now, fetcher);
}

/** Google Routes from any point to any stop: traffic-aware for two-wheelers and cars, with turn-by-turn steps. */
export async function googleDirections(origin: LatLng, destination: LatLng, vehicle: Vehicle, target: TripRoute["target"], now: number, fetcher: typeof fetch = fetch): Promise<TripRoute> {
  const key = process.env.GOOGLE_MAPS_ROUTES_KEY;
  if (!key) throw new Error("Live directions are not configured yet. Your delivery status will still update.");
  const travelMode = { foot: "WALK", bicycle: "BICYCLE", two_wheeler: "TWO_WHEELER", car: "DRIVE" }[vehicle];
  const traffic = travelMode === "DRIVE" || travelMode === "TWO_WHEELER";
  const response = await fetcher("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST", signal: AbortSignal.timeout(C.routeTimeoutMs),
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.polyline.encodedPolyline,routes.legs.steps.navigationInstruction,routes.warnings" },
    body: JSON.stringify({ origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
      travelMode, ...(traffic ? { routingPreference: "TRAFFIC_AWARE_OPTIMAL" } : {}),
      polylineQuality: "HIGH_QUALITY", languageCode: "en", units: "METRIC" }),
  });
  if (!response.ok) throw new Error("Directions are temporarily unavailable. Retry when your connection is ready.");
  const data = await response.json() as { routes?: GoogleRoute[] }, r = data.routes?.[0];
  if (!r?.polyline?.encodedPolyline || !Number.isFinite(r.distanceMeters) || !Number.isFinite(parseFloat(r.duration)))
    throw new Error("No route was found for this vehicle. Contact the Luna team.");
  const warnings = [...(r.warnings ?? [])];
  if (travelMode !== "DRIVE") warnings.push("Walking, bicycle and two-wheeler routes are in beta and may be missing sidewalks, pedestrian or cycling paths.");
  return { provider: "google", target, computedAt: now, path: decodePolyline(r.polyline.encodedPolyline),
    distanceM: r.distanceMeters, durationS: parseFloat(r.duration), warnings,
    steps: (r.legs ?? []).flatMap(l => (l.steps ?? []).map(step => ({
      instruction: step.navigationInstruction?.instructions ?? "Continue along the route",
      maneuver: step.navigationInstruction?.maneuver ?? "STRAIGHT", distanceM: step.distanceMeters ?? 0,
      path: step.polyline ? decodePolyline(step.polyline.encodedPolyline) : [],
    }))) };
}
interface Entry { route: TripRoute | null; error: string | null; triedAt: number; target: string }
/** Public OSRM is for the explicitly labelled sample only, never production dispatch. */
export async function demoRoute(t: DeliveryTrip, now: number, fetcher: typeof fetch = fetch): Promise<TripRoute> {
  if (!t.sample) throw new Error("Demo routing cannot be used for a real delivery.");
  if (!t.location) throw new Error("Waiting for a sample location.");
  const target = pickupStage(t) ? "pickup" : "drop";
  const route = await osrmDirections(t.location, t[target], target, now, fetcher);
  route.warnings = ["Demo road route · driving profile · no live traffic. Partner movement is simulated."];
  return route;
}

/**
 * The public OSRM demo router: no traffic and no service guarantee. Only for the walkthrough, and for real
 * deliveries while no Google key is configured (LUNA_MAP_FALLBACK=off turns that off), always labelled.
 */
export async function osrmDirections(origin: LatLng, destination: LatLng, target: TripRoute["target"], now: number, fetcher: typeof fetch = fetch): Promise<TripRoute> {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${destination.lng},${destination.lat}?overview=full&geometries=geojson&steps=true`;
  const response = await fetcher(url, { signal: AbortSignal.timeout(C.routeTimeoutMs) });
  if (!response.ok) throw new Error("The demo road route is temporarily unavailable. Retry shortly.");
  type Geometry = { coordinates: [number, number][] };
  const data = await response.json() as { code: string; routes: { distance: number; duration: number; geometry: Geometry; legs: { steps: { distance: number; name: string; maneuver: { type: string; modifier?: string }; geometry: Geometry }[] }[] }[] };
  const r = data.routes?.[0];
  if (data.code !== "Ok" || !r?.geometry?.coordinates?.length || !Number.isFinite(r.distance) || !Number.isFinite(r.duration)) throw new Error("No demo road route was found.");
  const path = (g: Geometry) => g.coordinates.map(([lng, lat]) => ({ lat, lng }));
  return { provider: "osrm-demo", computedAt: now, target, path: path(r.geometry), distanceM: r.distance, durationS: r.duration,
    warnings: ["Approximate road route · no live traffic."],
    steps: r.legs.flatMap(l => l.steps.map(step => ({ distanceM: step.distance, path: path(step.geometry), maneuver: step.maneuver.type,
      instruction: demoInstruction(step.maneuver.type, step.maneuver.modifier, step.name) }))) };
}
function demoInstruction(type: string, modifier: string | undefined | null, name: string) {
  const road = name ? ` ${name}` : " the road";
  if (type === "arrive") return "Arrive at the destination";
  if (type === "depart") return `Head along${road}`;
  if (type === "turn" || type === "end of road") return `Turn ${modifier ?? "ahead"}${name ? ` onto${road}` : ""}`;
  if (type === "fork") return `Keep ${modifier ?? "straight"}${name ? ` towards${road}` : ""}`;
  if (["roundabout", "rotary"].includes(type)) return `Enter the roundabout${name ? ` towards${road}` : ""}`;
  if (["exit roundabout", "exit rotary"].includes(type)) return `Exit the roundabout${name ? ` onto${road}` : ""}`;
  if (type === "merge") return `Merge${name ? ` onto${road}` : " ahead"}`;
  return `Continue on${road}`;
}
/** Recorded provider geometry is a demo-only fallback, restricted to the known road corridors. */
export function recordedDemoRoute(t: DeliveryTrip, now: number): TripRoute | null {
  if (!t.sample || !t.location) return null;
  const target = pickupStage(t) ? "pickup" : "drop";
  const road = DEMO_ROADS.find(r => r.target === target && distance(r.destination, t[target]) <= C.snapM);
  if (!road) return null;
  const p = project(t.location, road.path);
  if (p.distanceM > C.snapM) return null;
  const path = [p.point, ...road.path.slice(p.index + 1)], remainingM = pathLength(path);
  // Recorded step paths are clipped to the remaining route to keep navigation progress consistent.
  const steps = road.steps.filter(step => step.path.length && project(step.path.at(-1)!, road.path).progressM >= p.progressM).map(step => {
    const start = project(step.path[0], road.path).progressM;
    return { distanceM: Math.max(0, step.distanceM - Math.max(0, p.progressM - start)), path: step.path,
      maneuver: step.type, instruction: demoInstruction(step.type, step.modifier, step.name) };
  });
  return { provider: "osrm-demo", recordedAt: road.recordedAt, computedAt: now, target, path,
    distanceM: remainingM, durationS: road.durationS * remainingM / road.distanceM, steps,
    warnings: ["Recorded demo road route · live demo router unavailable · no live traffic. Partner movement is simulated."] };
}
const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<Entry>>();
export async function routeFor(input: DeliveryTrip, now: number, preview = false): Promise<Entry> {
  const t = preview ? { ...input, status: "to_drop" as const, location: { ...input.pickup, at: now, accuracyM: 0, speedMps: null, heading: null } } : input;
  const target = pickupStage(t) ? "pickup" : "drop", destination = t[target];
  const tag = `${t.routeRevision ?? 1}:${preview}:${target}:${destination.lat}:${destination.lng}:${t.vehicle}`;
  const previous = cache.get(t.id);
  const offRoute = !!(previous?.route && t.location && project(t.location, previous.route.path).distanceM > C.offRouteM);
  if (previous?.target === tag && now - previous.triedAt < (offRoute || previous.error ? C.routeRetryMs : C.routeRefreshMs)) return previous;
  const inflight = pending.get(t.id);
  if (inflight) { await inflight; return routeFor(input, now, preview); }
  const task = (async () => {
    let entry: Entry;
    try { const route = await (t.sample ? demoRoute(t, now) : googleRoute(t, now)); route.preview = preview; entry = { route, error: null, triedAt: now, target: tag }; }
    catch (e) {
      const recorded = recordedDemoRoute(t, now);
      if (recorded) { recorded.preview = preview; entry = { route: recorded, error: null, triedAt: now, target: tag }; }
      else entry = { route: previous?.target === tag ? previous.route : null, error: e instanceof Error ? e.message : "Directions are temporarily unavailable.", triedAt: now, target: tag };
    }
    cache.set(t.id, entry);
    // Expire ephemeral Google content; do not write geometry/instructions to Postgres.
    for (const [id, cached] of cache) if (now - cached.triedAt > C.routeRefreshMs * 2) cache.delete(id);
    return entry;
  })();
  pending.set(t.id, task);
  try { return await task; } finally { pending.delete(t.id); }
}
