"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Check, Info, MapPin, RotateCcw, TriangleAlert, X } from "lucide-react";
import { api } from "@/lib/luna/api";
import { useLive } from "@/lib/luna/live";
import type { Session } from "@/lib/luna/auth";
import type { ListingView } from "@/lib/luna/listing";
import { TRIP_STATUS, tripTime, type TripView } from "@/lib/luna/trip";
import PhotoCanvas from "./PhotoCanvas";
import DonorShell from "./DonorShell";
import { GRADE_LABEL, GRADE_MEANING, leadShare, modelName, servingsOf, stagesOf, type Stage } from "./stages";
import { keepRelist, tagLine } from "./relist";
import { Updates } from "@/components/agents/live-bits";
import LiveDelivery from "@/components/trip/LiveDelivery";
import s from "./donor.module.css";

/** Live view of one donation: a ticket with a coupon per stage that stamps as it completes. */
export default function DonationTicket({ session, id }: { session: Session; id: string }) {
  const [l, setL] = useState<ListingView | null>(null), [t, setT] = useState<TripView | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const value = await api<ListingView>(`/listings/${id}`, { token: session.token });
        if (cancelled) return; setL(value); setError("");
        if (value.tripId && (value.trackingUrl || value.deliveredAt)) {
          const trip = await api<TripView>(`/trips/${value.tripId}`, { token: session.token }).catch(() => null);
          if (!cancelled) setT(trip);
        }
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void refresh(); const timer = setInterval(refresh, 4000);
    window.addEventListener("luna:live", refresh);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener("luna:live", refresh); };
  }, [id, session.token]);
  // The food check and every agent step on this donation arrive the moment they happen.
  useLive(() => window.dispatchEvent(new Event("luna:live")));

  const stages = l ? stagesOf(l, t) : [];
  return (
    <DonorShell title={l?.deliveredAt ? "Donation receipt" : "Your donation"} back={{ label: "Donations", href: "/listings" }}>
      {!l ? <p className={s.loading}>{error || "Loading your donation…"}</p> : (
        <div className={s.ticketLayout}>
          <div className={s.composeMedia}>
            <PhotoCanvas photo={l.photo} onPhoto={() => {}} onError={() => {}} scanning={!l.foodCheck} alt={l.dish} readOnly />
            <div className={s.ticketHead}>
              <h2>{l.dish}</h2>
              <p>{mealsLine(l) ?? `${servingsOf(l)} servings`} · {l.donorName} · {l.pickupArea}</p>
            </div>
          </div>
          <div className={s.resultCol}>
          {l.agentCase && <Updates />}
          {l.agentCase?.shares.filter(x => x.status === "assigned" || x.status === "picked_up").map(x => <LiveDelivery key={x.id} shareId={x.id} viewer="observer" />)}
          {l.foodCheck && <TagSlip l={l} session={session} onChange={setL} />}
          {l.agentCase && <PackingPlan l={l} />}
          {l.agentCase && <MealsMade l={l} />}
          {l.foodCheck ? <Verdict l={l} /> : (
            <section className={s.verdict} data-pending aria-live="polite">
              <p className={s.working}>Luna’s food check is looking at your photo, cooking time and storage. This takes about 15 seconds.</p>
            </section>
          )}
          {l.items && l.items.length > 1 && <SessionFoods l={l} />}
          <ol className={s.coupons} aria-label="Donation progress">
            {stages.map((st, i) => (
              <li key={st.key} className={s.coupon} data-state={st.state} aria-current={st.state === "active" ? "step" : undefined}>
                <StageMark stage={st} n={i + 1} />
                <div className={s.couponBody}>
                  <h3>{st.title}<span className={s.stateWord}>{STATE_WORD[st.state]}</span></h3>
                  <StageDetail stage={st} l={l} t={t} />
                </div>
              </li>
            ))}
          </ol>
          {l.agentCase && <AgentLog c={l.agentCase} />}
          {error && <p className={s.barError} role="alert">{error}</p>}
          </div>
        </div>
      )}
    </DonorShell>
  );
}

const STATE_WORD = { waiting: "Next", active: "Now", done: "Done", failed: "Stopped" } as const;

function StageMark({ stage, n }: { stage: Stage; n: number }) {
  return (
    <span className={s.mark} aria-hidden>
      {stage.state === "done" ? <Check size={18} strokeWidth={3} /> : stage.state === "failed" ? <X size={18} strokeWidth={3} /> : n}
    </span>
  );
}

