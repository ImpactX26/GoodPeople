"use client";

import { useEffect, useRef } from "react";
import { AttributionControl, Map as MLMap, Marker, NavigationControl, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { Area, Hex, Snapshot } from "@/lib/luna/map/data";
import s from "./map.module.css";

export type Layer = "surplus" | "need";
export type Base = "printed" | "streets";

// Copied into /public by scripts/copy-maplibre-worker.mjs on install.
setWorkerUrl("/maplibre/maplibre-gl-worker.mjs");

const MAJOR = new Set(["yelahanka", "hebbal", "whitefield", "ecity", "jayanagar", "indiranagar", "malleshwaram", "hsr"]);

const PAPER = "#fbfaf6";
const INK = "#1b1b1b";
const RED = "#d52a22";

function hexCollection(snapshot: Snapshot, layer: Layer, areas: Area[], hexes: Hex[]) {
  const byId = new Map(areas.map((a) => [a.id, a]));
  const max = Math.max(
    1,
    ...Object.values(snapshot).map((w) => (layer === "surplus" ? w.surplus : w.short)),
  );
  return {
    type: "FeatureCollection" as const,
    features: hexes.map((h) => {
      const w = snapshot[h.areaId];
      const area = byId.get(h.areaId)!;
      const v = (layer === "surplus" ? w.surplus : w.short) / max;
      return {
        type: "Feature" as const,
        id: h.id,
        properties: {
          areaId: h.areaId,
          o: 0.06 + 0.84 * Math.sqrt(v) * (0.3 + 0.7 * h.weight),
          gap: w.isGap && h.weight > 0.42,
          noNgo: area.ngos.length === 0,
        },
        geometry: { type: "Polygon" as const, coordinates: [h.ring] },
      };
    }),
  };
}

export default function HexMap({
  areas,
  hexes,
  snapshot,
  layer,
  base,
  selected,
  focus,
  onSelect,
}: {
  areas: Area[];
  hexes: Hex[];
  snapshot: Snapshot;
  layer: Layer;
  base: Base;
  selected: string | null;
  /** Area id to fly to; changes of this value move the camera. */
  focus: { id: string; n: number } | null;
  onSelect: (id: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<MLMap | null>(null);
  const ready = useRef(false);
  const pending = useRef<(() => void)[]>([]);
  /** Run now if the map's layers exist, otherwise as soon as they do. */
  /** Print labels in priority order and drop any that would overlap one already printed. */
  const placeLabels = () => {
    const { snapshot: snap, selected: sel } = latest.current;
    const rank = (id: string) => (id === sel ? 0 : snap[id]?.isGap ? 1 : MAJOR.has(id) ? 2 : 3);
    const kept: DOMRect[] = [];
    [...labels.current.entries()]
      .sort(([a], [b]) => rank(a) - rank(b))
      .forEach(([, b]) => {
        b.style.visibility = "hidden";
        const r = b.getBoundingClientRect();
        const hit = kept.some((k) => r.left < k.right + 4 && r.right > k.left - 4 && r.top < k.bottom + 2 && r.bottom > k.top - 2);
        if (!hit) {
          kept.push(r);
          b.style.visibility = "";
        }
      });
  };

  const whenReady = (fn: () => void) => {
    if (ready.current) fn();
    else pending.current.push(fn);
  };
  const labels = useRef<Map<string, HTMLButtonElement>>(new Map());
  const latest = useRef({ snapshot, layer, selected, onSelect, areas, hexes });
  useEffect(() => {
    latest.current = { snapshot, layer, selected, onSelect, areas, hexes };
  });

  // Create the map once.
  useEffect(() => {
    if (!el.current) return;
    const m = new MLMap({
      container: el.current,
      style: {
        version: 8,
        sources: {
          streets: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
            maxzoom: 19,
          },
        },
        layers: [
          { id: "paper", type: "background", paint: { "background-color": PAPER } },
          {
            id: "streets",
            type: "raster",
            source: "streets",
            layout: { visibility: "none" },
            paint: { "raster-saturation": -1, "raster-contrast": 0.05, "raster-opacity": 0.55 },
          },
        ],
      },
      bounds: [
        [77.5, 12.83],
        [77.78, 13.12],
      ],
      fitBoundsOptions: { padding: 24 },
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 15,
      minZoom: 9.5,
    });
    m.touchZoomRotate.disableRotation();
    m.addControl(new NavigationControl({ showCompass: false }), "top-right");
    m.addControl(new AttributionControl({ compact: true }), "bottom-right");

    m.on("load", () => {
      const { snapshot: snap, layer: lay, areas: ar, hexes: hx } = latest.current;
      m.addSource("hexes", { type: "geojson", data: hexCollection(snap, lay, ar, hx) });
      m.addLayer({
        id: "hex-fill",
        type: "fill",
        source: "hexes",
        paint: {
          "fill-color": ["case", ["get", "gap"], RED, INK],
          "fill-opacity": ["case", ["get", "gap"], 0.78, ["get", "o"]],
          "fill-opacity-transition": { duration: 260 },
        },
      });
      m.addLayer({
        id: "hex-grid",
        type: "line",
        source: "hexes",
        paint: { "line-color": PAPER, "line-width": 1 },
      });
      m.addLayer({
        id: "hex-no-ngo",
        type: "line",
        source: "hexes",
        filter: ["==", ["get", "noNgo"], true],
        paint: { "line-color": INK, "line-width": 1, "line-dasharray": [2, 2], "line-opacity": 0.55 },
      });
      m.addLayer({
        id: "hex-selected",
        type: "line",
        source: "hexes",
        filter: ["==", ["get", "areaId"], latest.current.selected ?? ""],
        paint: { "line-color": INK, "line-width": 2.5 },
      });

      m.on("click", "hex-fill", (e) => {
        const id = e.features?.[0]?.properties?.areaId;
        if (typeof id === "string") latest.current.onSelect(id);
      });
      m.on("mouseenter", "hex-fill", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "hex-fill", () => (m.getCanvas().style.cursor = ""));

      // Area names as printed labels (HTML, so they use the ticket's type and are real buttons).
      latest.current.areas.forEach((a) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = s.label;
        b.textContent = a.name;
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          latest.current.onSelect(a.id);
        });
        labels.current.set(a.id, b);
        new Marker({ element: b, anchor: "center" }).setLngLat([a.lng, a.lat]).addTo(m);
      });

      m.on("moveend", () => placeLabels());
      m.on("resize", () => placeLabels());

      ready.current = true;
      pending.current.splice(0).forEach((fn) => fn());
      placeLabels();
    });

    map.current = m;
    const labelEls = labels.current;
    return () => {
      ready.current = false;
      pending.current = [];
      labelEls.clear();
      m.remove();
      map.current = null;
    };
  }, []);

  // Reprint the hexes when the window or layer changes.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      (m.getSource("hexes") as GeoJSONSource | undefined)?.setData(hexCollection(snapshot, layer, areas, hexes));
      placeLabels();
    };
    whenReady(apply);
  }, [snapshot, layer, areas, hexes]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      m.setLayoutProperty("streets", "visibility", base === "streets" ? "visible" : "none");
      m.setPaintProperty("hex-grid", "line-opacity", base === "streets" ? 0 : 1);
    };
    whenReady(apply);
  }, [base]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      m.setFilter("hex-selected", ["==", ["get", "areaId"], selected ?? ""]);
      labels.current.forEach((b, id) => b.setAttribute("aria-pressed", String(id === selected)));
      placeLabels();
    };
    whenReady(apply);
  }, [selected]);

  useEffect(() => {
    const m = map.current;
    if (!m || !focus) return;
    const a = latest.current.areas.find((x) => x.id === focus.id);
    if (!a) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // On phones the details sheet covers the bottom ~55% of the screen: centre above it.
    const phone = window.matchMedia("(max-width: 860px)").matches;
    const padBottom = phone ? Math.max(0, m.getContainer().getBoundingClientRect().height - window.innerHeight * 0.4) : 0;
    m.flyTo({
      center: [a.lng, a.lat],
      zoom: Math.max(m.getZoom(), phone ? 11.8 : 12.4),
      padding: { top: 0, left: 0, right: 0, bottom: padBottom },
      duration: reduce ? 0 : 1100,
      essential: true,
    });
  }, [focus]);

  return <div ref={el} className={s.canvas} role="region" aria-label="Heat map of Bengaluru" />;
}
