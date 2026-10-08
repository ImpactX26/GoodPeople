"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Clock, LogOut, Map as MapIcon, Phone, Truck, X } from "lucide-react";
import { formatPhone, getProfile, signOut, updateProfile, type Session } from "@/lib/luna/auth";
import { answerTrip, claimPickup, enterCode, fmtTime, linked, myTrips, openPickups, runningLate, sendLocation, setOnline, type LinkedPartner, type OpenPickup, type Trip } from "@/lib/luna/agents";
import { listNgos, type Ngo } from "@/lib/luna/ngoAgent";
import { usePoll } from "@/lib/luna/usePoll";
import { stamp } from "@/components/ticket/Ticket";
import DonorShell from "@/components/donor/DonorShell";
import HomeActivity from "@/components/listing/HomeActivity";
import { SharePhoto, Updates } from "@/components/agents/live-bits";
import LiveDelivery from "@/components/trip/LiveDelivery";
import d from "@/components/donor/donor.module.css";
import n from "@/components/ngo/ngo.module.css";
import s from "./partner.module.css";


function position(): Promise<{ lat: number; lng: number } | undefined> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(undefined);
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }), () => resolve(undefined), { timeout: 4000, maximumAge: 60_000 });
  });
}

function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

/**
 * The delivery partner's home, as today's shift card: the one thing to act on prints first (a pickup
 * request, or the trip in progress, one step at a time); availability and the rest of the day sit below.
 */