function StageDetail({ stage, l, t }: { stage: Stage; l: ListingView; t: TripView | null }) {
  const c = l.foodCheck;
  switch (stage.key) {
    case "check": {
      if (!c) return <p className={s.working}>Checking the photo, cooking time and storage…</p>;
      if (stage.state === "failed") return <p>Not safe for people. The verdict above says why.</p>;
      return <p>Grade {c.grade} · {GRADE_LABEL[c.grade]}. The verdict above has the details.</p>;
    }
    case "ngo": {
      const lead = leadShare(l);
      if (l.agentCase) {
        if (stage.state === "done") return <p><strong>{lead?.ngoName}</strong> accepted your food.</p>;
        if (lead?.status === "offering") return (
          <>
            <p>Offered to <strong>{lead.ngoName}</strong>{lead.offerDeadlineAt ? <>, who has until <span className={s.countdown}>{tripTime(lead.offerDeadlineAt)}</span> to reply</> : null}. If they can’t take it, Luna asks the next NGO.</p>
            {l.agentCase.ranked.length > 1 && (
              <ol className={s.ranked} aria-label="NGOs lined up, best first">
                {l.agentCase.ranked.map((r, i) => <li key={i} data-now={r.ngoName === lead.ngoName}><b>{i + 1}</b>{r.ngoName}<span>~{tripTime(r.arriveBy)}</span></li>)}
              </ol>
            )}
          </>
        );
        return <p>{l.agentCase.unplacedServings ? "No delivery partner can collect it right now. Luna offers it again as soon as one can, while it’s still safe." : "Luna’s NGO Agent is finding the right NGO."}</p>;
      }
      if (stage.state === "failed" && l.state === "tags_held") return <p>Held until your tags match the photo.</p>;
      if (stage.state === "failed") return <p>No NGO could safely take it before it expires. Please don’t keep it past its safe time.</p>;
      if (stage.state === "waiting") return <p className={s.note}>Starts once the food check passes.</p>;
      if (stage.state === "done") return <p><strong>{l.recipientName}</strong> accepted your food.</p>;
      if (l.state === "in_review") return <p>A Luna team member is checking your first listing. Usually under 15 minutes.</p>;
      if (l.offerDeadline) return <OfferWait l={l} />;
      return <p>Food checked. Luna is finding the right NGO.</p>;
    }
    case "pickup":
      if (l.agentCase) {
        const lead = leadShare(l);
        if (stage.state === "waiting") return <p className={s.note}>A delivery partner is booked when an NGO accepts.</p>;
        if (stage.state === "failed") return <p>The pickup didn’t go ahead. The Luna team has been alerted.</p>;
        if (stage.state === "done") return <p>Picked up{lead?.pickedUpAt ? ` at ${tripTime(lead.pickedUpAt)}` : ""}{lead?.partnerName ? ` by ${lead.partnerName}` : ""}.</p>;
        return (
          <>
            <p>{lead?.status === "assigned" ? <><strong>{lead.partnerName ?? "A partner"}</strong> is on the way to you.</> : "Finding a delivery partner, the NGO’s own riders first…"}</p>
            {lead?.pickupCode && <div className={s.code}><span>Show this code when you hand over the food</span><b>{lead.pickupCode}</b></div>}
          </>
        );
      }
      if (stage.state === "waiting") return <p className={s.note}>A delivery partner is booked when an NGO accepts.</p>;
      if (stage.state === "failed") return <p>The food didn’t pass the pickup check, so it wasn’t taken.</p>;
      if (stage.state === "done") return <p>Picked up{t?.pickedUpAt ? ` at ${tripTime(t.pickedUpAt)}` : ""}{t?.partnerName ? ` by ${t.partnerName}` : ""}.</p>;
      return (
        <>
          <p>{t?.partnerName && t.partnerName !== "Finding a delivery partner" ? <><strong>{t.partnerName}</strong> · {TRIP_STATUS[t.status]}</> : "Finding a delivery partner…"}
            {t?.eta && !t.pickedUpAt ? ` · arrives about ${tripTime(t.eta)}` : ""}</p>
          {t?.code?.kind === "pickup" && (
            <div className={s.code}><span>Show this code when you hand over the food</span><b>{t.code.value}</b></div>
          )}
          {l.trackingUrl && <Link className={s.inlineAction} href={l.trackingUrl}><MapPin size={16} aria-hidden /> Track live on the map <ArrowRight size={16} aria-hidden /></Link>}
        </>
      );
    case "delivered":
      if (l.agentCase && stage.state === "active") return <p>On the way to {leadShare(l)?.ngoName ?? "the NGO"}{leadShare(l)?.arriveBy ? `, arriving about ${tripTime(leadShare(l)!.arriveBy!)}` : ""}.</p>;
      if (l.agentCase && stage.state === "done") return <p><strong>Delivered to {leadShare(l)?.ngoName}</strong>{l.deliveredAt ? ` at ${tripTime(l.deliveredAt)}` : ""}. Both handovers were checked with codes.</p>;
      if (stage.state === "done") return <p><strong>{servingsOf(l)} servings delivered to {l.recipientName}</strong> at {tripTime(l.deliveredAt!)}. Both handovers were verified with codes.</p>;
      if (stage.state === "active") return <p>On the way to {l.recipientName ?? "the NGO"}{t?.eta ? `, arriving about ${tripTime(t.eta)}` : ""}.{l.trackingUrl && <> <Link className={s.inlineAction} href={l.trackingUrl}>Track live <ArrowRight size={16} aria-hidden /></Link></>}</p>;
      return <p className={s.note}>You’ll get a receipt here.</p>;
  }
}

