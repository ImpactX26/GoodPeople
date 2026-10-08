"use client";

import { useEffect, useRef, useState } from "react";
import { AttributionControl, Map as MLMap, NavigationControl, setWorkerUrl } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Crosshair, LoaderCircle, Search } from "lucide-react";
import { BENGALURU, inPilot, reverseGeocode, searchPlaces } from "@/lib/luna/addresses";
import s from "./donor.module.css";

setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

export interface Spot { lat: number; lng: number }

/**
 * Pick the exact pickup spot: the pin stays in the middle and the map moves under it
 * (drag, search, or "Use my location"). Reports the spot and the street address under it.
 */
export default function LocationPicker({ token, value, onChange, onAddress, autoLocate = false }: {
  token: string; value: Spot | null; onChange: (spot: Spot) => void; onAddress: (address: string) => void;
  /** Ask for the device's location as soon as the map opens (the "Use my exact location" entry point). */
  autoLocate?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null), map = useRef<MLMap | null>(null);
  const latest = useRef({ onChange, onAddress, token });
  const [moving, setMoving] = useState(false), [locating, setLocating] = useState(false), [note, setNote] = useState("");
  const [q, setQ] = useState(""), [results, setResults] = useState<{ address: string; lat: number; lng: number }[]>([]);
  useEffect(() => { latest.current = { onChange, onAddress, token }; });

  useEffect(() => {
    if (!el.current) return;
    const start = value ?? BENGALURU;
    const m = new MLMap({
      container: el.current,
      style: {
        version: 8,
        sources: { streets: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap contributors" } },
        layers: [
          { id: "paper", type: "background", paint: { "background-color": "#fbfaf6" } },
          { id: "streets", type: "raster", source: "streets", paint: { "raster-saturation": -1, "raster-contrast": 0.08 } },
        ],
      },
      center: [start.lng, start.lat], zoom: value ? 17 : 11.5, minZoom: 10, maxZoom: 19,
      attributionControl: false, dragRotate: false, pitchWithRotate: false,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new AttributionControl({ compact: true }), "bottom-right");
    let lookup: ReturnType<typeof setTimeout> | undefined;
    m.on("movestart", () => setMoving(true));
    m.on("moveend", () => {
      setMoving(false);
      const c = m.getCenter(), spot = { lat: +c.lat.toFixed(6), lng: +c.lng.toFixed(6) };
      if (!inPilot(spot.lat, spot.lng)) { setNote("Luna works in Bengaluru for now. Move the pin inside the city."); return; }
      setNote(""); latest.current.onChange(spot);
      clearTimeout(lookup);
      lookup = setTimeout(() => {
        reverseGeocode(latest.current.token, spot.lat, spot.lng).then(r => latest.current.onAddress(r.address)).catch(() => {});
      }, 700);
    });
    map.current = m;
    return () => { clearTimeout(lookup); m.remove(); map.current = null; };
    // the map is created once; later value changes move it explicitly
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (q.trim().length < 3) return;
    let live = true;
    const t = setTimeout(() => {
      searchPlaces(token, q.trim()).then(r => live && setResults(r.results)).catch(() => live && setResults([]));
    }, 500);
    return () => { live = false; clearTimeout(t); };
  }, [q, token]);

  const fly = (lat: number, lng: number) => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    map.current?.flyTo({ center: [lng, lat], zoom: 17.5, duration: reduce ? 0 : 900, essential: true });
  };
  const locate = () => {
    if (!("geolocation" in navigator)) { setNote("This browser can't share its location. Move the pin yourself."); return; }
    setLocating(true); setNote("");
    navigator.geolocation.getCurrentPosition(p => {
      setLocating(false);
      const { latitude: lat, longitude: lng, accuracy } = p.coords;
      if (!inPilot(lat, lng)) { setNote("You seem to be outside Bengaluru. Move the pin to the pickup spot."); return; }
      fly(lat, lng);
      setNote(accuracy > 60 ? `Accurate to about ${Math.round(accuracy)} m. Drag the map so the pin sits on the gate.` : "");
    }, e => {
      setLocating(false);
      setNote(e.code === e.PERMISSION_DENIED ? "Location is blocked for this site. Allow it in the browser, or move the pin yourself."
        : "Couldn't get your location. Move the pin yourself.");
    }, { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 });
  };

  useEffect(() => {
    if (!autoLocate) return;
    const t = setTimeout(locate, 300);   // after the map has its first frame; cleanup cancels a double run
    return () => clearTimeout(t);
    // runs once on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLocate]);

  return (
    <div className={s.picker}>
      <div className={s.pickerSearch}>
        <Search size={16} aria-hidden />
        <input type="search" value={q} onChange={e => { setQ(e.target.value); if (e.target.value.trim().length < 3) setResults([]); }}
          placeholder="Search a street, building or area" aria-label="Search for the pickup place" />
      </div>
      {results.length > 0 && q.trim().length >= 3 && (
        <ul className={s.pickerResults}>
          {results.map(r => (
            <li key={`${r.lat},${r.lng}`}><button type="button" onClick={() => { fly(r.lat, r.lng); setResults([]); setQ(""); }}>{r.address}</button></li>
          ))}
        </ul>
      )}
      <div className={s.pickerMap}>
        <div ref={el} className={s.pickerCanvas} role="application" aria-label="Map: drag to put the pin on the pickup spot" />
        <span className={s.pin} data-moving={moving} aria-hidden><i /></span>
        <button type="button" className={s.locate} onClick={locate} disabled={locating}>
          {locating ? <LoaderCircle size={16} className={s.spin} aria-hidden /> : <Crosshair size={16} aria-hidden />}
          {locating ? "Finding you…" : "Use my location"}
        </button>
      </div>
      <p className={s.pickerNote} role="status">{note || "Drag the map so the pin sits exactly where the partner should come."}</p>
    </div>
  );
}