export default function PartnerHome({ session, fields: f }: { session: Session; fields: Record<string, string> }) {
  const router = useRouter();
  const link = usePoll(() => linked(), 10_000);
  const trips = usePoll(myTrips, 6_000);
  const open = usePoll(openPickups, 8_000);
  const now = useClock(1000);
  const me = link.data?.partners ?? [];
  const ids = new Set(me.map((p) => p.id));
  const online = me.some((p) => p.online);
  const all = trips.data ?? [];
  const asks = all.filter((t) => t.status === "finding_partner" && t.askedPartnerId && ids.has(t.askedPartnerId) && (t.askDeadlineAt ?? 0) > now);
  const live = all.filter((t) => (t.status === "assigned" || t.status === "picked_up") && t.partnerId && ids.has(t.partnerId));
  const done = all.filter((t) => t.status === "delivered" && t.partnerId && ids.has(t.partnerId));
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState("");

  // A new request turns the tab title and buzzes once, so a rider glancing at the phone notices.
  const seen = useRef(0);
  useEffect(() => {
    document.title = asks.length ? `(${asks.length}) Pickup request · Luna` : live.length ? "On a trip · Luna" : "Luna · Partner";
    if (asks.length > seen.current && navigator.userActivation?.hasBeenActive) try { navigator.vibrate?.([120, 60, 120]); } catch { /* not supported */ }
    seen.current = asks.length;
  }, [asks.length, live.length]);
  useEffect(() => () => { document.title = "Luna"; }, []);

  const toggle = async (v: boolean) => {
    setBusy(true); setProblem("");
    try { const r = await setOnline(v, v ? await position() : undefined); if (!r.ok) throw new Error(r.error); await link.reload(); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  const notRegistered = link.data && me.length === 0;

  return (
    <DonorShell title={f.name || "Delivery partner"}
      right={<span className={s.barState} data-on={online}>{online ? "Online" : "Offline"}</span>}>
      <div className={n.home}>
        <div className={n.work}>
          <Updates />
          {live.map((t) => <TripSlip key={t.id} trip={t} onDone={trips.reload} />)}

          {live.length === 0 && (asks.length > 0 || !open.data?.length) && (
            <section className={n.section} aria-labelledby="ask-title" aria-live="polite">
              <h2 id="ask-title" className={n.heading}>Pickup requests {asks.length > 0 && <span className={n.count}>{asks.length}</span>}</h2>
              {asks.map((t) => <Ask key={t.id} trip={t} now={now} onDone={trips.reload} />)}
              {asks.length === 0 && (open.data?.length ?? 0) === 0 && (
                notRegistered ? (
                  <div className={n.quiet} data-call><p className={n.print}>Setting up your partner account…</p><p>This takes a moment the first time. If it stays, sign out and in again.</p></div>
                ) : online ? (
                  <div className={n.quiet}><p className={n.print}>You’re online</p><p>Pickup requests near you appear here with a big Accept button, the NGO you ride for first. Keep this page open.</p></div>
                ) : (
                  <div className={n.quiet} data-call>
                    <p className={n.print}>You’re offline</p>
                    <p>Go online to get pickup requests near you.</p>
                    <button type="button" className={n.accept} disabled={busy || !me.length} onClick={() => void toggle(true)}><Truck size={20} aria-hidden /> Go online</button>
                  </div>
                )
              )}
            </section>
          )}

          {live.length === 0 && (open.data?.length ?? 0) > 0 && (
            <section className={n.section} aria-labelledby="open-title" aria-live="polite">
              <h2 id="open-title" className={n.heading}>Open pickups <span className={n.count}>{open.data!.length}</span></h2>
              <p className={d.note}>An NGO said yes, but no partner has taken these yet. First to tap gets it, even if you missed the request.</p>
              {open.data!.map((t) => <OpenTicket key={t.id} trip={t} now={now} onDone={() => { void trips.reload(); void open.reload(); }} />)}
            </section>
          )}
          {trips.error && <p className={d.barError} role="alert">{trips.error}</p>}
        </div>

        <aside className={n.day} aria-label="Today">
          <section className={n.card} aria-labelledby="avail-title">
            <h2 id="avail-title" className={n.heading}>Right now I am</h2>
            <div className={s.punches2} role="radiogroup" aria-labelledby="avail-title">
              {[true, false].map((v) => (
                <label key={String(v)} className={n.punch} data-on={online === v} data-disabled={busy || !me.length || (!v && live.length > 0)}>
                  <input type="radio" name="online" checked={online === v} disabled={busy || !me.length || (!v && live.length > 0)} onChange={() => void toggle(v)} />
                  <b>{v ? "Online" : "Offline"}</b><span>{v ? "Send me pickups" : "No pickups for now"}</span>
                </label>
              ))}
            </div>
            {live.length > 0 && <p className={d.note}>Finish your trip before going offline.</p>}
            {problem && <p className={d.barError} role="alert">{problem}</p>}
            <RideFor session={session} me={me[0]} onSaved={() => void link.reload()} />
          </section>

          {me[0]?.reliability && (
            <section className={n.card} aria-labelledby="rel-title">
              <h2 id="rel-title" className={n.heading}>Your reliability</h2>
              <p className={s.relScore}>{me[0].reliability.score !== null && me[0].reliability.trips > 0 ? <><b>{me[0].reliability.score.toFixed(1)}</b><span>/ 5</span></> : <b>New</b>}</p>
              <p className={d.note}>{me[0].reliability.line}. On-time trips raise it; a late trip lowers it as it happens, less if you tap “Running late” early.</p>
            </section>
          )}

          <section className={n.card} aria-labelledby="done-title">
            <h2 id="done-title" className={n.heading}>Delivered {done.length > 0 && <span className={n.count}>{done.length}</span>}</h2>
            {done.length === 0 ? <p className={d.note}>Each delivery you finish shows here.</p> : (
              <ul className={n.received}>
                {done.slice(0, 5).map((t) => <li key={t.id} className={s.doneRow}><Check size={16} strokeWidth={3} aria-hidden /><span><b>{t.keepReady}</b> to {t.drop?.name ?? "the NGO"}</span></li>)}
              </ul>
            )}
          </section>

          <nav className={d.links} aria-label="More">
            <Link href="/deliveries"><Truck size={18} aria-hidden /><span><b>Track deliveries</b>Live route and handover progress</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/map"><MapIcon size={18} aria-hidden /><span><b>Where food is short</b>The food map for {f.area || "your area"}</span><ArrowRight size={16} aria-hidden /></Link>
          </nav>

          <details className={n.details}>
            <summary>Walkthrough pickups and alerts <ChevronDown size={16} aria-hidden /></summary>
            <div className={s.legacy}><HomeActivity session={session} /></div>
          </details>

          <details className={n.details}>
            <summary>Your details <ChevronDown size={16} aria-hidden /></summary>
            <dl className={d.leaders}>
              {f.name && <div><dt>Name</dt><dd>{f.name}</dd></div>}
              {f.area && <div><dt>Area</dt><dd>{f.area}</dd></div>}
              {f.travel && <div><dt>Travel</dt><dd>{f.travel}</dd></div>}
              <div><dt>Mobile</dt><dd>{formatPhone(session.phone)}</dd></div>
              <div><dt>Signed in</dt><dd>{stamp(new Date(session.signedInAt))}</dd></div>
            </dl>
          </details>

          {f.sample === "true" && <p className={d.note}>Fictional walkthrough account · <Link href="/demo" target="_blank">open the other accounts</Link></p>}
          <button type="button" className={d.ghost} data-wide onClick={() => { signOut(); router.replace("/login"); }}><LogOut size={18} aria-hidden /> Sign out</button>
        </aside>
      </div>
    </DonorShell>
  );
}

/** A pickup request: the food, where from and to, the countdown, Accept or pass. */
function Ask({ trip: t, now, onDone }: { trip: Trip; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [done, setDone] = useState("");
  const left = Math.max(0, Math.ceil(((t.askDeadlineAt ?? now) - now) / 1000));
  const answer = async (accept: boolean) => {
    setBusy(true); setProblem("");
    try { const r = await answerTrip(t.id, accept); if (!r.ok) throw new Error(r.error); setDone(accept ? "Accepted" : "Passed on"); setTimeout(onDone, 650); }
    catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  return (
    <article className={n.offer} aria-label={`Pickup request: ${t.keepReady}`}>
      {done && <span className={n.stampBig} aria-hidden>{done}</span>}
      {t.hasPhoto && <SharePhoto shareId={t.id} alt={`Photo of ${t.keepReady}`} />}
      <header className={n.offerHead}>
        <div><h3>{t.keepReady}</h3>{t.servings ? <p>{t.servings} servings to deliver</p> : null}</div>
        <span className={n.timer} data-low={left < 60} role="timer" aria-label={`${Math.floor(left / 60)} minutes ${left % 60} seconds left to accept`}>
          <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</b><span>left to accept</span>
        </span>
      </header>
      {t.travel && (
        <p className={s.travel}>
          <span><b>{t.travel.toPickupMin} min</b> to the restaurant</span>
          {t.travel.toDropMin !== null && <span><b>{t.travel.toDropMin} min</b> on to the NGO</span>}
        </p>
      )}
      <dl className={s.places}>
        <div><dt>Collect from</dt><dd>{t.pickup.name}</dd></div>
        <div><dt>Drop at</dt><dd>{t.drop?.name ?? "an NGO"}</dd></div>
      </dl>
      {t.containers.length > 0 && <p className={s.bring}><b>Bring</b>{t.containers.join(" + ")}</p>}
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      <div className={n.answer}>
        <button type="button" className={n.accept} disabled={busy || !!done} onClick={() => void answer(true)}><Check size={22} strokeWidth={3} aria-hidden /> {busy ? "Accepting…" : "Accept pickup"}</button>
        <button type="button" className={n.pass} disabled={busy || !!done} onClick={() => void answer(false)}><X size={18} aria-hidden /> Can’t</button>
      </div>
    </article>
  );
}

/**
 * An open pickup: accepted by an NGO, taken by nobody. No countdown to beat, just how long it has been waiting,
 * a mark if you missed the request, and one bar to take it.
 */
function OpenTicket({ trip: t, now, onDone }: { trip: OpenPickup; now: number; onDone: () => void }) {
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [done, setDone] = useState(false);
  const waited = Math.max(1, Math.round((now - t.waitingSince) / 60_000));
  const take = async () => {
    setBusy(true); setProblem("");
    try { const r = await claimPickup(t.id); if (!r.ok) throw new Error(r.error); setDone(true); setTimeout(onDone, 650); }
    catch (e) { setProblem((e as Error).message); setBusy(false); onDone(); }
  };
  return (
    <article className={n.offer} data-dim={t.reach.unsafe || undefined} aria-label={`Open pickup: ${t.keepReady}`}>
      {done && <span className={n.stampBig} aria-hidden>Yours</span>}
      {t.hasPhoto && <SharePhoto shareId={t.id} alt={`Photo of ${t.keepReady}`} />}
      <header className={n.offerHead}>
        <div><h3>{t.keepReady}</h3>{t.servings ? <p>{t.servings} servings to deliver</p> : null}</div>
        <span className={s.waited}><b>{waited} min</b><span>waiting</span></span>
      </header>
      {t.missed && <p className={s.missed}><Clock size={16} aria-hidden /> You missed this request. It’s still open{t.reach.unsafe ? "" : ", so you can take it now"}.</p>}
      {t.reach.unsafe ? (
        <p className={s.reachNote} data-tone="no">From where you are, the food would stop being safe before it reaches {t.drop?.name ?? "the NGO"}. A partner closer to {t.pickup.name} needs to take this one.</p>
      ) : t.reach.late && (
        <p className={s.reachNote}>You’d reach {t.pickup.name} about <b>{fmtTime(t.reach.pickupAt)}</b>, after their collect-by time ({fmtTime(t.reach.collectBy)}). Call them before you set off.</p>
      )}
      {t.travel && (
        <p className={s.travel}>
          <span><b>{t.travel.toPickupMin} min</b> to the restaurant</span>
          {t.travel.toDropMin !== null && <span><b>{t.travel.toDropMin} min</b> on to the NGO</span>}
        </p>
      )}
      <dl className={s.places}>
        <div><dt>Collect from</dt><dd>{t.pickup.name}</dd></div>
        <div><dt>Drop at</dt><dd>{t.drop?.name ?? "an NGO"}</dd></div>
      </dl>
      {t.containers.length > 0 && <p className={s.bring}><b>Bring</b>{t.containers.join(" + ")}</p>}
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      {t.reach.unsafe
        ? <button type="button" className={s.cantTake} disabled>Too far to deliver it safely</button>
        : <button type="button" className={n.accept} disabled={busy || done} onClick={() => void take()}><Truck size={20} aria-hidden /> {busy ? "Taking it…" : "Take this pickup"}</button>}
    </article>
  );
}

/** The trip, one step at a time: go to the restaurant and enter its code, then go to the NGO and enter theirs. */
function TripSlip({ trip: t, onDone }: { trip: Trip; onDone: () => void }) {
  const atPickup = t.status === "assigned";
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [lateMsg, setLateMsg] = useState(""), [stamped, setStamped] = useState("");
  const lastSent = useRef(0);

  // Share the phone's position while on a trip, every few seconds, so the live map moves smoothly for the
  // partner, the NGO and the restaurant. Speed and heading let the map glide between fixes.
  useEffect(() => {
    if (!("geolocation" in navigator)) return;
    const id = navigator.geolocation.watchPosition((p) => {
      if (Date.now() - lastSent.current < 4_000) return;
      lastSent.current = Date.now();
      const { latitude: lat, longitude: lng, accuracy, speed, heading } = p.coords;
      void sendLocation(t.id, { lat, lng, accuracyM: accuracy, speedMps: speed, heading: heading !== null && !Number.isNaN(heading) ? heading : null }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 3_000 });
    return () => navigator.geolocation.clearWatch(id);
  }, [t.id]);

  const submit = async () => {
    setBusy(true); setProblem("");
    try {
      const r = await enterCode(t.id, atPickup ? "pickup" : "drop", code);
      if (!r.ok) throw new Error(r.error);
      setStamped(atPickup ? "Collected" : "Delivered");
      setTimeout(() => { setCode(""); setStamped(""); setBusy(false); onDone(); }, 900);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  const late = async () => {
    try { const r = await runningLate(t.id); setLateMsg(r.ok ? r.message ?? "Thanks, we've told them." : r.error); } catch (e) { setLateMsg((e as Error).message); }
  };

  return (
    <section className={s.slip} aria-labelledby={`slip-${t.id}`}>
      {stamped && <span className={n.stampBig} role="status">{stamped}</span>}
      <ol className={s.steps} aria-label="Trip steps">
        <li data-state={atPickup ? "now" : "done"}><span>{atPickup ? "1" : <Check size={14} strokeWidth={3} aria-hidden />}</span>Collect</li>
        <li data-state={atPickup ? "next" : "now"}><span>2</span>Drop</li>
      </ol>
      {(t.lateMin ?? 0) > 5 && <p className={s.lateBanner} role="status">About {t.lateMin} min behind. The NGO and the restaurant have been told.</p>}
      {t.hasPhoto && atPickup && <SharePhoto shareId={t.id} alt={`Photo of ${t.keepReady}`} />}
      <h2 id={`slip-${t.id}`} className={s.slipTitle}>{atPickup ? `Collect from ${t.pickup.name}` : `Drop at ${t.drop?.name ?? "the NGO"}`}</h2>
      <p className={s.slipFood}>{t.keepReady}</p>
      <dl className={s.places}>
        {atPickup && t.pickupDetails?.address && <div><dt>Address</dt><dd>{t.pickupDetails.address}</dd></div>}
        {atPickup && t.pickupDetails?.notes && <div><dt>Note</dt><dd>{t.pickupDetails.notes}</dd></div>}

        {!atPickup && t.eta && <div><dt>Arrive about</dt><dd>{fmtTime(t.eta)}</dd></div>}
      </dl>
      {atPickup && t.containers.length > 0 && <p className={s.bring}><b>Bring</b>{t.containers.join(" + ")}</p>}
      <LiveDelivery shareId={t.id} viewer="partner" />
      <div className={s.slipActions}>
        {atPickup && t.pickupDetails?.contact && <a className={n.pass} href={`tel:+91${t.pickupDetails.contact}`} aria-label={`Call ${t.pickup.name} on ${t.pickupDetails.contact}`}><Phone size={18} aria-hidden /> Call {t.pickup.name} · {t.pickupDetails.contact.slice(0, 5)} {t.pickupDetails.contact.slice(5)}</a>}
      </div>
      <label className={s.codeField}>
        <span>{atPickup ? `Ask ${t.pickup.name} for the pickup code` : `Ask ${t.drop?.name ?? "the NGO"} for the drop code`}</span>
        <input inputMode="numeric" autoComplete="one-time-code" value={code} maxLength={4} placeholder="····"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} aria-label={atPickup ? "Pickup code" : "Drop code"} />
      </label>
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      <button type="button" className={`${n.accept} ${s.stepAction}`} aria-busy={busy || undefined} disabled={busy || code.length !== 4} onClick={() => void submit()}>
        {code.length !== 4 && !busy ? "Enter the 4-digit code first" : <><Check size={22} strokeWidth={3} aria-hidden /> {busy ? "Checking…" : atPickup ? "Food collected" : "Food handed over"}</>}
      </button>
      <button type="button" className={s.late} onClick={() => void late()}><Clock size={16} aria-hidden /> Running late</button>
      {lateMsg && <p className={d.note} role="status">{lateMsg}</p>}
    </section>
  );
}

/** Which NGO this partner rides for: its pickups come to them first. */
function RideFor({ session, me, onSaved }: { session: Session; me?: LinkedPartner; onSaved: () => void }) {
  const ngoId = me?.ngoId;
  const [ngos, setNgos] = useState<Ngo[] | null>(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState("");
  useEffect(() => { listNgos().then(setNgos, () => setNgos([])); }, []);
  const save = async (value: string, helps = me?.helpsOthers === true) => {
    setBusy(true); setMsg("");
    try {
      const fields = getProfile(session.role, session.phone)?.fields ?? {};
      await updateProfile(session, { ...fields, affiliatedNgo: value, helpsOthers: helps ? "yes" : "no" });
      await linked(true); onSaved();
      setMsg(value ? "Saved. That NGO’s pickups come to you first." : "Saved. You get pickups from any NGO near you.");
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <label className={d.field}><span>I ride for</span>
      <select className={d.select} value={ngoId?.replace(/^NGO-/, "") ?? ""} disabled={busy || !ngos} onChange={(e) => void save(e.target.value)}>
        <option value="">No NGO: I help anyone nearby</option>
        {(ngos ?? []).map((g) => <option key={g.ngo_id} value={g.ngo_id.replace(/^NGO-/, "")}>{g.name}</option>)}
      </select>
      {ngoId && (
        <span className={s.helps}>
          <input type="checkbox" checked={me?.helpsOthers === true} disabled={busy} onChange={(e) => void save(ngoId.replace(/^NGO-/, ""), e.target.checked)} />
          <span>Also deliver for other NGOs when they need help</span>
        </span>
      )}
      {msg && <small role="status">{msg}</small>}
    </label>
  );
}
