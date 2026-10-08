"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { api } from "@/lib/luna/api";
import { getProfile, getSession, type Session } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import { ALLERGENS, inputTime, type ListingInput, type ListingView } from "@/lib/luna/listing";
import { compressPhoto } from "@/lib/luna/photo";
import { tripTime } from "@/lib/luna/trip";
import SnapListing from "@/components/donor/SnapListing";
import DonationTicket from "@/components/donor/DonationTicket";
import DonationList from "@/components/donor/DonationList";
import DonorShell from "@/components/donor/DonorShell";
import s from "./listing.module.css";

export default function ListingScreen({ mode }: { mode: "new" | "list" | "detail" | "offers" | "reviews" }) {
  const hydrated = useHydrated(), router = useRouter(), params = useParams<{ id: string }>();
  const session = hydrated ? getSession() : null, role = session?.role;
  useEffect(() => { if (hydrated && !role) router.replace("/login"); }, [hydrated, role, router]);
  if (!session) return <main className={s.shell}><div className={s.paper}>Loading your account…</div></main>;
  // Donors get the "Snap first" app; NGO offers and admin reviews keep this screen.
  if (session.role === "donor" && mode === "new") return <SnapListing session={session} />;
  if (session.role === "donor" && mode === "detail") return <DonationTicket session={session} id={params.id} />;
  if (session.role === "donor" && mode === "list") return <DonorShell title="Your donations" back={{ label: "Home", href: "/donor" }}><DonationList session={session} /></DonorShell>;
  const title = { new: "List food", list: "Your food listings", detail: "Food listing", offers: "Food offers", reviews: "First-listing reviews" }[mode];
  return <main className={s.shell}>
    <header className={s.bar}><Link href={`/${session.role}`}>← Home</Link><strong>LUNA</strong><span>{title}</span></header>
    <div className={s.paper}>
      {mode === "new" ? <NewListing session={session} /> : mode === "detail" ? <ListingDetail session={session} id={params.id} /> : <ListingInbox session={session} mode={mode} />}
    </div>
  </main>;
}

