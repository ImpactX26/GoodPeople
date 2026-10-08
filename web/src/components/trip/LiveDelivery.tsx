"use client";

import dynamic from "next/dynamic";
import { Navigation } from "lucide-react";
import { project } from "@/lib/luna/trip";
import { useShareLive, type LiveTrack } from "@/lib/luna/useShareLive";
import { useEffect, useState } from "react";
import s from "./trip.module.css";

const TripMap = dynamic(() => import("./TripMap"), { ssr: false, loading: () => <div className={s.mapWait}>Loading the map…</div> });

const metres = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });

/** The next turn: the first step that starts ahead of where the partner is on the route. */
function nextTurn(t: LiveTrack) {
  const route = t.route, at = t.location;
  if (!route || !at || route.path.length < 2 || !route.steps.length) return null;
  const progress = project(at, route.path).progressM;
  let start = 0;
  for (const step of route.steps) {
    if (start > progress + 5) return { instruction: step.instruction, inM: start - progress };
    start += step.distanceM;
  }
  return { instruction: `Arrive at ${route.target === "pickup" ? t.pickup.name : t.drop?.name ?? "the NGO"}`, inM: Math.max(0, start - progress) };
}

/**
 * A delivery on the map, inside Luna (spec §12.7). The partner sees their own position, the road to the next
 * stop and the next turn; the restaurant and the NGO watch the partner come. Position glides between GPS fixes
 * along the road (lib/luna/trip predict), so it moves like a ride-hailing app, not in jumps.
 */
export default function LiveDelivery({ shareId, viewer }: { shareId: string; viewer: "partner" | "observer" }) {
  const { track, error } = useShareLive(shareId);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (error) return <p className={s.liveNote}>{error}</p>;
  if (!track) return <div className={s.live} data-size={viewer === "partner" ? "nav" : "compact"}><div className={s.mapWait}>Connecting to the delivery…</div></div>;

  const toPickup = track.status === "to_pickup";
  const dest = toPickup ? track.pickup : track.drop;
  const mins = track.eta ? Math.max(1, Math.round((track.eta - now) / 60_000)) : null;
  const turn = viewer === "partner" ? nextTurn(track) : null;
  const stale = track.location ? now - track.location.at > 60_000 : false;

  return (
    <section className={s.live} data-size={viewer === "partner" ? "nav" : "compact"} aria-label="Live delivery map">
      {viewer === "partner" ? (
        <div className={s.navBar}>
          <Navigation size={22} aria-hidden />
          <div>
            <b>{turn ? `In ${metres(turn.inM)}` : toPickup ? "Head to the pickup" : "Head to the NGO"}</b>
            <span>{turn?.instruction ?? (track.routeError || `${dest?.name ?? ""}`)}</span>
          </div>
        </div>
      ) : (
        <div className={s.watchBar}>
          <b>{track.partnerName ?? "Delivery partner"}</b>
          <span>
            {!track.locationVisible
              ? track.status === "to_drop"
                ? `Picked up. On the way to ${track.drop?.name ?? "the NGO"}; live location stopped 10 min after pickup.`
                : "Live location shows once the partner is on the way."
              : !track.location
                ? "Waiting for the partner's location."
                : `${toPickup ? "Coming to collect" : `Taking the food to ${track.drop?.name ?? "the NGO"}`}${mins ? `, about ${mins} min away` : ""}${stale ? " · last seen a minute ago" : ""}.`}
          </span>
        </div>
      )}
      <TripMap trip={track} partner={viewer === "partner"} />
      {(mins || track.distanceM) && track.locationVisible ? (
        <p className={s.liveFoot}>
          {toPickup ? "Pickup" : "Drop"} at {dest?.name}
          <span>{[mins ? `${mins} min · ${clock(track.eta!)}` : "", track.distanceM ? metres(track.distanceM) : ""].filter(Boolean).join(" · ")}</span>
        </p>
      ) : null}
    </section>
  );
}
