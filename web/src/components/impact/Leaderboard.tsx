"use client";

import { useEffect, useState } from "react";
import { leaderboard, monthName, months, type Board } from "@/lib/luna/impact";
import DonorShell from "@/components/donor/DonorShell";
import s from "./impact.module.css";

/**
 * The public zero-waste leaderboard (SRS §9): each area's top restaurants this month by meals that reached
 * people. Names and numbers only. Anyone can open it and share it.
 */
export default function Leaderboard({ back }: { back?: { label: string; href: string } }) {
  const { current, previous } = months();
  const [month, setMonth] = useState(current), [data, setData] = useState<Board | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    leaderboard(month).then((d) => live && (setData(d), setError("")), (e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [month]);
  return (
    <DonorShell title="Zero-waste leaderboard" back={back}>
      <div className={s.page}>
        <p className={s.note}>Restaurants whose surplus food reached the most people in {monthName(month)}, by area. Only food delivered to an NGO counts.</p>
        <div className={s.chips} role="radiogroup" aria-label="Month">
          {[current, previous].map((mo) => <button key={mo} type="button" role="radio" aria-checked={month === mo} className={s.chip} data-on={month === mo} onClick={() => setMonth(mo)}>{monthName(mo)}</button>)}
        </div>
        {error && <p className={s.error} role="alert">{error}</p>}
        {!data ? <p className={s.note}>Loading…</p> : data.areas.length === 0 ? (
          <div className={s.locked}><b>No deliveries yet in {monthName(month)}</b>The first restaurant whose food reaches an NGO this month tops its area.</div>
        ) : (
          <div className={s.areas}>
            {data.areas.map((a) => (
              <section key={a.areaId} className={s.board} aria-labelledby={`area-${a.areaId}`}>
                <h2 id={`area-${a.areaId}`}>Top in {a.area}</h2>
                <ol>
                  {a.top.map((r, i) => (
                    <li key={r.donor}>
                      <b>{i + 1}</b>
                      <span>{r.donor}</span>
                      <em>{r.meals} meals</em>
                    </li>
                  ))}
                </ol>
              </section>
            ))}
          </div>
        )}
      </div>
    </DonorShell>
  );
}
