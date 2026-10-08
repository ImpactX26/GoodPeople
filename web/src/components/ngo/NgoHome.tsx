"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, Building2, CalendarClock, Check, ChevronDown, CircleUser, Inbox, LogOut, Map as MapIcon, Truck, X } from "lucide-react";
import { api } from "@/lib/luna/api";
import { useLive } from "@/lib/luna/live";
import { formatPhone, signOut, type Session } from "@/lib/luna/auth";
import type { ListingView } from "@/lib/luna/listing";
import { ROLE_META } from "@/lib/luna/roles";
import { stamp } from "@/components/ticket/Ticket";
import { effectiveNgo, getNgo, ngoIdFor, setNgoStatus, type Ngo, type NgoStatus } from "@/lib/luna/ngoAgent";
import { answerOffer, answerRedirect, assignByHand, enterCode, fmtTime, ngoShares, sendFeedback, track, type NgoShare, type Track } from "@/lib/luna/agents";
import DonorShell from "@/components/donor/DonorShell";
import { Reasoning } from "@/components/donor/DonationTicket";
import TodaySheet from "./TodaySheet";
import { SharePhoto, Updates } from "@/components/agents/live-bits";
import { GRADE_LABEL, modelName, servingsOf } from "@/components/donor/stages";
import d from "@/components/donor/donor.module.css";
import LiveDelivery from "@/components/trip/LiveDelivery";
import s from "./ngo.module.css";

const STATUSES: { value: NgoStatus; label: string; line: string }[] = [
  { value: "ACTIVE", label: "Open for food", line: "Luna sends you offers" },
  { value: "AT_CAPACITY", label: "Full today", line: "No offers until you reopen" },
  { value: "CLOSED", label: "Closed", line: "No offers until you reopen" },
];
const DAY = { from: 6, to: 24 };

/** Ticks every `ms` so countdowns and the NOW line move without reading the clock during render. */
function useClock(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const hoursOf = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) + (m || 0) / 60; };
const hourName = (h: number) => `${h % 12 || 12} ${h < 12 || h === 24 ? "am" : "pm"}`;
const timeName = (hhmm: string) => {
  const h = hoursOf(hhmm), m = Math.round((h % 1) * 60);
  return m ? `${Math.floor(h) % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}` : hourName(Math.floor(h));
};

interface Data {
  ngo: Ngo | null | undefined;              // undefined while loading
  shares: NgoShare[] | null;
  luna: { l: ListingView; deadline: number }[] | null;
  agentError: string;
  lunaError: string;
}

/**
 * Polls what the NGO needs: its listing (Food Agent service), the Logistics Agent's offers and deliveries
 * for it, and the Luna API's walkthrough offers.
 */
function useNgoData(session: Session) {
  const ngoId = ngoIdFor(session.phone);
  const [data, setData] = useState<Data>({ ngo: undefined, shares: null, luna: null, agentError: "", lunaError: "" });
  const reload = useCallback(async () => {
    const [ngo, shares, luna] = await Promise.allSettled([
      getNgo(ngoId),
      ngoShares(),
      api<{ offers: ListingView[] }>("/offers", { token: session.token }),
    ]);
    const received = Date.now();
    setData(cur => ({
      ngo: ngo.status === "fulfilled" ? ngo.value : cur.ngo === undefined ? null : cur.ngo,
      shares: shares.status === "fulfilled" ? shares.value : cur.shares,
      luna: luna.status === "fulfilled" ? luna.value.offers.map(l => ({ l, deadline: received + (l.offerDeadline ?? l.serverNow) - l.serverNow })) : cur.luna,
      agentError: shares.status === "rejected" ? "Can’t reach Luna right now. This page keeps trying by itself." : "",
      lunaError: luna.status === "rejected" && shares.status === "fulfilled" ? "Can’t reach the Luna server right now. This page keeps trying by itself." : "",
    }));
  }, [ngoId, session.token]);
  // Offers arrive the instant the Logistics Agent sends them; the 10 s poll is only a backstop.
  useLive(() => void reload());
  useEffect(() => {
    let live = true;
    const tick = () => { if (live) void reload(); };
    const first = setTimeout(tick, 0), id = setInterval(tick, 10_000);
    return () => { live = false; clearTimeout(first); clearInterval(id); };
  }, [reload]);
  return { ngoId, data, reload };
}

