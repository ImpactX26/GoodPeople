"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Award, FileText, ShoppingBag, Trophy } from "lucide-react";
import type { Session } from "@/lib/luna/auth";
import { monthName, months, myImpact, type MyImpact } from "@/lib/luna/impact";
import DonorShell from "@/components/donor/DonorShell";
import PartnerBadge from "./PartnerBadge";
import s from "./impact.module.css";

/**
 * A restaurant's impact (SRS §9): what its donations did this month and all time, counted from deliveries,
 * with the Luna Partner badge, its place in the area, and the certificate, report and leaderboard.
 */
export default function ImpactHome({ session }: { session: Session }) {
  const { current, previous } = months();
  const [month, setMonth] = useState(current), [data, setData] = useState<MyImpact | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    myImpact(month).then((d) => live && (setData(d), setError("")), (e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [month, session.token]);

  const m = data?.monthly, all = data?.allTime;
  return (
    <DonorShell title="Your impact" back={{ label: "Home", href: "/donor" }}>
      <div className={s.page}>
        <div className={s.chips} role="radiogroup" aria-label="Month">
          {[current, previous].map((mo) => (
            <button key={mo} type="button" role="radio" aria-checked={month === mo} className={s.chip} data-on={month === mo} onClick={() => setMonth(mo)}>{monthName(mo)}</button>
          ))}
        </div>
        {error && <p className={s.error} role="alert">{error}</p>}
        {!data ? <p className={s.note}>Counting your donations…</p> : (
          <div className={s.split}>
            <div className={s.page}>
              <section className={s.hero} aria-label={`${m!.meals} meals donated in ${monthName(month)}`}>
                <b>{m!.meals}</b>
                <span>meals reached people in {monthName(month)}</span>
                <p>{m!.meals
                  ? `${m!.deliveries} ${m!.deliveries === 1 ? "delivery" : "deliveries"} to ${m!.ngos} ${m!.ngos === 1 ? "NGO" : "NGOs"}, each confirmed with a drop code at handover.`
                  : "Counted when food reaches an NGO and the drop code is entered. Listed food doesn't count until it's delivered."}</p>
              </section>
              <section className={s.paper} aria-labelledby="numbers-title">
                <h2 id="numbers-title">{monthName(month)} in numbers</h2>
                <dl className={s.lines}>
                  <div><dt>Donations listed</dt><dd>{m!.donations}</dd></div>
                  <div><dt>Meals delivered</dt><dd>{m!.meals}</dd></div>
                  <div><dt>NGOs reached</dt><dd>{m!.ngos}</dd></div>
                  <div><dt>Sent to biogas</dt><dd>{m!.biogasServings} <small>servings</small></dd></div>
                  <div><dt>Food saved</dt><dd>~{m!.kgSaved} kg <small>est.</small></dd></div>
                  <div><dt>CO₂e avoided</dt><dd>~{m!.co2eKg} kg <small>est.</small></dd></div>
                </dl>
                <p className={s.note}>All time: {all!.meals} meals delivered, ~{all!.kgSaved} kg of food saved. Estimates use {Math.round(data.method.kgPerServing * 1000)} g a meal and {data.method.co2ePerKg} kg CO₂e per kg of food not wasted (FAO 2013).</p>
                {data.rank && <p className={s.note}><b>#{data.rank.position} in {data.rank.area}</b> this month by meals delivered, of {data.rank.of} {data.rank.of === 1 ? "restaurant" : "restaurants"} donating there.</p>}
              </section>
              <nav className={s.links} aria-label="Your recognition">
                <Link href={`/impact/certificate?month=${month}`}><Award size={20} aria-hidden /><span><b>Impact certificate</b>{monthName(month)}, ready to print and frame at the counter</span><ArrowRight size={16} aria-hidden /></Link>
                <Link href="/impact/report"><FileText size={20} aria-hidden /><span><b>CSR / ESG report</b>Verified numbers and your donation log, for company reports</span><ArrowRight size={16} aria-hidden /></Link>
                <Link href="/leaderboard"><Trophy size={20} aria-hidden /><span><b>Zero-waste leaderboard</b>The top restaurants in each area this month</span><ArrowRight size={16} aria-hidden /></Link>
                <Link href="/bags/mine"><ShoppingBag size={20} aria-hidden /><span><b>Surprise bags</b>Sell some end-of-day food at a discount</span><ArrowRight size={16} aria-hidden /></Link>
              </nav>
            </div>
            {data.partnerSince
              ? <PartnerBadge name={data.name} since={data.partnerSince} meals={all!.meals} />
              : (
                <section className={s.badgeCard} aria-labelledby="badge-title">
                  <h2 id="badge-title">Luna Partner badge</h2>
                  <div className={s.locked}><b>Not earned yet</b>Your badge for the shop window and your Zomato or Swiggy page comes with your first donation that reaches an NGO.</div>
                </section>
              )}
          </div>
        )}
      </div>
    </DonorShell>
  );
}
