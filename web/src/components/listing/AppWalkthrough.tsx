"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/luna/api";
import { setWalkthroughAccount, type Profile, type Session } from "@/lib/luna/auth";
import type { Role } from "@/lib/luna/roles";
import s from "./listing.module.css";

interface Scenario { id: string; sessions: Record<Role, Session>; profiles: Record<Role, Profile>; volunteers: { session: Session; profile: Profile }[]; ngos: { session: Session; profile: Profile }[] }
const key = "luna.appWalkthrough";
const actors = [{ role: "donor", title: "Restaurant", job: "Ravi posts the food and watches the pickup." }, { role: "admin", title: "Luna reviewer", job: "Asha approves the restaurant's first listing." }, { role: "ngo", title: "NGO", job: "Meera accepts the food offer and receives the delivery." }, { role: "volunteer", title: "Delivery partner", job: "Arjun accepts the pickup, checks the food and delivers it." }] as const;

export default function AppWalkthrough() {
  const router = useRouter(), params = useSearchParams();
  const [scenario, setScenario] = useState<Scenario | null>(null), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      try {
        // Restore the API's seeded actors so the user can inspect the same listing we walked through.
        const stored = await api<Scenario>("/app-demo/current").catch(() => null);
        if (cancelled) return;
        if (stored) {
          localStorage.setItem(key, JSON.stringify(stored));
          setScenario(stored);
          const role = params.get("as");
          if (role && role in stored.sessions) {
            const value = role as Role, actor = value === "volunteer" ? stored.volunteers[Number(params.get("person") ?? 0)] : value === "ngo" ? stored.ngos[Number(params.get("person") ?? 0)] : null;
            setWalkthroughAccount(actor?.session ?? stored.sessions[value], actor?.profile ?? stored.profiles[value]);
            router.replace(`/${value}`); return;
          }
        }
      } catch { setError("Could not restore the walkthrough. Create fresh accounts below."); }
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, [params, router]);
  const create = async () => {
    setBusy(true); setError("");
    try {
      const value = await api<Scenario>("/app-demo/start", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
      localStorage.setItem(key, JSON.stringify(value)); setScenario(value);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <main className={s.shell}>
    <header className={s.bar}><strong>LUNA</strong><span>App walkthrough · fictional accounts</span></header>
    <div className={s.paper}>
      <span className={s.eyebrow}>One listing. The complete journey.</span>
      <h1>Start at the restaurant.</h1>
      <p>These are separate accounts in the app. Create them, open each account in its own tab, and post a listing from the restaurant’s home. No food or delivery is created for you.</p>
      {!ready ? <p>Preparing the app…</p> : !scenario ? <button disabled={busy} onClick={() => void create()}>{busy ? "Creating accounts…" : "Create walkthrough accounts"}</button> : busy ? <p>Creating fresh accounts…</p> : <>
        <div className={s.actorGrid}>{actors.map(actor => <article className={s.actor} key={actor.role}>
          <span className={s.eyebrow}>{actor.title}</span><h2>{scenario.profiles[actor.role].fields.org || scenario.profiles[actor.role].fields.name}</h2>
          <p>{scenario.profiles[actor.role].fields.name} · {scenario.profiles[actor.role].fields.area}</p><p>{actor.job}</p>
          <a className={s.primaryLink} href={`/demo?as=${actor.role}`} target="_blank" rel="noopener">Open {actor.title.toLowerCase()} app →</a>
        </article>)}</div>
        <h2>Every eligible NGO volunteer receives the pickup</h2><p>Arjun, Kavya and Nikhil are affiliated with Udaya and online. Open their apps before the NGO accepts. All three receive a notification automatically; the first acceptance wins.</p>
        <div className={s.actions}>{scenario.volunteers.map((v, i) => <a key={v.session.phone} className={s.primaryLink} href={`/demo?as=volunteer&person=${i}`} target="_blank" rel="noopener">Open {v.profile.fields.name.split(" ")[0]}’s app →</a>)}</div>
        <h2>If the NGO does not reply</h2><p>The offer starts a server-enforced 2–10 minute countdown. If Udaya does not accept before it ends, the same food is offered to Seva Neighborhood Kitchen next. The volunteers also help Seva.</p>
        <a className={s.primaryLink} href="/demo?as=ngo&person=1" target="_blank" rel="noopener">Open the next NGO app →</a>
        <p>Restaurant → List food → Review and submit → Luna review → NGO offer → Accept → Live map and automatic volunteer notifications → First volunteer accepts → Food check → NGO handover → Delivery receipt.</p>
        <button className={s.outline} disabled={busy} onClick={() => void create()}>Create a fresh set of accounts</button>
      </>}
      {error && <p role="alert" className={s.alert}>{error}</p>}
      <p className={s.note}>The restaurant and NGO names, registrations and people are fictional. Agent decisions use a local sample for a vegetarian biryani meal; the app forms, accounts, listing, offer, reviews and delivery transitions are real records. Only the ride needs simulated GPS.</p>
    </div>
  </main>;
}