const servingsIn = (sh: NgoShare) => sh.lines.reduce((n, l) => n + l.servings, 0);
const foodIn = (sh: NgoShare) => [...new Set(sh.food.map(f => f.name ?? "food"))].join(" + ");
/** Each food in the share and how many it serves (sweets and extras counted separately from meals). */
function FoodLines({ sh }: { sh: NgoShare }) {
  if (sh.food.length < 2) return null;
  return (
    <ul className={s.foodLines}>
      {sh.food.map((f, i) => <li key={i}><b>{f.name ?? "Food"}</b><span>{f.servings} {f.tags?.includes("extra") ? "portions (sweet or extra)" : "servings"}</span></li>)}
    </ul>
  );
}

export default function NgoHome({ session, fields: f }: { session: Session; fields: Record<string, string> }) {
  const router = useRouter();
  const { ngoId, data, reload } = useNgoData(session);
  const now = useClock(1000);
  const [statusBusy, setStatusBusy] = useState(false), [statusError, setStatusError] = useState(""), [showAll, setShowAll] = useState(false), [todayOpen, setTodayOpen] = useState(false);

  const shares = data.shares ?? [];
  // Offers from the Logistics Agent (normal and redirected mid-trip), then food on its way, then received today.
  const offers = shares.filter(sh => sh.status === "offering" && sh.ngoId === ngoId && (sh.offerDeadlineAt ?? 0) > now);
  const redirects = shares.filter(sh => sh.redirect?.ngoId === ngoId && sh.ngoId !== ngoId && sh.redirect.deadlineAt > now);
  const waitingLuna = (data.luna ?? []).filter(o => o.deadline > now);
  const waiting = offers.length + redirects.length + waitingLuna.length;
  const coming = shares.filter(sh => sh.ngoId === ngoId && (sh.status === "finding_partner" || sh.status === "assigned" || sh.status === "picked_up"));
  const received = shares.filter(sh => sh.ngoId === ngoId && sh.status === "delivered" && sameDay(sh.createdAt, now));
  const raw = data.ngo, ngo = raw ? effectiveNgo(raw) : raw, listed = !!ngo, open = ngo?.status === "ACTIVE";
  const loading = data.shares === null && data.luna === null && !data.agentError;

  // The tab title and a single buzz tell someone across the room that food is waiting.
  const seen = useRef(0);
  useEffect(() => {
    document.title = waiting ? `(${waiting}) Food waiting · Luna` : "Luna · NGO";
    if (waiting > seen.current && navigator.userActivation?.hasBeenActive) try { navigator.vibrate?.(180); } catch { /* not supported */ }
    seen.current = waiting;
  }, [waiting]);
  useEffect(() => () => { document.title = "Luna"; }, []);

  const changeStatus = async (status: NgoStatus) => {
    setStatusBusy(true); setStatusError("");
    try { await setNgoStatus(ngoId, status); await reload(); }
    catch (e) { setStatusError((e as Error).message); }
    finally { setStatusBusy(false); }
  };

  return (
    <DonorShell title={f.org || ngo?.name || "NGO"}
      right={<>
        {raw && <button type="button" className={s.todayButton} data-on={!!raw.today_active} onClick={() => setTodayOpen(true)}
          aria-label={raw.today_active ? "Today’s listing is on. Change it" : "Set today’s listing"}><CalendarClock size={18} aria-hidden /><span>Today</span></button>}
        <Link href="/profile" className={d.iconButton} aria-label="Your profile and default listing"><CircleUser size={22} aria-hidden /></Link>
      </>}>
      <div className={s.home}>
        <div className={s.work}>
          <Updates />
          <section aria-labelledby="waiting-title" aria-live="polite" className={s.section}>
            <h2 id="waiting-title" className={s.heading}>Food waiting for you {waiting > 0 && <span className={s.count}>{waiting}</span>}</h2>
            {coming.length > 0 && waiting > 1 && (
              <a href="#coming-title" className={s.jump}><ArrowDown size={16} aria-hidden /> {coming.length} coming{coming[0].dropCode ? <> · code <span className={s.nowrap}>{coming[0].dropCode}</span></> : null}</a>
            )}
            {[
              ...waitingLuna.map(o => <LunaOffer key={o.l.id} l={o.l} deadline={o.deadline} now={now} session={session} onAccepted={url => router.push(url)} />),
              ...redirects.map(sh => <ShareOffer key={`r-${sh.id}`} sh={sh} redirect now={now} onDone={reload} />),
              ...offers.map(sh => <ShareOffer key={sh.id} sh={sh} now={now} onDone={reload} />),
            ].slice(0, showAll ? undefined : 2)}
            {waiting > 2 && !showAll && (
              <button type="button" className={s.more} onClick={() => setShowAll(true)}>{waiting - 2} more waiting · show all <ChevronDown size={18} aria-hidden /></button>
            )}
            {waiting === 0 && (
              loading ? <div className={s.quiet}><p className={s.print}>Checking for food…</p></div>
              : !listed && data.ngo !== undefined ? (
                <div className={s.quiet} data-call>
                  <p className={s.print}>Luna can’t send you food yet</p>
                  <p>List your NGO once: where you are, how many meals you need and when you receive food. It takes about two minutes.</p>
                  <Link href="/profile" className={d.primary}>List your NGO <ArrowRight size={18} aria-hidden /></Link>
                </div>
              ) : listed && !open ? (
                <div className={s.quiet} data-call>
                  <p className={s.print}>You’re marked {ngo?.status === "AT_CAPACITY" ? "full" : "closed"}</p>
                  <p>Luna isn’t sending you food right now. Reopen when you can take food again.</p>
                  <button type="button" className={d.primary} disabled={statusBusy} onClick={() => void changeStatus("ACTIVE")}>{statusBusy ? "Opening…" : "We can take food again"}</button>
                </div>
              ) : (
                <div className={s.quiet}>
                  <p className={s.print}>Nothing waiting right now</p>
                  <p>When a donor’s food suits you, it appears here with a big Accept button. Keep this page open; it checks every few seconds.</p>
                </div>
              )
            )}
          </section>

          {(coming.length > 0 || received.length > 0) && (
            <section aria-labelledby="coming-title" className={s.section}>
              <h2 id="coming-title" className={s.heading}>Coming to you {coming.length > 0 && <span className={s.count}>{coming.length}</span>}</h2>
              {coming.map(sh => <Coming key={sh.id} sh={sh} onDone={reload} />)}
              {received.length > 0 && (
                <ul className={s.received} aria-label="Received today">
                  {received.map(sh => <Received key={sh.id} sh={sh} onDone={reload} />)}
                </ul>
              )}
            </section>
          )}
          {data.agentError && <p className={d.barError} role="alert">{data.agentError}</p>}
          {data.lunaError && !data.agentError && <p className={d.barError} role="alert">{data.lunaError}</p>}
        </div>

        <aside className={s.day} aria-label="Today">
          <section className={s.card} aria-labelledby="status-title">
            <h2 id="status-title" className={s.heading}>Right now we are</h2>
            <div className={s.punches} role="radiogroup" aria-labelledby="status-title" aria-describedby="status-note">
              {STATUSES.map(st => (
                <label key={st.value} className={s.punch} data-on={ngo?.status === st.value} data-disabled={!listed || statusBusy}>
                  <input type="radio" name="ngo-status" value={st.value} checked={ngo?.status === st.value} disabled={!listed || statusBusy}
                    onChange={() => void changeStatus(st.value)} />
                  <b>{st.label}</b><span>{st.line}</span>
                </label>
              ))}
            </div>
            <p id="status-note" className={d.note}>{listed ? "Tap one. Luna only sends food while you’re open." : "List your NGO first, then you can open and close here."}</p>
            {statusError && <p className={d.barError} role="alert">{statusError}</p>}
          </section>

          <Today ngo={ngo ?? null} todayActive={!!raw?.today_active} onEdit={() => setTodayOpen(true)}
            coming={coming.map(sh => ({ id: sh.id, eta: sh.arriveBy ?? null }))} received={received.map(sh => ({ id: sh.id, at: sh.createdAt }))} now={now} />

          <nav className={d.links} aria-label="More">
            <Link href="/profile"><Building2 size={18} aria-hidden /><span><b>Default listing</b>Your usual meals, hours and food you accept</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/ngo/list"><MapIcon size={18} aria-hidden /><span><b>NGO directory</b>Every NGO listed in Luna</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/offers"><Inbox size={18} aria-hidden /><span><b>Luna app offers</b>Food offered through the Luna app, with tracking</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/deliveries"><Truck size={18} aria-hidden /><span><b>Track deliveries</b>Live route and arrival time</span><ArrowRight size={16} aria-hidden /></Link>
            <Link href="/map"><MapIcon size={18} aria-hidden /><span><b>Surplus near you</b>The food map for {f.area || "your area"}</span><ArrowRight size={16} aria-hidden /></Link>
          </nav>

          <details className={s.details}>
            <summary>Your details <ChevronDown size={16} aria-hidden /></summary>
            <dl className={d.leaders}>
              {f.name && <Pair k="Name" v={f.name} />}
              {f.org && <Pair k="Org" v={f.org} />}
              {f.kind && <Pair k="Type" v={f.kind} />}
              {f.area && <Pair k="Area" v={f.area} />}
              {f.address && <Pair k="Address" v={f.address} />}
              {f.verification && <Pair k="Verified" v={f.verification} />}
              {f.beneficiaries && <Pair k="Serving" v={f.beneficiaries} />}
              {f.standingNeed && <Pair k="Meal need" v={`${f.standingNeed} adults`} />}
              {f.diets && <Pair k="Diet" v={f.diets === "veg" ? "Vegetarian" : f.diets} />}
              <Pair k="Mobile" v={formatPhone(session.phone)} />
              <Pair k="Signed in" v={stamp(new Date(session.signedInAt))} />
            </dl>
          </details>

          <section className={s.soon} aria-labelledby="soon-title">
            <h2 id="soon-title" className={s.heading}>Coming to this app</h2>
            <ul>{ROLE_META.ngo.upcoming.map(u => <li key={u.title}><b>{u.title}</b> {u.line}</li>)}</ul>
          </section>

          {f.sample === "true" && <p className={d.note}>Fictional walkthrough account · <Link href="/demo" target="_blank">open the other accounts</Link></p>}
          <button type="button" className={d.ghost} data-wide onClick={() => { signOut(); router.replace("/login"); }}><LogOut size={18} aria-hidden /> Sign out</button>
        </aside>
      </div>
      {raw && <TodaySheet ngo={raw} open={todayOpen} onClose={() => setTodayOpen(false)} onSaved={reload} />}
    </DonorShell>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return <div><dt>{k}</dt><dd>{v}</dd></div>;
}

/** Big tabular countdown; red only in the last minute. */
function Countdown({ ms }: { ms: number }) {
  const sec = Math.max(0, Math.ceil(ms / 1000)), m = Math.floor(sec / 60), ss = sec % 60;
  return (
    <span className={s.timer} data-low={sec < 60} role="timer" aria-label={`${m} minutes ${ss} seconds left to answer`}>
      <b>{m}:{String(ss).padStart(2, "0")}</b><span>left to answer</span>
    </span>
  );
}

function OfferTicket({ title, from, deadline, now, stampText, children }: {
  title: string; from: string; deadline: number | null; now: number; stampText?: string; children: ReactNode;
}) {
  return (
    <article className={s.offer} aria-label={`Food offer: ${title}`}>
      {stampText && <span className={s.stampBig} aria-hidden>{stampText}</span>}
      <header className={s.offerHead}>
        <div>
          <h3>{title}</h3>
          <p>{from}</p>
        </div>
        {deadline !== null && <Countdown ms={deadline - now} />}
      </header>
      {children}
    </article>
  );
}

function LunaOffer({ l, deadline, now, session, onAccepted }: {
  l: ListingView; deadline: number; now: number; session: Session; onAccepted: (url: string) => void;
}) {
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [done, setDone] = useState(false);
  const key = useRef<string | null>(null);
  const a = l.assessment, check = l.foodCheck;
  const accept = async () => {
    setBusy(true); setProblem("");
    try {
      key.current ??= crypto.randomUUID();
      const r = await api<{ trackingUrl: string }>(`/offers/${l.id}/accept`, { method: "POST", token: session.token, headers: { "Idempotency-Key": key.current }, body: "{}" });
      setDone(true); setTimeout(() => onAccepted(r.trackingUrl), 650);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  return (
    <OfferTicket title={`${servingsOf(l)} × ${l.dish}`} from={`from ${l.donorName}${l.pickupArea ? ` · ${l.pickupArea}` : ""}`} deadline={deadline} now={now} stampText={done ? "Accepted" : undefined}>
      <dl className={d.leaders}>
        {a && <Pair k="Grade" v={`${a.grade} · ${GRADE_LABEL[a.grade]}`} />}
        {a && <Pair k="Safe until" v={new Date(a.safeUntil).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })} />}
        <Pair k="Food" v={l.diet === "veg" ? "Vegetarian" : l.diet === "egg" ? "Has egg" : "Non-veg"} />
        {l.contains.length > 0 && <Pair k="Contains" v={l.contains.join(", ").replace(/_/g, " ")} />}
      </dl>
      {check?.reasoning && a && <Reasoning reasoning={check.reasoning} grade={a.grade} model={modelName(check.models?.photo)} />}
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      <div className={s.answer}>
        <button type="button" className={s.accept} disabled={busy || done} onClick={() => void accept()}>
          <Check size={22} strokeWidth={3} aria-hidden /> {busy ? "Accepting…" : "Accept food"}
        </button>
      </div>
      <p className={d.note}>A delivery partner collects it. If you don’t answer in time, the next NGO is asked.</p>
    </OfferTicket>
  );
}

/** An offer from the Logistics Agent (or a mid-trip redirect): the food, the countdown, Accept or pass. */
function ShareOffer({ sh, redirect = false, now, onDone }: { sh: NgoShare; redirect?: boolean; now: number; onDone: () => Promise<void> }) {
  const [declining, setDeclining] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState(""), [done, setDone] = useState("");
  const grades = sh.food.map(f => f.grade).filter(Boolean) as ("A" | "B" | "C" | "D")[];
  const worst = grades.sort().at(-1);
  const diets = [...new Set(sh.food.map(f => f.diet).filter(Boolean))].map(x => x === "veg" ? "Vegetarian" : x === "jain" ? "Jain" : x === "egg" ? "Has egg" : x === "nonveg" ? "Non-veg" : "Diet not stated");
  const allergens = [...new Set(sh.food.flatMap(f => f.allergens ?? []))];
  const answer = async (accept: boolean) => {
    setBusy(true); setProblem("");
    try {
      const r = redirect ? await answerRedirect(sh.id, accept) : await answerOffer(sh.id, accept);
      if (!r.ok) throw new Error(r.error);
      setDone(accept ? "Accepted" : "Passed on"); setTimeout(() => void onDone(), 650);
    } catch (e) { setProblem((e as Error).message); setBusy(false); }
  };
  const deadline = redirect ? sh.redirect!.deadlineAt : sh.offerDeadlineAt ?? null;
  const arrive = redirect ? sh.redirect!.arriveBy : sh.arriveBy;
  return (
    <OfferTicket title={`${servingsIn(sh)} × ${foodIn(sh)}`} from={redirect ? `Already on the way, from ${sh.donorName ?? "a restaurant"}` : `from ${sh.donorName ?? "a restaurant"}`}
      deadline={deadline} now={now} stampText={done || undefined}>
      <SharePhoto shareId={sh.id} alt={`Photo of ${foodIn(sh)}`} />
      <FoodLines sh={sh} />
      <dl className={d.leaders}>
        {arrive && <Pair k="Reaches you" v={`about ${fmtTime(arrive)}`} />}
        {worst && <Pair k="Grade" v={`${worst} · ${GRADE_LABEL[worst]}`} />}
        {diets.length > 0 && <Pair k="Food" v={diets.join(", ")} />}
        {allergens.length > 0 && <Pair k="Contains" v={allergens.join(", ")} />}
      </dl>
      {redirect && <p className={d.note}>A delivery partner already has this food. The NGO it was going to can’t receive it in time, and you’re close enough to serve it safely.</p>}
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      {!declining ? (
        <div className={s.answer}>
          <button type="button" className={s.accept} disabled={busy || !!done} onClick={() => void answer(true)}>
            <Check size={22} strokeWidth={3} aria-hidden /> {busy ? "Accepting…" : "Accept food"}
          </button>
          <button type="button" className={s.pass} disabled={busy || !!done} onClick={() => setDeclining(true)}><X size={18} aria-hidden /> Can’t take it</button>
        </div>
      ) : (
        <div className={s.declineBox}>
          <p className={s.print}>Pass this food on?</p>
          <p className={d.note}>The next NGO is asked straight away. Passing never counts against you.</p>
          <div className={s.answer}>
            <button type="button" className={d.primary} disabled={busy || !!done} onClick={() => void answer(false)}>{busy ? "Sending…" : "Send to the next NGO"}</button>
            <button type="button" className={s.pass} disabled={busy} onClick={() => setDeclining(false)}>Back</button>
          </div>
        </div>
      )}
    </OfferTicket>
  );
}

/** Accepted food that hasn't arrived: what's happening now, the partner, the drop code. */
function Coming({ sh, onDone }: { sh: NgoShare; onDone: () => Promise<void> }) {
  const [t, setT] = useState<Track | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => track(sh.id).then(x => { if (live) setT(x); }, () => {});
    load(); const id = setInterval(load, 5000);
    return () => { live = false; clearInterval(id); };
  }, [sh.id, sh.status]);
  const title = `${servingsIn(sh)} × ${foodIn(sh)}`, p = t?.partner?.name;
  const [nowLine, nextLine] = sh.status === "picked_up"
    ? [`${p ?? "The partner"} picked it up and is on the way to you.`, "Give the drop code when the food is in your hands."]
    : sh.status === "assigned" ? [`${p ?? "A partner"} is going to ${sh.donorName ?? "the restaurant"}.`, "They show the restaurant’s pickup code, then come to you."]
    : ["Finding a delivery partner, your own riders first.", "You don’t need to do anything. If your own staff will collect, add them below."];
  return (
    <article className={s.coming} aria-label={`Coming to you: ${title}`} data-needs={sh.status === "finding_partner"}>
      <header className={s.offerHead}>
        <div><h3>{title}</h3><p>from {sh.donorName ?? "a restaurant"}</p></div>
        <span className={s.ticketStamp}>{sh.status === "picked_up" ? "On the way" : sh.status === "assigned" ? "Partner coming" : "Accepted"}</span>
      </header>
      {(t?.lateMin ?? 0) > 5 && <p className={s.lateNote} role="status">{p ?? "The partner"} is about {t!.lateMin} min late. New arrival about {t?.eta ? fmtTime(t.eta) : "soon"}; the food is still safe.</p>}
      <p className={s.nowLine}><b>{nowLine}</b> {nextLine}</p>
      {p && t?.partner?.rating && <p className={d.note}>{p} · reliability {t.partner.rating}</p>}
      {(sh.status === "assigned" || sh.status === "picked_up") && !t?.partner?.manual && <LiveDelivery shareId={sh.id} viewer="observer" />}
      <SharePhoto shareId={sh.id} alt={`Photo of ${foodIn(sh)}`} />
      <FoodLines sh={sh} />
      {sh.status === "finding_partner" && <SelfCollect id={sh.id} onDone={onDone} />}
      {t?.partner?.manual && <ManualCodes id={sh.id} status={sh.status} onDone={onDone} />}
      {sh.dropCode && (
        <div className={d.code}>
          <span>Drop code. Give it only when the food is in your hands.</span>
          <b>{sh.dropCode}</b>
        </div>
      )}
      <dl className={d.leaders}>
        <Pair k="Reaches you" v={t?.eta ? `about ${fmtTime(t.eta)}` : sh.arriveBy ? `about ${fmtTime(sh.arriveBy)}` : "—"} />
        {t?.containers?.length ? <Pair k="Partner brings" v={t.containers.join(", ")} /> : null}
      </dl>
    </article>
  );
}

