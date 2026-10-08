"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { formatPhone, getProfile, signOut, type Session } from "@/lib/luna/auth";
import { stamp } from "@/components/ticket/Ticket";
import DonorShell from "@/components/donor/DonorShell";
import NgoListingForm from "./NgoListingForm";
import d from "@/components/donor/donor.module.css";
import s from "./ngo.module.css";

/** NGO profile: the default listing first (what Luna uses every day), then the account details. */
export default function NgoProfile({ session }: { session: Session }) {
  const router = useRouter(), f = getProfile(session.role, session.phone)?.fields ?? {};
  useEffect(() => { document.title = "Your profile · Luna"; }, []);
  return (
    <DonorShell title="Your profile" back={{ label: "Home", href: "/ngo" }}>
      <div className={s.profile}>
        <NgoListingForm session={session} fields={f} />
        <section className={s.card} aria-labelledby="details-title">
          <h2 id="details-title" className={s.heading}>Your details</h2>
          <dl className={d.leaders}>
            {f.name && <div><dt>Contact</dt><dd>{f.name}</dd></div>}
            {f.org && <div><dt>Org</dt><dd>{f.org}</dd></div>}
            {f.kind && <div><dt>Type</dt><dd>{f.kind}</dd></div>}
            {f.area && <div><dt>Area</dt><dd>{f.area}</dd></div>}
            <div><dt>Mobile</dt><dd>{formatPhone(session.phone)}</dd></div>
            <div><dt>Signed in</dt><dd>{stamp(new Date(session.signedInAt))}</dd></div>
          </dl>
        </section>
        <button type="button" className={d.ghost} data-wide onClick={() => { signOut(); router.replace("/login"); }}><LogOut size={18} aria-hidden /> Sign out</button>
      </div>
    </DonorShell>
  );
}
