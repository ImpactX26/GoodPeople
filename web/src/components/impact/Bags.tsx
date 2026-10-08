"use client";

import { useEffect, useState } from "react";
import { ShoppingBag } from "lucide-react";
import { openBags, reserveBag, type Bag } from "@/lib/luna/impact";
import DonorShell from "@/components/donor/DonorShell";
import s from "./impact.module.css";

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const DIET = { veg: "Veg", egg: "Contains egg", nonveg: "Non-veg" } as const;

/**
 * Surprise bags (SRS §9), public: end-of-day food restaurants sell at a discount instead of throwing it away.
 * Reserve with a name and number, pay the restaurant at pickup, show the code.
 */
export default function Bags() {
  const [bags, setBags] = useState<Bag[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    const load = (near?: { lat: number; lng: number }) => openBags(near).then((b) => live && setBags(b), (e) => live && setError((e as Error).message));
    void load();
    navigator.geolocation?.getCurrentPosition((p) => void load({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { timeout: 5000 });
    return () => { live = false; };
  }, []);
  return (
    <DonorShell title="Surprise bags">
      <div className={s.page}>
        <p className={s.note}>Restaurants near you sell food they couldn&rsquo;t sell today at a big discount, so it doesn&rsquo;t go to waste. Reserve a bag, then pay the restaurant when you collect it.</p>
        {error && <p className={s.error} role="alert">{error}</p>}
        {!bags ? <p className={s.note}>Looking for bags near you…</p> : bags.length === 0 ? (
          <div className={s.locked}><b>No bags on sale right now</b>Bakeries and cafés usually put them up in the evening. Check back later.</div>
        ) : <div className={s.bags}>{bags.map((b) => <BagCard key={b.id} bag={b} />)}</div>}
      </div>
    </DonorShell>
  );
}

function BagCard({ bag }: { bag: Bag }) {
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [code, setCode] = useState<string | null>(null), [left, setLeft] = useState(bag.left);
  const reserve = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try { const r = await reserveBag(bag.id, name, phone); setCode(r.code); setLeft(r.bag.left); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  return (
    <article className={s.bag} aria-labelledby={`bag-${bag.id}`}>
      <h3 id={`bag-${bag.id}`}>{bag.title}</h3>
      <p className={s.note}>{bag.donorName} · {bag.area}{bag.km != null ? ` · ${bag.km} km` : ""}</p>
      <div className={s.price}><b>₹{bag.price}</b><s>₹{bag.worth}</s><em>{left} left</em></div>
      <p>{bag.contents}</p>
      <dl className={s.lines}>
        <div><dt>Pick up</dt><dd>{time(bag.pickupFrom)}–{time(bag.pickupUntil)}</dd></div>
        <div><dt>Food</dt><dd>{DIET[bag.diet]}</dd></div>
      </dl>
      <p className={s.note}>{bag.address}</p>
      {code ? (
        <div className={s.code} role="status"><span>Your pickup code. Show it at {bag.donorName} and pay ₹{bag.price} there.</span><b>{code}</b></div>
      ) : left < 1 ? <p className={s.done}>Sold out</p> : (
        <form className={s.form} onSubmit={(e) => void reserve(e)}>
          <div className={s.row2}>
            <label className={s.field}>Your name<input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
            <label className={s.field}>Mobile<input required inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} autoComplete="tel-national" /></label>
          </div>
          {error && <p className={s.error} role="alert">{error}</p>}
          <button type="submit" className={s.inkButton} disabled={busy}><ShoppingBag size={18} aria-hidden /> {busy ? "Reserving…" : `Reserve for ₹${bag.price}`}</button>
        </form>
      )}
    </article>
  );
}
