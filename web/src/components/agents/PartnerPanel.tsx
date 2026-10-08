"use client";

import { useEffect, useRef, useState } from "react";
import { getSession, getProfile, updateProfile } from "@/lib/luna/auth";
import { listNgos, type Ngo } from "@/lib/luna/ngoAgent";
import { Heading, Leader } from "@/components/ticket/Ticket";
import { answerTrip, enterCode, fmtTime, linked, myTrips, runningLate, sendLocation, setOnline, type Trip } from "@/lib/luna/agents";
import { usePoll } from "@/lib/luna/usePoll";
import s from "./agents.module.css";
import { CodeEntry, Countdown, Reply, STATUS, Stamp, useAction } from "./ui";

const directions = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;

function position(): Promise<{ lat: number; lng: number } | undefined> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(undefined);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(undefined),
      { timeout: 4000, maximumAge: 60_000 },
    );
  });
}

export default function PartnerPanel() {
  const link = usePoll(linked, 10000);
  const trips = usePoll(myTrips, 4000);
  const toggle = useAction(link.reload);
  const me = link.data?.partners ?? [];
  const ids = new Set(me.map((p) => p.id));
  const online = me.some((p) => p.online);

  if (link.data && me.length === 0) {
    return (
      <>
        <Heading>Pickups</Heading>
        <p className={s.note}>This number isn&rsquo;t registered as a delivery partner yet. Ask the Luna team to link it (admin: Link people).</p>
      </>
    );
  }

  const all = trips.data ?? [];
  const asks = all.filter((t) => t.status === "finding_partner" && t.askedPartnerId && ids.has(t.askedPartnerId));
  const live = all.filter((t) => (t.status === "assigned" || t.status === "picked_up") && t.partnerId && ids.has(t.partnerId));
  const done = all.filter((t) => t.status === "delivered" && t.partnerId && ids.has(t.partnerId)).slice(0, 3);

  return (
    <>
      <Heading>Pickups{me[0] ? ` · ${me[0].name}` : ""}</Heading>
      <div className={s.choices} role="group" aria-label="Availability">
        {[true, false].map((v) => (
          <button
            key={String(v)}
            type="button"
            className={s.choice}
            data-on={online === v}
            aria-pressed={online === v}
            disabled={toggle.busy}
            onClick={() => toggle.run(async () => setOnline(v, v ? await position() : undefined))}
          >
            {v ? "Online" : "Offline"}
          </button>
        ))}
      </div>
      <p className={s.note}>{online ? "You'll get pickup requests near you." : "Go online to get pickup requests."}</p>
      <RideFor ngoId={me[0]?.ngoId} onSaved={() => link.reload()} />
      <Reply msg={toggle.msg} />
      {trips.error && <p className={s.error}>{trips.error}</p>}

      {asks.map((t) => (
        <Ask key={t.id} trip={t} onDone={trips.reload} />
      ))}
      {live.map((t) => (
        <LiveTrip key={t.id} trip={t} onDone={trips.reload} />
      ))}
      {done.length > 0 && <Heading>Done</Heading>}
      {done.map((t) => (
        <Leader key={t.id} label={`${t.keepReady} → ${t.drop?.name ?? ""}`} value="Delivered" />
      ))}
    </>
  );
}

