"use client";

import { useEffect, useRef, useState } from "react";
import { Printer } from "lucide-react";
import type { Session } from "@/lib/luna/auth";
import { monthName, months, myImpact, type MyImpact } from "@/lib/luna/impact";
import DonorShell from "@/components/donor/DonorShell";
import { printOnly } from "./print";
import s from "./impact.module.css";

/** The monthly impact certificate (SRS §9): "Cafe Mocha donated 620 meals in October", framed at the counter. */
export default function Certificate({ session, month: asked }: { session: Session; month?: string }) {
  const month = asked ?? months().current;
  const [data, setData] = useState<MyImpact | null>(null), [error, setError] = useState("");
  const paper = useRef<HTMLElement>(null);
  useEffect(() => {
    let live = true;
    myImpact(month).then((d) => live && setData(d), (e) => live && setError((e as Error).message));
    return () => { live = false; };
  }, [month, session.token]);
  const m = data?.monthly;
  const no = data ? `LUNA-${month.replace("-", "")}-${session.phone.slice(-4)}` : "";
  return (
    <DonorShell title="Impact certificate" back={{ label: "Your impact", href: "/impact" }}>
      <div className={s.page}>
        {error && <p className={s.error} role="alert">{error}</p>}
        {!data ? <p className={s.note}>Preparing your certificate…</p> : (
          <>
            <article className={s.certificate} ref={paper} aria-label={`Impact certificate, ${monthName(month)}`}>
              <h1>Certificate of food shared</h1>
              <p className={s.note}>This is to thank</p>
              <p className={s.certName}>{data.name}</p>
              <div className={s.certMeals}><b>{m!.meals}</b><span>meals donated · {monthName(month)}</span></div>
              <p className={s.certText}>
                {m!.meals
                  ? <>Surplus food from {data.name} reached {m!.ngos} {m!.ngos === 1 ? "NGO" : "NGOs"} in {data.area ?? "Bengaluru"} through Luna, in {m!.deliveries} {m!.deliveries === 1 ? "delivery" : "deliveries"}, each confirmed at handover. About {m!.kgSaved} kg of food was kept from going to waste.</>
                  : <>No donation reached an NGO in {monthName(month)} yet. Every meal delivered through Luna is counted here.</>}
              </p>
              {m!.meals > 0 && <span className={s.certStamp} aria-hidden>Verified by Luna</span>}
              <footer className={s.certFoot}>
                <span>No. {no}</span>
                <span>Luna · surplus food to people who need it · Bengaluru</span>
                <span>kg is an estimate</span>
              </footer>
            </article>
            <button type="button" className={s.printButton} onClick={() => printOnly(paper.current)}><Printer size={18} aria-hidden /> Print certificate</button>
          </>
        )}
      </div>
    </DonorShell>
  );
}
