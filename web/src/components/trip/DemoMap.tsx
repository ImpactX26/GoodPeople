"use client";

import { useEffect, useRef, useState } from "react";
import { Map as StreetMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { bearing, smoothPosition, predict, project, TRIP_CONFIG as C, type LatLng } from "@/lib/luna/trip";
import type { MapTrip } from "./TripMap";
import s from "./trip.module.css";

setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");
export default function DemoMap({ trip, partner }: { trip: MapTrip; partner: boolean }) {
  const element = useRef<HTMLDivElement>(null), map = useRef<StreetMap | null>(null), latest = useRef(trip);
  const follow = useRef(partner), stops = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false), [following, setFollowing] = useState(partner), [error, setError] = useState("");
  useEffect(() => { latest.current = trip; }, [trip]);
  useEffect(() => {
    if (!element.current) return;
    const initial = latest.current, center = initial.pickup ?? initial.drop ?? { lat: 12.9352, lng: 77.6245 };
    const instance = new StreetMap({ container: element.current, center: [center.lng, center.lat], zoom: partner ? C.partnerZoom : C.observerZoom,
      style: { version: 8, sources: { streets: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>' } },
        layers: [{ id: "streets", type: "raster", source: "streets", paint: { "raster-saturation": -.75 } }] } });
    map.current = instance; instance.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    instance.on("dragstart", () => { follow.current = false; setFollowing(false); });
    instance.on("error", e => { if (e.error.message.includes("WebGL")) setError("This device could not open the map. Try a browser with WebGL enabled."); });
    instance.on("load", () => {
      instance.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      instance.addLayer({ id: "route-outline", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#fbfaf6", "line-width": 10 } });
      instance.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#d52a22", "line-width": 6 } });
      setReady(true);
    });
    const markerRoot = document.createElement("div"); markerRoot.style.cssText = "width:34px;height:40px;pointer-events:none";
    const triangle = document.createElement("div"); triangle.className = s.marker; triangle.setAttribute("role", "img"); triangle.setAttribute("aria-label", partner ? "Your location" : "Delivery partner location"); markerRoot.appendChild(triangle);
    const marker = new Marker({ element: markerRoot, anchor: "center" }).setLngLat([center.lng, center.lat]).addTo(instance);
    let animation = 0, previousAt = performance.now(), lastCameraAt = 0, rendered: LatLng | null = null, heading = 0;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const frame = (at: number) => {
      const t = latest.current, p = t.location;
      markerRoot.hidden = !p || !t.locationVisible || !!t.closedAt;
      if (p && t.locationVisible && !t.closedAt) {
        const target = predict(p, t.route?.preview ? [] : t.route?.path ?? [], Date.now());
        const amount = reduced ? 1 : Math.min(1, (at - previousAt) / C.animationMs * C.animationEase);
        rendered = rendered ? smoothPosition(rendered, target, t.route?.preview ? [] : t.route?.path ?? [], amount) : target;
        const nearest = t.route && t.route.path.length > 1 ? project(p, t.route.path) : null;
        const routeHeading = nearest && t.route ? bearing(t.route.path[nearest.index], t.route.path[nearest.index + 1]) : heading;
        const nextHeading = p.heading ?? (Number.isFinite(routeHeading) ? routeHeading : heading);
        heading += ((nextHeading - heading + 540) % 360 - 180) * amount;
        triangle.style.transform = `rotate(${heading}deg)`; triangle.dataset.stale = String(Date.now() - p.at > C.staleMs);
        marker.setLngLat([rendered.lng, rendered.lat]);
        if (follow.current && at - lastCameraAt > C.cameraUpdateMs) { instance.jumpTo({ center: [rendered.lng, rendered.lat] }); lastCameraAt = at; }
      }
      previousAt = at; animation = requestAnimationFrame(frame);
    };
    animation = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(animation); marker.remove(); stops.current.forEach(m => m.remove()); stops.current = []; instance.remove(); map.current = null; };
  }, [partner]);
  useEffect(() => {
    const instance = map.current; if (!instance || !ready) return;
    stops.current.forEach(m => m.remove()); stops.current = [];
    for (const [stop, label] of [[trip.pickup, "P"], [trip.drop, "D"]] as const) if (stop) {
      const pin = document.createElement("div"); pin.className = s.stopPin; pin.textContent = label; pin.setAttribute("aria-label", `${label === "P" ? "Pickup" : "Drop"}: ${stop.name}`);
      stops.current.push(new Marker({ element: pin }).setLngLat([stop.lng, stop.lat]).addTo(instance));
    }
    // Google route content must never be displayed on an OpenStreetMap basemap.
    const path = trip.route?.provider === "osrm-demo" ? trip.route.path : [];
    (instance.getSource("route") as GeoJSONSource).setData({ type: "FeatureCollection", features: path.length > 1 ? [{ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: path.map(p => [p.lng, p.lat]) } }] : [] });
    if (!follow.current) {
      const points = [...path, trip.pickup, trip.drop].filter((p): p is LatLng => !!p);
      if (points.length) instance.fitBounds([[Math.min(...points.map(p => p.lng)), Math.min(...points.map(p => p.lat))], [Math.max(...points.map(p => p.lng)), Math.max(...points.map(p => p.lat))]], { padding: C.mapFitPadding, duration: 600, maxZoom: C.partnerZoom });
    }
  }, [ready, trip.route, trip.pickup, trip.drop]);
  return <div className={s.mapWrap}>
    <div ref={element} className={s.mapCanvas} aria-label="In-app demo street map" />
    {!ready && <div className={s.mapMessage}>{error || "Loading Bengaluru streets…"}</div>}
    <span className={s.mapBadge}>{trip.route?.preview ? "Pickup → NGO · route preview" : trip.sample ? "Simulated partner · road route" : "Approximate road route · no live traffic"}</span>
    {ready && trip.locationVisible && trip.location && <button className={s.recenter} onClick={() => {
      follow.current = !following; setFollowing(!following);
      if (trip.location) map.current?.easeTo({ center: [trip.location.lng, trip.location.lat], zoom: partner ? C.partnerZoom : C.observerFollowZoom });
    }}>{partner ? (following ? "Following you" : "Follow me") : following ? "Following partner" : "Follow partner"}</button>}
  </div>;
}
