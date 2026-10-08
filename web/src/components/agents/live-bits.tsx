"use client";

import { useEffect, useId, useState } from "react";
import { Bell, ChevronDown, Images, Maximize2, Minimize2, Phone } from "lucide-react";
import { fmtTime, myUpdates, sharePhoto, sharePhotoList } from "@/lib/luna/agents";
import { useNow, usePoll } from "@/lib/luna/usePoll";
import s from "./live-bits.module.css";

/**
 * The food photos for a share (one per food); anyone in its delivery (restaurant, NGO, partner) can see them.
 * The box shows the first; tapping it opens an album right there that scrolls down through every photo,
 * each named, and stays inside the offer so the Accept bar is never pushed out of reach.
 */
export function SharePhoto({ shareId, alt, tall = false }: { shareId: string; alt: string; tall?: boolean }) {
  const [photos, setPhotos] = useState<{ dish: string; src: string | null }[] | null>(null);
  const [open, setOpen] = useState(false);
  const albumId = useId();
  useEffect(() => {
    const urls: string[] = [];
    let live = true;
    (async () => {
      const list = await sharePhotoList(shareId).catch(() => [{ i: 0, dish: "" }]);
      const loaded = await Promise.all(list.map(async (p) => {
        const src = await sharePhoto(shareId, p.i).catch(() => null);
        if (src) urls.push(src);
        return { dish: p.dish, src };
      }));
      if (live) setPhotos(loaded.filter((p) => p.src));
    })();
    return () => { live = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
  }, [shareId]);
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (!photos?.length) return <div className={s.photo} data-tall={tall} data-empty aria-hidden />;
  const many = photos.length > 1;
  const name = (p: { dish: string }, i: number) => p.dish || (many ? `Photo ${i + 1}` : alt);
  if (open) return (
    <section className={s.album} id={albumId} aria-label={`${photos.length} food photo${many ? "s" : ""}`}>
      <header className={s.albumBar}>
        <span>{many ? `${photos.length} photos · scroll for all` : "Photo"}</span>
        <button type="button" onClick={() => setOpen(false)} aria-controls={albumId}><Minimize2 size={16} aria-hidden /> Close</button>
      </header>
      <ol className={s.albumList}>
        {photos.map((p, i) => (
          <li key={i}>
            <figure>
              {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL from an authorised fetch */}
              <img src={p.src!} alt={`Photo of ${name(p, i)}`} />
              <figcaption><b>{i + 1}/{photos.length}</b> {name(p, i)}</figcaption>
            </figure>
          </li>
        ))}
      </ol>
    </section>
  );
  return (
    <button type="button" className={s.photoBox} data-tall={tall} data-many={many || undefined} onClick={() => setOpen(true)}
      aria-expanded={false} aria-label={many ? `See all ${photos.length} food photos` : `Enlarge the photo of ${name(photos[0], 0)}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a blob URL from an authorised fetch */}
      <img className={s.photo} data-tall={tall} src={photos[0].src!} alt="" />
      <span className={s.photoChip} aria-hidden>{many ? <><Images size={14} /> 1 of {photos.length} · see all</> : <><Maximize2 size={14} /> Enlarge</>}</span>
    </button>
  );
}

/**
 * What Luna's agents last told this person, printed as a slip at the top of their home: the newest update
 * in full, earlier ones folded underneath. Refreshes the instant an agent sends something.
 */
export function Updates() {
  const { data } = usePoll(myUpdates, 30_000);
  const [seen, setSeen] = useState<string | null>(null);
  const now = useNow(30_000);
  if (!data?.length) return null;
  const [latest, ...rest] = data;
  const fresh = now - latest.at < 10 * 60_000;
  return (
    <section className={s.updates} data-fresh={fresh && seen !== latest.id} aria-live="polite" aria-label="Updates from Luna">
      <p className={s.latest}>
        <Bell size={16} aria-hidden /><span className={s.when}>{fmtTime(latest.at)}</span>
        <span>{latest.text}</span>
      </p>
      {rest.length > 0 && (
        <details className={s.more} onToggle={() => setSeen(latest.id)}>
          <summary>Earlier updates <span>{rest.length}</span><ChevronDown size={14} aria-hidden /></summary>
          <ol>{rest.slice(0, 8).map((u) => <li key={u.id}><span className={s.when}>{fmtTime(u.at)}</span>{u.text}</li>)}</ol>
        </details>
      )}
    </section>
  );
}

/**
 * Nobody has taken the pickup yet: the time left before it moves to another NGO (or the pickup window closes),
 * as a countdown and a bar that fills and turns from yellow to red as it runs out. Restaurant and NGO see it.
 */
export function WaitClock({ clock, who }: { clock: { from: number; to: number; then: "next_ngo" | "window_closes" | "released" }; who: "donor" | "ngo" }) {
  const now = useNow(1000);
  const span = Math.max(1, clock.to - clock.from);
  const t = Math.min(1, Math.max(0, (now - clock.from) / span));
  const left = Math.max(0, Math.ceil((clock.to - now) / 1000));
  const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, "0");
  // Under an hour it ticks in seconds; longer waits read as hours and minutes.
  const shown = left >= 3600 ? `${Math.floor(left / 3600)} h ${Math.floor((left % 3600) / 60)} min` : `${mm}:${ss}`;
  const then = clock.then === "next_ngo"
    ? (who === "ngo" ? "Then Luna passes it to another NGO that has a partner free." : "Then Luna offers it to another NGO that has a partner free.")
    : clock.then === "released"
      ? (who === "ngo" ? "An NGO holds accepted food 30 minutes at most. Then your hold ends; no other NGO can take this one." : "An NGO holds food 30 minutes at most. No other NGO can take it, so then you can send it to biogas.")
      : "Then the pickup window closes.";
  return (
    <section className={s.wait} style={{ "--t": t.toFixed(3) } as React.CSSProperties} data-urgent={t > 0.8 || undefined} aria-label="Waiting for a delivery partner">
      <div className={s.waitHead}>
        <b>No partner has taken it yet</b>
        <span className={s.waitLeft} role="timer" aria-label={`${mm} minutes ${ss} seconds left`}>{shown}</span>
      </div>
      <i className={s.waitBar} aria-hidden><i /></i>
      <p className={s.waitThen}>{then}</p>
    </section>
  );
}

/** The NGO's own volunteers with a call link each, online ones first, for when nobody has taken a pickup. */
export function VolunteerCalls({ volunteers }: { volunteers: { name: string; phone: string; online: boolean; busy: boolean }[] }) {
  if (!volunteers.length) return <p className={s.callsNone}>None of your volunteers is on Luna yet. Volunteers who pick your NGO when they sign up show here with their number.</p>;
  return (
    <section className={s.calls} aria-label="Call your volunteers">
      <p className={s.callsTitle}>Call your volunteers</p>
      <ul>
        {volunteers.map((v) => (
          <li key={v.phone}>
            <span><b>{v.name}</b><em>{v.busy ? "On a trip" : v.online ? "Online" : "Offline"}</em></span>
            <a href={`tel:+91${v.phone}`} aria-label={`Call ${v.name}, ${v.phone}`}><Phone size={16} aria-hidden /> {v.phone.slice(0, 5)} {v.phone.slice(5)}</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
