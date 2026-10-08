"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Pencil } from "lucide-react";
import { categoryLabel, effectiveNgo, getNgo, listNgos, ngoIdFor, type Ngo } from "@/lib/luna/ngoAgent";
import DonorShell from "@/components/donor/DonorShell";
import NgoListingForm from "@/components/ngo/NgoListingForm";
import { Loading, useNgoAccount } from "../PortalShell";
import d from "@/components/donor/donor.module.css";
import s from "@/components/ngo/ngo.module.css";

const STATUS_WORD: Record<string, string> = { ACTIVE: "Open", AT_CAPACITY: "Full", CLOSED: "Closed", UNAVAILABLE: "Away" };

/** Every NGO listed in Luna. Your own default listing is edited in your profile; a first-time NGO lists here. */
export default function ListDashboard() {
  const account = useNgoAccount();
  const myId = account ? ngoIdFor(account.session.phone) : "";
  const [ngos, setNgos] = useState<Ngo[] | null>(null), [mine, setMine] = useState<Ngo | null | undefined>(undefined), [problem, setProblem] = useState("");

  useEffect(() => {
    if (!account) return;
    listNgos().then(setNgos, (e: Error) => { setProblem(e.message); setNgos([]); });
    getNgo(myId).then(setMine, () => setMine(null));
  }, [account, myId]);

  if (!account || mine === undefined) return <Loading />;

  return (
    <DonorShell title="NGO directory" back={{ label: "Home", href: "/ngo" }}>
      <div className={s.profile}>
        {mine ? (
          <section className={s.card} aria-labelledby="mine-title">
            <h2 id="mine-title" className={s.heading}>Your listing</h2>
            <DirectoryRow n={effectiveNgo(mine)} you />
            <Link href="/profile" className={d.primary}><Pencil size={16} aria-hidden /> Edit default listing</Link>
          </section>
        ) : (
          <NgoListingForm session={account.session} fields={account.profile?.fields ?? {}} onSaved={n => { setMine(n); listNgos().then(setNgos).catch(() => {}); }} />
        )}

        <section aria-labelledby="dir-title" className={s.section}>
          <h2 id="dir-title" className={s.heading}>Listed NGOs {ngos && <span className={s.count}>{ngos.length}</span>}</h2>
          {problem && <p className={d.barError} role="alert">{problem}</p>}
          {ngos === null ? <p className={d.note}>Loading…</p> : ngos.length === 0 ? <p className={d.note}>No NGOs listed yet. Be the first.</p> : (
            <ul className={s.directory}>
              {ngos.filter(n => n.ngo_id !== myId).map(n => <li key={n.ngo_id}><DirectoryRow n={n} /></li>)}
            </ul>
          )}
        </section>
        <Link href="/ngo" className={d.inlineAction}>Food waiting for you <ArrowRight size={16} aria-hidden /></Link>
      </div>
    </DonorShell>
  );
}

function DirectoryRow({ n, you = false }: { n: Ngo; you?: boolean }) {
  return (
    <article className={s.dirRow} aria-label={n.name}>
      <header>
        <b>{n.name}{you && " (you)"}</b>
        <span className={s.dirStatus} data-status={n.status}>{STATUS_WORD[n.status] ?? n.status}</span>
      </header>
      <p>{n.address ?? "Bengaluru"}</p>
      <dl className={d.leaders}>
        <div><dt>Needs</dt><dd>{n.current_demand.meals_needed} meals · {n.current_demand.urgency.toLowerCase()}</dd></div>
        <div><dt>Room today</dt><dd>{n.capacity.available_capacity_today} of {n.capacity.daily_meal_capacity}</dd></div>
        <div><dt>Receives</dt><dd>{n.receiving_hours.start}–{n.receiving_hours.end}</dd></div>
        <div><dt>Takes</dt><dd>{n.accepted_categories.map(categoryLabel).join(", ") || "Any food"}</dd></div>
      </dl>
    </article>
  );
}
