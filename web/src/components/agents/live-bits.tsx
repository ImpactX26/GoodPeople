"use client";

import { useEffect, useState } from "react";
import { Bell, ChevronDown } from "lucide-react";
import { fmtTime, myUpdates, sharePhoto } from "@/lib/luna/agents";
import { useNow, usePoll } from "@/lib/luna/usePoll";
import s from "./live-bits.module.css";

/** The food photo for a share; anyone in its delivery (restaurant, NGO, partner) can see it. */
export function SharePhoto({ shareId, alt, tall = false }: { shareId: string; alt: string; tall?: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null, live = true;
    sharePhoto(shareId).then((u) => { url = u; if (live) setSrc(u); }, () => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [shareId]);
  if (!src) return <div className={s.photo} data-tall={tall} data-empty aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element -- a blob URL from an authorised fetch
  return <img className={s.photo} data-tall={tall} src={src} alt={alt} />;
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