/** "Our own staff will collect": the coordinator names someone; they use the same codes. */
function SelfCollect({ id, onDone }: { id: string; onDone: () => Promise<void> }) {
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState("");
  const send = async () => {
    setBusy(true); setProblem("");
    try { const r = await assignByHand(id, name.trim(), phone || undefined); if (!r.ok) throw new Error(r.error); await onDone(); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <details className={s.bring}>
      <summary>Our own staff will collect <ChevronDown size={16} aria-hidden /></summary>
      <label className={d.field}><span>Name</span><input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder="Who is going" /></label>
      <label className={d.field}><span>Mobile <small>(optional)</small></span><input inputMode="numeric" value={phone} onChange={e => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="10-digit mobile" /></label>
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      <button type="button" className={d.primary} disabled={busy || !name.trim()} onClick={() => void send()}>{busy ? "Sending…" : "They’ll collect it"}</button>
    </details>
  );
}

/** For someone the coordinator assigned by hand: the coordinator types the codes they're given. */
function ManualCodes({ id, status, onDone }: { id: string; status: NgoShare["status"]; onDone: () => Promise<void> }) {
  const which = status === "picked_up" ? "drop" : "pickup";
  const [code, setCode] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState("");
  const send = async () => {
    setBusy(true); setProblem("");
    try { const r = await enterCode(id, which, code); if (!r.ok) throw new Error(r.error); setCode(""); await onDone(); }
    catch (e) { setProblem((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className={s.declineBox}>
      <label className={d.field}><span>{which === "pickup" ? "Pickup code from the restaurant" : "Drop code (yours, below)"}</span>
        <input inputMode="numeric" value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="4 digits" /></label>
      {problem && <p className={d.barError} role="alert">{problem}</p>}
      <button type="button" className={d.primary} disabled={busy || code.length !== 4} onClick={() => void send()}>{busy ? "Checking…" : "Enter code"}</button>
    </div>
  );
}

/** Received today, with the one-tap feedback that sizes future deliveries. */
function Received({ sh, onDone }: { sh: NgoShare; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const say = async (result: "fewer" | "right" | "more") => { setBusy(true); try { await sendFeedback(sh.id, result); await onDone(); } finally { setBusy(false); } };
  return (
    <li>
      <Check size={16} strokeWidth={3} aria-hidden /><b>{servingsIn(sh)} × {foodIn(sh)}</b><span>received</span>
      {!sh.feedback ? (
        <span className={s.feedback} role="group" aria-label="How many did it feed?">
          {(["fewer", "right", "more"] as const).map(r => (
            <button key={r} type="button" className={d.chip} disabled={busy} onClick={() => void say(r)}><span>{r === "fewer" ? "Fed fewer" : r === "right" ? "About right" : "Fed more"}</span></button>
          ))}
        </span>
      ) : <span className={s.feedback}>Thanks for the feedback</span>}
    </li>
  );
}

/** The day at a glance: one plain sentence, then the hour strip it describes. */
function Today({ ngo, todayActive, onEdit, coming, received, now }: {
  ngo: Ngo | null; todayActive: boolean; onEdit: () => void; coming: { id: string; eta: number | null }[]; received: { id: string; at: number }[]; now: number;
}) {
  const pos = (h: number) => `${Math.min(100, Math.max(0, ((h - DAY.from) / (DAY.to - DAY.from)) * 100))}%`;
  const hourAt = (ms: number) => { const t = new Date(ms); return t.getHours() + t.getMinutes() / 60; };
  const hours = ngo?.receiving_hours, nowH = hourAt(now);
  const parts = [`${received.length} received`, `${coming.length} on the way`];
  return (
    <section className={s.card} aria-labelledby="today-title">
      <h2 id="today-title" className={s.heading}>Today</h2>
      <p className={s.todayLine}>{parts.join(" · ")}.{hours ? ` You take food ${timeName(hours.start)} to ${timeName(hours.end)}.` : ""}</p>
      {ngo && (
        <div className={s.todaySource} data-on={todayActive}>
          <p>Need today: <b>{ngo.current_demand.meals_needed} meals</b> · room for <b>{ngo.capacity.available_capacity_today}</b> more.</p>
          <p>{todayActive ? <><b>Today’s listing</b> is on until midnight.</> : <>From your <b>default listing</b>.</>}{" "}
            <button type="button" className={s.linkButton} onClick={onEdit}>{todayActive ? "Change today" : "Change just today"}</button></p>
        </div>
      )}
      <div className={s.strip} aria-hidden>
        <div className={s.track}>
          {hours && <i className={s.band} style={{ left: pos(hoursOf(hours.start)), width: `calc(${pos(hoursOf(hours.end))} - ${pos(hoursOf(hours.start))})` }} />}
          {received.map(o => <i key={o.id} className={s.dot} data-kind="in" style={{ left: pos(hourAt(o.at)) }} />)}
          {coming.filter(o => o.eta).map(o => <i key={o.id} className={s.dot} data-kind="coming" style={{ left: pos(hourAt(o.eta!)) }} />)}
          {nowH >= DAY.from && nowH <= DAY.to && <i className={s.now} style={{ left: pos(nowH) }}><span>Now</span></i>}
        </div>
        <div className={s.hours}>{[6, 9, 12, 15, 18, 21, 24].map(h => <span key={h} data-minor={h === 21 || h === 9} style={{ left: pos(h) }}>{hourName(h)}</span>)}</div>
      </div>
      <p className={s.legend} aria-hidden><span><i data-kind="in" /> received</span><span><i data-kind="coming" /> on the way</span><span><i data-kind="band" /> your hours</span></p>
    </section>
  );
}
