"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleUser, Map as MapIcon, MapPin, Receipt, Truck } from "lucide-react";
import type { Session } from "@/lib/luna/auth";
import PhotoCanvas, { keepDraftPhoto } from "./PhotoCanvas";
import DonorShell from "./DonorShell";
import { DonationRow, useDonations } from "./DonationList";
import s from "./donor.module.css";
import { Updates } from "@/components/agents/live-bits";

export default function DonorHome({ session, fields }: { session: Session; fields: Record<string, string> }) {
  const router = useRouter(), [error, setError] = useState("");
  const { rows } = useDonations(session);
  const active = rows?.filter(l => !l.deliveredAt && l.state !== "not_for_people" && l.state !== "unplaced" && !(l.state === "tags_held" && l.replacedBy)) ?? [];
  const recent = rows?.filter(l => !active.includes(l)).slice(0, 2) ?? [];

  return (
    <DonorShell title={fields.org || fields.name || "Donor"}
      right={<Link href="/profile" className={s.iconButton} aria-label="Your profile and pickup addresses"><CircleUser size={22} aria-hidden /></Link>}>
      <div className={s.home}>
        <section className={s.homeShoot} aria-label="List food">
          <PhotoCanvas photo="" onPhoto={p => { keepDraftPhoto(p); router.push("/listings/new"); }} onError={setError} tall />
          {error && <p className={s.barError} role="alert">{error}</p>}
        </section>

        <aside className={s.homeSide}>
          <Updates />
          <section className={s.group} aria-label="Donations in progress">
            <h2>In progress</h2>
            {rows === null ? <p className={s.note}>Loading…</p>
              : active.length ? active.slice(0, 3).map(l => <DonationRow key={l.id} l={l} />)
              : <p className={s.note}>Nothing on the way right now. Food you list shows here while Luna checks it, finds an NGO and books a pickup.</p>}
          </section>
          {recent.length > 0 && <section className={s.group}><h2>Recent</h2>{recent.map(l => <DonationRow key={l.id} l={l} />)}</section>}
          <nav className={s.links} aria-label="More">
            <Link href="/listings"><Receipt size={18} aria-hidden /><span><b>All donations</b>Receipts and where your food went</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/deliveries"><Truck size={18} aria-hidden /><span><b>Track deliveries</b>Live route and arrival time</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/profile"><MapPin size={18} aria-hidden /><span><b>Pickup addresses</b>Your saved places and profile</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/map"><MapIcon size={18} aria-hidden /><span><b>Where food is short</b>The food map for {fields.area || "your area"}</span><ArrowRight size={16} aria-hidden /></Link>
          </nav>
          {fields.sample === "true" && <p className={s.note}>Fictional walkthrough account · <Link href="/demo" target="_blank">open the other accounts</Link></p>}
        </aside>
      </div>

    </DonorShell>
  );
}