/** Which NGO this partner rides for: its offers come to them first (spec §12.5.1, tier 1). */
function RideFor({ ngoId, onSaved }: { ngoId?: string; onSaved: () => void }) {
  const [ngos, setNgos] = useState<Ngo[] | null>(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { listNgos().then(setNgos, () => setNgos([])); }, []);
  const save = async (value: string) => {
    const session = getSession(); if (!session) return;
    setBusy(true); setMsg(null);
    try {
      const fields = getProfile(session.role, session.phone)?.fields ?? {};
      await updateProfile(session, { ...fields, affiliatedNgo: value });
      await linked(true);
      onSaved();
      setMsg({ ok: true, text: value ? "Saved. That NGO's pickups come to you first." : "Saved. You get pickups from any NGO near you." });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const current = ngoId?.replace(/^NGO-/, "") ?? "";
  return (
    <label className={s.note} style={{ display: "grid", gap: 6, marginTop: 12 }}>
      <span>You ride for</span>
      <select value={current} disabled={busy || !ngos} onChange={(e) => void save(e.target.value)} style={{ minHeight: 48, padding: "0 10px", font: "inherit", border: "1.5px solid var(--ink)", background: "#fff" }}>
        <option value="">No NGO: I help anyone nearby</option>
        {(ngos ?? []).map((n) => <option key={n.ngo_id} value={n.ngo_id.replace(/^NGO-/, "")}>{n.name}</option>)}
      </select>
      <Reply msg={msg} />
    </label>
  );
}

function Ask({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const action = useAction(onDone);
  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>Pickup request</h3>
        <Stamp tone="urgent">
          <Countdown until={trip.askDeadlineAt ?? 0} />
        </Stamp>
      </div>
      <Leader label="Collect" value={trip.keepReady} />
      <Leader label="From" value={trip.pickup.name} />
      <Leader label="Drop at" value={trip.drop?.name ?? "—"} />
      {trip.containers.length > 0 && <Leader label="Bring" value={trip.containers.join(", ")} />}
      <div className={s.buttons}>
        <button type="button" className={s.primary} disabled={action.busy} onClick={() => action.run(() => answerTrip(trip.id, true))}>
          Accept
        </button>
        <button type="button" className={s.outline} disabled={action.busy} onClick={() => action.run(() => answerTrip(trip.id, false))}>
          Can&rsquo;t
        </button>
      </div>
      <Reply msg={action.msg} />
    </article>
  );
}

/** The trip on its way: codes, directions, delays, and the phone's location for the map. */
function LiveTrip({ trip, onDone }: { trip: Trip; onDone: () => void }) {
  const action = useAction(onDone);
  const lastSent = useRef(0);
  const atPickup = trip.status === "assigned";
  const target = atPickup ? trip.pickup : trip.drop;

  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        if (Date.now() - lastSent.current < 30_000) return;
        lastSent.current = Date.now();
        void sendLocation(trip.id, { lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: p.coords.accuracy, speedMps: p.coords.speed }).catch(() => {});
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [trip.id]);

  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{atPickup ? `Pick up at ${trip.pickup.name}` : `Drop at ${trip.drop?.name}`}</h3>
        <Stamp>{STATUS[trip.status]}</Stamp>
      </div>
      <Leader label="Collect" value={trip.keepReady} />
      {atPickup && trip.pickupDetails && (
        <>
          <Leader label="Address" value={trip.pickupDetails.address} />
          {trip.pickupDetails.notes && <Leader label="Note" value={trip.pickupDetails.notes} />}
          {trip.pickupDetails.contact && (
            <Leader
              label="Contact"
              value={
                <a className={s.link} href={`tel:+91${trip.pickupDetails.contact}`}>
                  {trip.pickupDetails.contact}
                </a>
              }
            />
          )}
          {trip.containers.length > 0 && <Leader label="Bring" value={trip.containers.join(", ")} />}
        </>
      )}
      {trip.eta && !atPickup && <Leader label="Arrive about" value={fmtTime(trip.eta)} />}
      {target && (
        <a className={s.outline} href={directions(target.lat, target.lng)} target="_blank" rel="noreferrer">
          Directions
        </a>
      )}
      {atPickup ? (
        <CodeEntry label="Pickup code from the restaurant" busy={action.busy} onSubmit={(c) => action.run(() => enterCode(trip.id, "pickup", c))} />
      ) : (
        <CodeEntry label={`Drop code from ${trip.drop?.name ?? "the NGO"}`} busy={action.busy} onSubmit={(c) => action.run(() => enterCode(trip.id, "drop", c))} />
      )}
      <button type="button" className={s.small} disabled={action.busy} onClick={() => action.run(() => runningLate(trip.id))}>
        Running late
      </button>
      <Reply msg={action.msg} />
    </article>
  );
}