const AGENT_NAME = { food: "Food Agent", ngo: "NGO Agent", logistics: "Logistics Agent", decision: "Decision Agent" } as const;
/** Every decision Luna's agents made on this donation, with its reason, oldest first (spec §14.4). */
function AgentLog({ c }: { c: NonNullable<ListingView["agentCase"]> }) {
  if (!c.timeline.length) return null;
  return (
    <details className={s.agentLog} open={false}>
      <summary>What Luna’s agents did <span>{c.timeline.length}</span></summary>
      <ol>
        {c.timeline.map((e, i) => (
          <li key={i}>
            <span className={s.agentWhen}>{tripTime(e.at)}</span>
            <span className={s.agentWho}>{e.agent ? AGENT_NAME[e.agent] : "Luna"}</span>
            <p>{e.reason}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Every food in a session with its own servings, grade, safe-until and reasoning. */
function SessionFoods({ l }: { l: ListingView }) {
  return (
    <section className={s.foods} aria-labelledby="foods-title">
      <h2 id="foods-title">{l.items!.length} foods in this donation</h2>
      <ul>
        {l.items!.map(it => {
          const c = it.foodCheck;
          return (
            <li key={it.id} data-grade={c?.grade}>
              {/* eslint-disable-next-line @next/next/no-img-element -- the listing's own photo data URL */}
              <img src={it.photo} alt={`Photo of ${it.dish}`} />
              <div>
                <b>{it.dish}</b>
                <span>{it.servings} {it.role === "extra" ? "portions (sweet or extra)" : "servings"}{it.estimate ? " · about" : ""}</span>
                <span>{!c ? "Checking…" : c.grade === "D" ? "Not for people: kept off the delivery" : `Grade ${c.grade} · ${GRADE_LABEL[c.grade]}${c.safeUntil ? ` · safe until ${tripTime(c.safeUntil)}` : ""}`}</span>
                {c?.reasoning && <Reasoning reasoning={c.reasoning} grade={c.grade} model={modelName(c.models?.photo)} />}
              </div>
              {c && <em className={s.foodGrade} data-grade={c.grade}>{c.grade}</em>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "50 meals + 40 extras": extras and leftover staples or sides never count as meals (spec §7.5). */
function mealsLine(l: ListingView) {
  const m = l.agentCase?.meals;
  if (!m || (!m.extras && !m.addons && !m.bundles.length)) return null;
  return [`${m.meals} meal${m.meals === 1 ? "" : "s"}`, m.extras ? `${m.extras} extras` : "", m.addons ? `${m.addons} add-ons` : ""].filter(Boolean).join(" + ");
}

const DIET_WORD: Record<string, string> = { jain: "Jain", veg: "veg", egg: "egg", nonveg: "non-veg" };

/** Which of the restaurant's staples and sides the Food Agent paired into meals. */
function MealsMade({ l }: { l: ListingView }) {
  const m = l.agentCase?.meals;
  if (!m?.bundles.length) return null;
  return (
    <section className={s.packing} aria-labelledby="meals-title">
      <header><h2 id="meals-title">Meals made from your food</h2></header>
      <ul>{m.bundles.map(b => <li key={b.name}>{b.servings} × {b.name} ({DIET_WORD[b.diet] ?? b.diet})</li>)}</ul>
      <p className={s.note}>Rice or bread with a dal or curry makes one meal. {m.addons ? `${m.addons} servings without a partner go along as add-ons, not counted as meals.` : "Everything paired up."}</p>
    </section>
  );
}

/**
 * What to pack for each delivery partner, from the Decision Agent's split: which NGO, which foods and how much
 * in the restaurant's units, the containers they bring, and the one pickup code for the whole donation.
 */
function PackingPlan({ l }: { l: ListingView }) {
  const shares = l.agentCase!.shares.filter(x => x.status !== "unplaced" && x.status !== "failed" && x.status !== "delivered");
  if (!shares.length) return null;
  const code = shares.find(x => x.pickupCode)?.pickupCode;
  return (
    <section className={s.packing} aria-labelledby="packing-title">
      <header>
        <h2 id="packing-title">What to pack</h2>
        {code && <p className={s.packCode}><span>Pickup code for every partner</span><b>{code}</b></p>}
      </header>
      <ol>
        {shares.map((x, i) => (
          <li key={x.id}>
            <p className={s.packWho}><b>{shares.length > 1 ? `Bag ${i + 1}: ` : ""}{x.partnerName ?? (x.status === "offering" ? "Waiting for the NGO" : "Partner not booked yet")}</b>
              <span>for {x.ngoName ?? "an NGO"}{x.status === "offering" ? " (asked, not yet accepted)" : ""}</span></p>
            <ul>{x.lines.map(ln => <li key={ln.name}>{ln.name}: {ln.amount ? `${ln.amount} (${ln.servings} servings)` : `${ln.servings} servings`}</li>)}</ul>
            <p className={s.note}>{x.partnerName ?? "The partner"} brings {x.containers.join(" + ")}.</p>
          </li>
        ))}
      </ol>
      {shares.length > 1 && <p className={s.note}>Keep each bag separate: every partner takes only their NGO’s food.</p>}
    </section>
  );
}

/** The food check's verdict, printed reversed so it's the first thing read: grade, what it means, safety score, why. */
function Verdict({ l }: { l: ListingView }) {
  const c = l.foodCheck!, model = modelName(c.models?.photo), cells = c.score === null ? 0 : Math.round(c.score / 10);
  return (
    <section className={s.verdict} data-grade={c.grade} aria-labelledby="verdict-title">
      <div className={s.verdictMain}>
        <b className={s.verdictGrade} aria-hidden>{c.grade}</b>
        <div>
          <h2 id="verdict-title"><span className="visually-hidden">Grade {c.grade}: </span>{GRADE_LABEL[c.grade]}</h2>
          <p>{c.safeUntil ? <>Safe until <strong>{tripTime(c.safeUntil)}</strong></> : <>Don’t give this to people</>}</p>
        </div>
      </div>
      <p className={s.verdictMeaning}>{GRADE_MEANING[c.grade]}</p>
      {l.items && l.items.length > 1 && (
        <p className={s.verdictNote}>This is the strictest of your {l.items.length} foods. Luna checked each food on its own (see below), and each goes to the NGOs that can safely take that food.</p>
      )}
      {c.score !== null && (
        <div className={s.score}>
          <span>Safety score</span>
          <b>{c.score}<small>/100</small></b>
          <i className={s.scoreCells} role="img" aria-label={`Safety score ${c.score} out of 100`}>
            {Array.from({ length: 10 }, (_, i) => <i key={i} data-on={i < cells} />)}
          </i>
        </div>
      )}
      {c.grade !== "D" && c.unsure && <p className={s.verdictNote}>Marked Unsure: the delivery partner checks the food when they collect it. Nothing to do now.</p>}
      {c.grade === "D" && (c.message || c.reasons.length > 0) && (
        <div className={s.verdictNote}>{c.message && <p>{c.message}</p>}{c.reasons.length > 0 && <ul>{c.reasons.map(r => <li key={r}>{r}</li>)}</ul>}</div>
      )}
      {c.reasoning && <Reasoning reasoning={c.reasoning} grade={c.grade} model={model} />}
      <footer className={s.verdictFoot}>
        {c.seen && <p>The photo shows: {c.seen}</p>}
        <p>{model ? <>Photo checked by <b>{model}</b></> : <>Photo not judged by AI · graded from cooking time and storage</>}</p>
      </footer>
    </section>
  );
}

/** Tags the photo disagrees with. Sure: relist with the fixes. Unsure (yellow): relist or keep them. */
function TagSlip({ l, session, onChange }: { l: ListingView; session: Session; onChange: (l: ListingView) => void }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const c = l.foodCheck!, checks = c.tagChecks ?? [];
  if (!checks.length || !c.tagsVerdict || c.tagsVerdict === "ok") return null;
  if (l.replacedBy) return (
    <p className={s.tagSlip} data-tone="done">Relisted with corrected tags. <Link href={`/listings/${l.replacedBy}`}>Open the new listing <ArrowRight size={14} aria-hidden /></Link></p>
  );
  if (l.state !== "tags_held") return l.tagsKeptAt ? (
    <p className={s.tagSlip} data-tone="done">You kept your tags. The photo check had asked about: {checks.map(x => tagLine(x, l).title.toLowerCase()).join(", ")}.</p>
  ) : null;
  const sure = c.tagsVerdict === "wrong";
  const keep = async () => {
    setBusy(true); setError("");
    try { onChange(await api<ListingView>(`/listings/${l.id}/keep-tags`, { method: "POST", token: session.token, body: "{}" })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className={s.tagSlip} data-tone={sure ? "wrong" : "maybe"} aria-labelledby="tags-title" role={sure ? "alert" : undefined}>
      <h2 id="tags-title"><TriangleAlert size={20} aria-hidden /> {sure ? "Your tags don’t match the photo" : "Please double-check your tags"}</h2>
      <p>{sure ? "Luna won’t send this to NGOs until it’s relisted with the right tags. Your photo and details are kept; only the tags change."
        : "The photo check isn’t sure about these. If your tags are right, keep them. You know your food best."}</p>
      <ul>
        {checks.map(x => { const t = tagLine(x, l); return (
          <li key={`${x.itemId ?? ""}-${x.tag}`} data-sure={x.certainty === "sure"}>
            <b>{t.title}</b>{t.seen && <span>{t.seen}</span>}{t.fix && <em>Fix: {t.fix}</em>}
          </li>
        ); })}
      </ul>
      {error && <p className={s.barError} role="alert">{error}</p>}
      <div className={s.tagActions}>
        <button type="button" className={s.primary} onClick={() => { keepRelist(l); router.push("/listings/new"); }}><RotateCcw size={18} aria-hidden /> Relist with these fixes</button>
        {!sure && <button type="button" className={s.ghost} disabled={busy} onClick={() => void keep()}>{busy ? "Saving…" : "My tags are right"}</button>}
      </div>
    </section>
  );
}

type Why = NonNullable<NonNullable<ListingView["foodCheck"]>["reasoning"]>;
/** "Show reasoning": why the food check gave this grade, step by step. */
export function Reasoning({ reasoning, grade, model }: { reasoning: Why; grade: keyof typeof GRADE_LABEL; model: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId();
  return (
    <>
      <button type="button" className={s.reasonButton} onClick={() => dialog.current?.showModal()} aria-haspopup="dialog">
        <Info size={16} aria-hidden /> Show reasoning
      </button>
      <dialog ref={dialog} className={s.reasonSheet} aria-labelledby={titleId}>
        <header className={s.sheetHead}>
          <h2 id={titleId}>Why Grade {grade}</h2>
          <button type="button" className={s.iconButton} onClick={() => dialog.current?.close()} aria-label="Close"><X size={20} aria-hidden /></button>
        </header>
        <div className={s.sheetBody}>
          <div className={s.reasonHead}>
            <b data-grade={grade}>{grade}</b>
            <p>{reasoning.summary}</p>
          </div>
          <ol className={s.reasonSteps}>
            {reasoning.steps.map((st, i) => (
              <li key={`${st.title}-${i}`} data-status={st.status}>
                <span className={s.reasonMark} aria-hidden>{st.status === "pass" ? <Check size={14} strokeWidth={3} /> : st.status === "fail" ? <X size={14} strokeWidth={3} /> : st.status === "warn" ? "!" : "i"}</span>
                <div>
                  <h3>{st.title}</h3>
                  <p>{st.detail}</p>
                  {st.effect && <p className={s.reasonEffect}>{st.effect}</p>}
                </div>
              </li>
            ))}
          </ol>
          <p className={s.model}>{model ? <>Photo judged by <b>{model}</b>. </> : null}Food-safety rules decide the grade; the photo can only lower it.</p>
        </div>
      </dialog>
    </>
  );
}

function OfferWait({ l }: { l: ListingView }) {
  const [left, setLeft] = useState(() => Math.max(0, (l.offerDeadline ?? l.serverNow) - l.serverNow));
  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setLeft(Math.max(0, (l.offerDeadline ?? l.serverNow) - l.serverNow - (performance.now() - started))), 250);
    return () => clearInterval(timer);
  }, [l.offerDeadline, l.serverNow]);
  const sec = Math.ceil(left / 1000);
  return (
    <p>Offered to <strong>{l.offerRecipientName}</strong>. <span className={s.countdown} role="timer">{Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}</span> left to reply. If they don’t, Luna asks the next NGO automatically.</p>
  );
}
