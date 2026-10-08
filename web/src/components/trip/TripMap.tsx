"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { bearing, smoothPosition, predict, project, TRIP_CONFIG as C, type LatLng, type TripView } from "@/lib/luna/trip";
import s from "./trip.module.css";

let mapsPromise: Promise<typeof google.maps> | null = null;
function loadMaps(): Promise<typeof google.maps> {
  const key = process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY;
  if (!key) return Promise.reject(new Error("The in-app map needs a Google Maps key. Delivery status and handover steps are still available."));
  mapsPromise ??= new Promise<typeof google.maps>((resolve, reject) => {
    if (typeof google !== "undefined" && google.maps) { resolve(google.maps); return; }
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&callback=__lunaMapsReady`;
    const host = window as typeof window & { __lunaMapsReady?: () => void; gm_authFailure?: () => void };
    const timer = window.setTimeout(() => reject(new Error("The map could not load. Check your connection and retry.")), C.staleMs);
    host.__lunaMapsReady = () => { clearTimeout(timer); resolve(google.maps); delete host.__lunaMapsReady; };
    host.gm_authFailure = () => { clearTimeout(timer); reject(new Error("Google Maps could not authorize this app. Check the configured browser key.")); };
    script.onerror = () => { clearTimeout(timer); reject(new Error("The map could not load. Check your connection.")); };
    document.head.appendChild(script);
  }).catch(e => { mapsPromise = null; throw e; });
  return mapsPromise;
}

/** What the maps draw: a walkthrough trip, or a real delivery's live view (api/src/matching/live-track.ts). */
export type MapTrip = Pick<TripView, "sample" | "routeRevision" | "location" | "locationVisible" | "closedAt" | "route" | "pickup" | "drop">;

const DemoMap = dynamic(() => import("./DemoMap"), { ssr: false, loading: () => <div className={s.mapWait}>Loading the street map…</div> });
/** Google Maps when a browser key is set; the walkthrough, and real deliveries without a key, use the street map. */
export default function TripMap(props: { trip: MapTrip; partner: boolean }) {
  return props.trip.sample || !process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY ? <DemoMap {...props} /> : <GoogleTripMap key={props.trip.routeRevision} {...props} />;
}
function GoogleTripMap({ trip, partner }: { trip: MapTrip; partner: boolean }) {
  const container = useRef<HTMLDivElement>(null), map = useRef<google.maps.Map | null>(null);
  const latest = useRef(trip), follow = useRef(partner);
  useEffect(() => { latest.current = trip; }, [trip]);
  const [ready, setReady] = useState(false), [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(partner), [retry, setRetry] = useState(0);
  const line = useRef<google.maps.Polyline | null>(null);

  useEffect(() => {
    let cancelled = false, animation = 0;
    const markers: google.maps.Marker[] = [];
    let overlay: google.maps.OverlayView | null = null;
    void loadMaps().then(maps => {
      if (cancelled || !container.current) return;
      setError(null);
      const initial = latest.current;
      const instance = new maps.Map(container.current, {
        center: initial.location ?? initial.pickup ?? { lat: 12.9352, lng: 77.6245 }, zoom: partner ? C.partnerZoom : C.observerZoom,
        disableDefaultUI: true, zoomControl: true, gestureHandling: "greedy", clickableIcons: false,
        styles: [{ featureType: "all", stylers: [{ saturation: -100 }] }, { featureType: "poi", stylers: [{ visibility: "off" }] }],
      });
      map.current = instance;
      instance.addListener("dragstart", () => { follow.current = false; setFollowing(false); });
      for (const [stop, label] of [[initial.pickup, "P"], [initial.drop, "D"]] as const) {
        if (stop) markers.push(new maps.Marker({ map: instance, position: stop, title: `${label === "P" ? "Pickup" : "Drop"}: ${stop.name}`,
          label: { text: label, color: "#fbfaf6", fontWeight: "700" },
          icon: { path: maps.SymbolPath.CIRCLE, fillColor: "#1b1b1b", fillOpacity: 1, strokeColor: "#fbfaf6", strokeWeight: 3, scale: 14 } }));
      }
      line.current = new maps.Polyline({ map: instance, strokeColor: "#d52a22", strokeOpacity: 1, strokeWeight: 6, zIndex: 5 });
      class PartnerMarker extends maps.OverlayView {
        element = document.createElement("div");
        position: LatLng | null = initial.location;
        heading = initial.location?.heading ?? 0;
        onAdd() { this.element.className = s.marker; this.element.setAttribute("role", "img"); this.element.setAttribute("aria-label", partner ? "Your location" : "Delivery partner location"); this.getPanes()!.overlayMouseTarget.appendChild(this.element); }
        draw() {
          this.element.hidden = !this.position;
          if (!this.position) return;
          const projection = this.getProjection();
          if (!projection) return;
          const p = projection.fromLatLngToDivPixel(new maps.LatLng(this.position));
          if (p) { this.element.style.left = `${p.x}px`; this.element.style.top = `${p.y}px`; this.element.style.transform = `translate(-50%, -50%) rotate(${this.heading}deg)`; }
        }
        onRemove() { this.element.remove(); }
      }
      const marker = new PartnerMarker(); overlay = marker; marker.setMap(instance);
      let rendered = initial.location as LatLng | null, previousAt = performance.now(), lastCameraAt = 0;
      const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
      const frame = (at: number) => {
        const t = latest.current, point = t.location;
        if (point && t.locationVisible && !t.closedAt) {
          const target = predict(point, t.route?.path ?? [], Date.now());
          const amount = reduced ? 1 : Math.min(1, (at - previousAt) / C.animationMs * C.animationEase);
          rendered = rendered ? smoothPosition(rendered, target, t.route?.preview ? [] : t.route?.path ?? [], amount) : target;
          marker.position = rendered;
          const nearest = t.route && t.route.path.length > 1 ? project(point, t.route.path) : null;
          const routeHeading = nearest && t.route ? bearing(t.route.path[nearest.index], t.route.path[nearest.index + 1]) : marker.heading;
          const heading = point.heading ?? (Number.isFinite(routeHeading) ? routeHeading : marker.heading);
          marker.heading += ((heading - marker.heading + 540) % 360 - 180) * amount;
          marker.element.dataset.stale = String(Date.now() - point.at > C.staleMs);
          marker.draw();
          if (follow.current && at - lastCameraAt >= C.cameraUpdateMs) { instance.panTo(rendered); lastCameraAt = at; }
        } else { marker.position = null; marker.draw(); }
        previousAt = at; animation = requestAnimationFrame(frame);
      };
      setReady(true); animation = requestAnimationFrame(frame);
    }).catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; cancelAnimationFrame(animation); overlay?.setMap(null); markers.forEach(m => m.setMap(null)); line.current?.setMap(null); if (map.current) google.maps.event.clearInstanceListeners(map.current); map.current = null; setReady(false); };
  }, [partner, retry]);

  useEffect(() => {
    if (!ready || !map.current) return;
    line.current?.setPath(trip.route?.path ?? []);
    if (!follow.current || !trip.location) {
      const bounds = new google.maps.LatLngBounds();
      for (const p of [...(trip.route?.path ?? []), trip.pickup, trip.drop, trip.location]) if (p) bounds.extend(p);
      if (!bounds.isEmpty()) map.current.fitBounds(bounds, C.mapFitPadding);
    }
    // Fit when the route/stops change. Live fixes move the marker without resetting a manually panned map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, trip.route?.computedAt, trip.route?.path, trip.pickup?.lat, trip.pickup?.lng, trip.drop?.lat, trip.drop?.lng, trip.locationVisible]);

  return <div className={s.mapWrap}>
    <div ref={container} className={s.mapCanvas} aria-label="In-app delivery map" />
    {error ? <div className={s.mapMessage}><p>{error}</p><button onClick={() => setRetry(n => n + 1)}>Retry map</button></div>
      : !ready ? <div className={s.mapMessage}>Loading the street map…</div> : null}
    {ready && <button className={s.recenter} onClick={() => {
      follow.current = !following; setFollowing(!following);
      if (trip.location) { map.current?.panTo(trip.location); map.current?.setZoom(partner ? C.partnerZoom : C.observerFollowZoom); }
    }}>{following ? "Following location" : "Recenter"}</button>}
  </div>;
}
