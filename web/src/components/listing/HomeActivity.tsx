"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/luna/api";
import type { Session } from "@/lib/luna/auth";
import type { ListingView } from "@/lib/luna/listing";
import { TRIP_STATUS, type TripView } from "@/lib/luna/trip";
import { usePickupNotifications } from "@/components/trip/PartnerNotifications";
import s from "../../app/[role]/home.module.css";

export default function HomeActivity({ session }: { session: Session }) {
  return session.role === "volunteer" ? <PartnerActivity /> : <OtherActivity session={session} />;
}
function OtherActivity({ session }: { session: Session }) {
  const [rows, setRows] = useState<{ id: string; title: string; line: string; href: string }[]>([]), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const data = await api<{ listings?: ListingView[]; offers?: ListingView[]; trips?: TripView[] }>(session.role === "donor" ? "/listings" : session.role === "ngo" ? "/offers" : "/trips", { token: session.token });
        if (cancelled) return;
        setRows(data.trips ? data.trips.filter(t => !t.closedAt).slice(0, 3).map(t => ({ id: t.id, title: t.food, line: t.requestStatus === "pending" ? "New pickup request" : TRIP_STATUS[t.status], href: `/deliveries?id=${t.id}` })) : (data.listings ?? data.offers ?? []).slice(0, 3).map(l => ({ id: l.id, title: l.dish, line: session.role === "ngo" ? `${l.assessment?.servings} servings · ${l.donorName}` : l.progress, href: session.role === "ngo" ? "/offers" : `/listings/${l.id}` })));
        setError("");
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void refresh(); const timer = setInterval(refresh, 2000); return () => { cancelled = true; clearInterval(timer); };
  }, [session.role, session.token]);
  return <>
    {rows.map(row => <Link className={s.mapLink} href={row.href} key={row.id}><span><span className={s.mapLinkTitle}>{row.title}</span><span className={s.mapLinkLine}>{row.line}</span></span><span aria-hidden>→</span></Link>)}
    {session.role === "donor" && <Link className={s.mapLink} href="/listings"><span className={s.mapLinkLine}>All listings and donation receipts →</span></Link>}
    {error && <p className={s.footer}>{error}</p>}
  </>;
}
function PartnerActivity() {
  const { requests, notice, connected } = usePickupNotifications(), [alerts, setAlerts] = useState("");
  return <>
    <p className={s.footer}>{connected ? "Pickup notifications connected" : "Connecting pickup notifications…"}</p>
    {notice && <p role="alert" className={s.notification}>{notice}</p>}
    {requests.map(t => <Link className={s.mapLink} href={`/deliveries?id=${t.id}`} key={t.id}><span><span className={s.mapLinkTitle}>New pickup request</span><span className={s.mapLinkLine}>{t.food} · {t.servings} servings · {t.pickupArea} → {t.dropArea}</span></span><span>→</span></Link>)}
    <button className={s.signOut} onClick={async () => {
      if (typeof Notification === "undefined") { setAlerts("This browser does not support desktop alerts. In-app notifications are active."); return; }
      const permission = await Notification.requestPermission(); setAlerts(permission === "granted" ? "Desktop alerts enabled. In-app notifications are always active." : "In-app notifications are active.");
    }}>Enable desktop pickup alerts</button>{alerts && <p className={s.footer}>{alerts}</p>}
  </>;
}