function NewListing({ session }: { session: Session }) {
  const router = useRouter(), f = getProfile(session.role, session.phone)?.fields ?? {};
  const [dish, setDish] = useState(""), [photo, setPhoto] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [diet, setDiet] = useState<ListingInput["diet"]>("veg"), [jain, setJain] = useState(false), [halal, setHalal] = useState<ListingInput["halal"]>("unsure"), [spice, setSpice] = useState<ListingInput["spice"]>("medium");
  const [contains, setContains] = useState<string[]>([]), [mode, setMode] = useState<ListingInput["entryMode"]>("per_person_pack"), [count, setCount] = useState(10), [feeds, setFeeds] = useState(1);
  const [cooked, setCooked] = useState(() => inputTime(Date.now() - 15 * 60_000)), [storage, setStorage] = useState<ListingInput["storage"]>("hot");
  const [ready, setReady] = useState(() => inputTime(Date.now())), [collect, setCollect] = useState(() => inputTime(Date.now() + 60 * 60_000));
  const [address, setAddress] = useState(f.address ?? ""), [lat, setLat] = useState(f.lat ?? ""), [lng, setLng] = useState(f.lng ?? ""), [notes, setNotes] = useState(f.notes ?? "");
  const [containers, setContainers] = useState<ListingInput["containers"]>("donor_packs"), [declaration, setDeclaration] = useState(false), [review, setReview] = useState(false);
  const action = useRef<{ key: string; body: string } | null>(null);
  if (session.role !== "donor") return <p>Sign in as a donor to post food.</p>;
  const servings = count * (mode === "shared_pack" ? feeds : 1);
  const body = (): ListingInput => ({ dish: dish.trim(), diet, jain: diet === "veg" && jain, halal, spice, contains, entryMode: mode, count, feedsEach: mode === "shared_pack" ? feeds : 1,
    photo, cookedAt: new Date(cooked).getTime(), storage, readyFrom: new Date(ready).getTime(), collectBy: new Date(collect).getTime(), containers,
    pickup: { name: f.org || f.name || "Pickup", address, area: f.area || "Bengaluru", notes, lat: Number(lat), lng: Number(lng) }, contactName: f.name || f.org, contactPhone: session.phone, declarationAccepted: declaration });
  const submit = async () => {
    setBusy(true); setError("");
    const payload = JSON.stringify(body());
    if (!action.current || action.current.body !== payload) action.current = { key: crypto.randomUUID(), body: payload };
    try {
      const result = await api<{ listingUrl: string }>("/listings", { method: "POST", token: session.token, headers: { "Idempotency-Key": action.current.key }, body: payload });
      router.push(result.listingUrl);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <>
    <span className={s.eyebrow}>{f.org || f.name} · {f.area}</span><h1>{review ? "Review your donation" : "Food to share"}</h1>
    {review ? <>
      <FoodSummary value={{ ...body(), donorName: f.org || f.name, assessment: null }} />
      <p>Feeds {servings} people. Ready at {tripTime(new Date(ready).getTime())}; collect by {tripTime(new Date(collect).getTime())}.</p>
      <p className={s.note}>Your first listing goes to a Luna reviewer before it is offered to an NGO.</p>
      <div className={s.actions}><button disabled={busy} onClick={() => void submit()}>{busy ? "Submitting…" : "Submit listing"}</button><button className={s.outline} disabled={busy} onClick={() => setReview(false)}>Edit listing</button></div>
    </> : <form className={s.form} onSubmit={e => { e.preventDefault(); setError(""); if (!photo) { setError("Add a food photo before reviewing."); return; } setReview(true); }}>
      <section className={s.section}><h2>01 / Food photo</h2><label>Food photo<input type="file" required={!photo} accept="image/jpeg,image/png,image/webp" capture="environment" onChange={async e => {
        const file = e.target.files?.[0]; if (!file) return;
        try { if (file.size > 8 * 1024 * 1024) throw new Error("Use a food photo under 8 MB."); setPhoto(await compressPhoto(file)); setError(""); } catch (e) { setError((e as Error).message); }
      }} /></label>{photo && <Image className={s.photo} src={photo} alt="Your food photo" width={640} height={360} unoptimized />}</section>
      <section className={s.section}><h2>02 / What are you sharing?</h2>
        <label>Dish name<input required maxLength={120} value={dish} onChange={e => setDish(e.target.value)} placeholder="e.g. Vegetable biryani" /></label>
        <div className={s.columns}><label>Diet<select value={diet} onChange={e => setDiet(e.target.value as ListingInput["diet"])}><option value="veg">Vegetarian</option><option value="egg">Vegetarian with egg</option><option value="nonveg">Non-vegetarian</option></select></label><label>Spice<select value={spice} onChange={e => setSpice(e.target.value as ListingInput["spice"])}><option value="mild">Mild</option><option value="medium">Medium</option><option value="hot">Hot</option></select></label></div>
        {diet === "veg" && <label className={s.check}><input type="checkbox" checked={jain} onChange={e => setJain(e.target.checked)} />Jain · no onion, garlic or root vegetables</label>}
        {diet === "nonveg" && <label>Halal<select value={halal} onChange={e => setHalal(e.target.value as ListingInput["halal"])}><option value="unsure">Not sure</option><option value="yes">Yes</option><option value="no">No</option></select></label>}
        <p>Contains — confirm all ingredients and allergens:</p><div className={s.chips}>{ALLERGENS.map(a => <label className={s.check} key={a}><input type="checkbox" checked={contains.includes(a)} onChange={e => setContains(v => e.target.checked ? [...v, a] : v.filter(x => x !== a))} />{a.replaceAll("_", " / ")}</label>)}</div>
        <label>How is it packed?<select value={mode} onChange={e => setMode(e.target.value as ListingInput["entryMode"])}><option value="per_person_pack">One meal per box</option><option value="shared_pack">Shared boxes</option></select></label>
        <div className={s.columns}><label>Number of boxes<input type="number" min={1} max={200} required value={count} onChange={e => setCount(Number(e.target.value))} /></label>{mode === "shared_pack" && <label>People fed by each box<input type="number" min={1} max={50} required value={feeds} onChange={e => setFeeds(Number(e.target.value))} /></label>}</div>
        <p><strong>Feeds about {servings} people</strong></p>
      </section>
      <section className={s.section}><h2>03 / Timing and handover</h2>
        <div className={s.columns}><label>Cooked at<input required type="datetime-local" value={cooked} onChange={e => setCooked(e.target.value)} /></label><label>How has it been kept?<select value={storage} onChange={e => setStorage(e.target.value as ListingInput["storage"])}><option value="hot">Kept hot · at least 60°C</option><option value="room">At room temperature</option><option value="fridge">In a fridge · at most 5°C</option></select></label></div>
        <div className={s.columns}><label>Ready from<input required type="datetime-local" value={ready} onChange={e => setReady(e.target.value)} /></label><label>Collect by<input required type="datetime-local" value={collect} onChange={e => setCollect(e.target.value)} /></label></div>
        <label>Pickup address<input required maxLength={200} value={address} onChange={e => setAddress(e.target.value)} /></label>
        <details><summary>Pickup map pin</summary><div className={s.columns}><label>Latitude<input type="number" step="any" min={-90} max={90} required value={lat} onChange={e => setLat(e.target.value)} /></label><label>Longitude<input type="number" step="any" min={-180} max={180} required value={lng} onChange={e => setLng(e.target.value)} /></label></div></details>
        <label>Pickup instructions<textarea maxLength={200} value={notes} onChange={e => setNotes(e.target.value)} /></label>
        <label>Containers<select value={containers} onChange={e => setContainers(e.target.value as ListingInput["containers"])}><option value="donor_packs">Packed and ready to carry</option><option value="partner_brings">Delivery partner brings containers</option></select></label>
      </section>
      <label className={s.check}><input required type="checkbox" checked={declaration} onChange={e => setDeclaration(e.target.checked)} />I confirm this food was handled safely and the ingredients, quantities and times are correct.</label>
      <button>Review listing</button>
    </form>}
    {error && <p className={s.alert} role="alert">{error}</p>}
  </>;
}

function ListingInbox({ session, mode }: { session: Session; mode: "list" | "offers" | "reviews" }) {
  const [values, setValues] = useState<ListingView[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState<string | null>(null), [loaded, setLoaded] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({}), router = useRouter();
  const [expired, setExpired] = useState<{ id: string; reason: string; at: number }[]>([]);
  const actionKeys = useRef(new Map<string, { key: string; body: string }>());
  const refresh = async () => {
    const response = await api<{ listings?: ListingView[]; offers?: ListingView[]; expired?: { id: string; reason: string; at: number }[] }>(mode === "offers" ? "/offers" : "/listings", { token: session.token });
    setExpired(response.expired ?? []);
    setValues((response.offers ?? response.listings ?? []).filter(l => mode !== "reviews" || l.state === "in_review" || !!l.reviewPending)); setLoaded(true);
  };
  useEffect(() => {
    let cancelled = false;
    const update = async () => { try { if (!cancelled) await refresh(); } catch (e) { if (!cancelled) { setError((e as Error).message); setLoaded(true); } } };
    void update(); const timer = setInterval(update, 2000); return () => { cancelled = true; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, session.token]);
  const act = async (l: ListingView) => {
    setBusy(l.id); setError("");
    try {
      const body = JSON.stringify(mode === "reviews" ? { reason: reasons[l.id] ?? "" } : {});
      let action = actionKeys.current.get(l.id);
      if (!action || action.body !== body) { action = { key: crypto.randomUUID(), body }; actionKeys.current.set(l.id, action); }
      if (mode === "reviews") {
        await api(`/listings/${l.id}/approve`, { method: "POST", token: session.token, headers: { "Idempotency-Key": action.key }, body }); await refresh();
      } else {
        const result = await api<{ trackingUrl: string }>(`/offers/${l.id}/accept`, { method: "POST", token: session.token, headers: { "Idempotency-Key": action.key }, body }); router.push(result.trackingUrl);
      }
    } catch (e) { setError((e as Error).message); } finally { setBusy(null); }
  };
  return <>
    <h1>{mode === "offers" ? "Food offered to you" : mode === "reviews" ? "First-listing reviews" : "Your food listings"}</h1>
    {mode === "list" && <Link className={s.primaryLink} href="/listings/new">List food →</Link>}
    {!loaded && <p>Loading…</p>}{loaded && !values.length && <p>{mode === "offers" ? "No food offers yet. Eligible donations will appear here." : mode === "reviews" ? "No first listings waiting for review." : "No listings yet. Post your first donation."}</p>}
    {expired.map(e => <p className={s.status} role="status" key={`${e.id}:${e.at}`}>{e.reason}</p>)}
    {values.map(l => <article className={s.card} key={l.id} data-listing-id={l.id}>
      <FoodSummary value={l} /><div className={s.status}>{l.progress}</div>
      {mode === "list" ? <Link href={`/listings/${l.id}`}>Open listing{l.deliveredAt ? " and receipt" : ""} →</Link> : mode === "reviews" ? <div className={s.form}>
        <p>First listing from {l.donorName}. Review its photo, tags and timings before approval.</p><label>Review reason<input value={reasons[l.id] ?? ""} maxLength={200} onChange={e => setReasons(v => ({ ...v, [l.id]: e.target.value }))} placeholder="What did you check?" /></label>
        <button disabled={busy === l.id || !reasons[l.id]?.trim()} onClick={() => void act(l)}>Approve first listing</button>
      </div> : <OfferActions value={l} busy={busy === l.id} accept={() => void act(l)} />}
    </article>)}
    {error && <p role="alert" className={s.alert}>{error}</p>}
  </>;
}

function useOfferRemaining(deadline: number | null, serverNow: number) {
  const [remaining, setRemaining] = useState(() => Math.max(0, (deadline ?? serverNow) - serverNow));
  useEffect(() => {
    const started = performance.now();
    const timer = setInterval(() => setRemaining(Math.max(0, (deadline ?? serverNow) - serverNow - (performance.now() - started))), 250);
    return () => clearInterval(timer);
  }, [deadline, serverNow]);
  return remaining;
}
const countdownText = (ms: number) => `${Math.floor(Math.ceil(ms / 1000) / 60)}:${String(Math.ceil(ms / 1000) % 60).padStart(2, "0")}`;
function OfferActions({ value: l, busy, accept }: { value: ListingView; busy: boolean; accept: () => void }) {
  const remaining = useOfferRemaining(l.offerDeadline, l.serverNow);
  return <>
    <p>Receive {l.assessment?.servings} servings at your NGO. A delivery partner will collect the food.</p>
    <div className={s.countdown} role="timer" aria-label="NGO offer acceptance countdown"><span>Reply within</span><strong>{countdownText(remaining)}</strong></div>
    {remaining <= 0 && <p className={s.note}>This offer ended. Luna is asking the next eligible NGO.</p>}
    <button disabled={busy || remaining <= 0 || !l.offerDeadline} onClick={accept}>Accept food offer</button>
  </>;
}
function DonorOfferCountdown({ value: l }: { value: ListingView }) {
  const remaining = useOfferRemaining(l.offerDeadline, l.serverNow);
  return <p className={s.note}>{l.offerRecipientName} has {countdownText(remaining)} to reply. If there is no reply, Luna asks the next eligible NGO automatically.</p>;
}

function ListingDetail({ session, id }: { session: Session; id: string }) {
  const [value, setValue] = useState<ListingView | null>(null), [error, setError] = useState(""), router = useRouter();
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const l = await api<ListingView>(`/listings/${id}`, { token: session.token });
        if (cancelled) return; setValue(l); setError("");
        if (l.trackingUrl && !l.deliveredAt) router.replace(l.trackingUrl);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
    };
    void refresh(); const timer = setInterval(refresh, 2000); return () => { cancelled = true; clearInterval(timer); };
  }, [id, router, session.token]);
  return <>
    <h1>{value?.deliveredAt ? "Donation receipt" : "Your donation"}</h1>
    {value ? <><FoodSummary value={value} /><div className={s.status}><strong>{value.progress}</strong></div>
      {value.state === "in_review" && <p>A Luna team member is reviewing your first listing. We will show the NGO’s response here.</p>}
      {value.state === "offered" && !value.trackingUrl && <p>Your food has been checked and offered to an eligible NGO. The map opens when they accept.</p>}
      {value.offerDeadline && !value.trackingUrl && <DonorOfferCountdown key={value.offerDeadline} value={value} />}
      {value.approval && <p className={s.note}>Reviewed by {value.approval.by}: {value.approval.reason}</p>}
      {value.deliveredAt && <><p><strong>{value.count * value.feedsEach} servings delivered to {value.recipientName}</strong></p><p>Delivered at {tripTime(value.deliveredAt)}. Both handovers were verified.</p></>}
      {value.trackingUrl && <Link className={s.primaryLink} href={value.trackingUrl}>Open delivery →</Link>}
    </> : !error && <p>Loading your donation…</p>}
    {error && <p role="alert" className={s.alert}>{error}</p>}
    <div className={s.actions}><Link href="/listings">All your listings</Link></div>
  </>;
}

type FoodSummaryValue = Pick<ListingView, "photo" | "dish" | "donorName" | "pickup" | "assessment" | "count" | "feedsEach" | "diet" | "contains" | "jain" | "cookedAt" | "storage" | "collectBy" | "containers"> & { pickupArea?: string };
function FoodSummary({ value: l }: { value: FoodSummaryValue }) {
  return <>
    {l.photo && <Image className={s.photo} src={l.photo} alt={l.dish} width={640} height={360} unoptimized />}
    <h2>{l.dish}</h2><p>{l.donorName} · {l.pickupArea || l.pickup?.area}</p>
    <dl className={s.facts}><dt>Meals</dt><dd>{l.assessment?.servings ?? l.count * l.feedsEach} servings · {l.diet === "veg" ? "Vegetarian" : l.diet === "egg" ? "With egg" : "Non-vegetarian"}</dd>
      <dt>Contains</dt><dd>{l.contains.length ? l.contains.map(a => a.replaceAll("_", " / ")).join(", ") : "No listed allergens"}{l.jain ? " · Jain" : ""}</dd>
      <dt>Cooked</dt><dd>{tripTime(l.cookedAt)} · {l.storage === "hot" ? "Kept hot ≥60°C" : l.storage === "fridge" ? "Kept chilled ≤5°C" : "Room temperature"}</dd>
      <dt>Collect by</dt><dd>{tripTime(l.collectBy)}</dd><dt>Containers</dt><dd>{l.containers === "donor_packs" ? "Packed and ready" : "Partner brings containers"}</dd>
      {l.assessment && <><dt>Food check</dt><dd>Grade {l.assessment.grade} · safe until {tripTime(l.assessment.safeUntil)}{l.assessment.unsure ? " · pickup check required" : ""}</dd></>}
    </dl>
  </>;
}
