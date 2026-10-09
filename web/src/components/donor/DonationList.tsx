"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { Camera } from "lucide-react";
import { api } from "@/lib/luna/api";
import type { Session } from "@/lib/luna/auth";
import type { ListingView } from "@/lib/luna/listing";
import { tripTime } from "@/lib/luna/trip";
import { justWentCold, nowLine, servingsOf, stagesOf, wentCold } from "./stages";
import s from "./donor.module.css";

export function useDonations(session: Session) {
  const [rows, setRows] = useState<ListingView[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try { const d = await api<{ listings: ListingView[] }>("/listings", { token: session.token }); if (!cancelled) { setRows(d.listings); setError(""); } }
      catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void refresh(); const timer = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [session.token]);
  return { rows, error };
}

/** A donation as a row: photo, dish, servings, the four stage ticks and what's happening now. */
export function DonationRow({ l }: { l: ListingView }) {
  const stages = stagesOf(l, null), cold = wentCold(l);
  return (
    <Link className={s.donation} href={`/listings/${l.id}`} data-cold={cold || undefined}>
      <span className={s.thumb}>{l.photo && <Image src={l.photo} alt="" fill sizes="64px" unoptimized />}</span>
      <span className={s.donationText}>
        <b>{l.dish}</b>
        <span>{servingsOf(l)} servings · {tripTime(l.createdAt)}{l.foodCheck ? ` · Grade ${l.foodCheck.grade}` : ""}</span>
        <span className={s.now} data-tone={cold ? "cold" : l.state === "not_for_people" || l.state === "tags_held" ? "bad" : l.deliveredAt ? "done" : "live"}>{nowLine(l, null)}</span>
      </span>
      {cold
        ? <span className={s.rowStamp} data-fresh={justWentCold(l) || undefined}>{l.agentCase?.lapsed?.cause === "in_transit" ? <>Stopped<br />unsafe</> : <>No one<br />responded</>}</span>
        : <span className={s.ticks} aria-hidden>{stages.map(st => <i key={st.key} data-state={st.state} />)}</span>}
    </Link>
  );
}

export default function DonationList({ session }: { session: Session }) {
  const { rows, error } = useDonations(session);
  const active = rows?.filter(l => !l.deliveredAt && l.state !== "not_for_people" && !wentCold(l) && l.agentCase?.status !== "closed" && !(l.state === "tags_held" && l.replacedBy)) ?? [];
  const past = rows?.filter(l => !active.includes(l)) ?? [];
  return (
    <>
      {!rows && <p className={s.loading}>{error || "Loading your donations…"}</p>}
      {rows && !rows.length && (
        <div className={s.empty}>
          <h2>No donations yet</h2>
          <p>Photograph surplus food and Luna checks it, finds an NGO and books a pickup.</p>
        </div>
      )}
      {active.length > 0 && <section className={s.group}><h2>In progress</h2>{active.map(l => <DonationRow key={l.id} l={l} />)}</section>}
      {past.length > 0 && <section className={s.group}><h2>Finished</h2>{past.map(l => <DonationRow key={l.id} l={l} />)}</section>}
      <div className={s.actionBar} data-solo>
        <div className={s.barRow}><Link className={s.primary} href="/listings/new"><Camera size={18} aria-hidden /> List food</Link></div>
      </div>
    </>
  );
}
