"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Phone, ShoppingBag } from "lucide-react";
import { getProfile, type Session } from "@/lib/luna/auth";
import { bagCollected, closeBag, myBags, postBag, type Bag, type Hold } from "@/lib/luna/impact";
import DonorShell from "@/components/donor/DonorShell";
import { useAddresses } from "@/components/donor/useAddresses";
import s from "./impact.module.css";

const time = (ms: number) => new Date(ms).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" });
const UNTIL = [{ h: 1, label: "1 hour" }, { h: 2, label: "2 hours" }, { h: 3, label: "3 hours" }];

/**
 * A restaurant's surprise bags (SRS §9): put end-of-day food on sale at a discount, see who reserved, and check
 * each buyer's code at pickup. Food for NGOs still goes through a donation; bags are for what's left to sell.
 */
export default function MyBags({ session }: { session: Session }) {
  const f = getProfile(session.role, session.phone)?.fields ?? {};
  const { list: places } = useAddresses(session.token);
  const [bags, setBags] = useState<(Bag & { holds: Hold[] })[] | null>(null), [error, setError] = useState("");
  const [title, setTitle] = useState(f.kind === "Bakery" ? "Bakery bag" : "Surprise bag"), [contents, setContents] = useState("");
  const [count, setCount] = useState(5), [price, setPrice] = useState(99), [worth, setWorth] = useState(300), [hours, setHours] = useState(2);
  const [diet, setDiet] = useState<Bag["diet"]>("veg"), [busy, setBusy] = useState(false), [placeId, setPlaceId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const reload = useCallback(() => myBags().then((b) => { setBags(b); setNow(Date.now()); }, (e) => setError((e as Error).message)), []);
  useEffect(() => { void reload(); const id = setInterval(() => void reload(), 10_000); return () => clearInterval(id); }, [reload]);
  const place = places?.find((p) => p.id === placeId) ?? places?.find((p) => p.isDefault) ?? places?.[0];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError("");
    try {
      const now = Date.now();
      await postBag({ title, contents, diet, count, price, worth, pickupFrom: now, pickupUntil: now + hours * 3_600_000, ...(place ? { address: place.address, lat: place.lat, lng: place.lng, area: f.area } : {}) });
      setContents("");
      await reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const open = bags?.filter((b) => b.status === "open" && b.pickupUntil > now) ?? [];
  const past = bags?.filter((b) => !open.includes(b)) ?? [];
  return (
    <DonorShell title="Surprise bags" back={{ label: "Your impact", href: "/impact" }}>
      <div className={s.split}>
        <div className={s.page}>
          <section className={s.paper} aria-labelledby="sell-title">
            <h2 id="sell-title">Sell end-of-day food</h2>
            <p className={s.note}>Put food you can&rsquo;t sell today on sale at a discount. People nearby reserve a bag and pay you at pickup. <Link href="/bags">See what buyers see</Link>.</p>
            <form className={s.form} onSubmit={(e) => void submit(e)}>
              <label className={s.field}>Bag name<input required maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
              <label className={s.field}>What&rsquo;s usually inside<textarea required maxLength={200} value={contents} onChange={(e) => setContents(e.target.value)} placeholder="Breads, buns and a pastry or two" /></label>
              <div className={s.row2}>
                <label className={s.field}>Bags<input type="number" min={1} max={100} required value={count} onChange={(e) => setCount(Number(e.target.value))} /></label>
                <label className={s.field}>Food<select value={diet} onChange={(e) => setDiet(e.target.value as Bag["diet"])}><option value="veg">Veg</option><option value="egg">Contains egg</option><option value="nonveg">Non-veg</option></select></label>
                <label className={s.field}>Price (₹)<input type="number" min={0} max={2000} required value={price} onChange={(e) => setPrice(Number(e.target.value))} /></label>
                <label className={s.field}>Usually worth (₹)<input type="number" min={1} max={10000} required value={worth} onChange={(e) => setWorth(Number(e.target.value))} /></label>
              </div>
              <div className={s.field}>Pick up within
                <div className={s.chips} role="radiogroup" aria-label="Pick up within">
                  {UNTIL.map((u) => <button key={u.h} type="button" role="radio" aria-checked={hours === u.h} className={s.chip} data-on={hours === u.h} onClick={() => setHours(u.h)}>{u.label}</button>)}
                </div>
              </div>
              {places && places.length > 1 && (
                <label className={s.field}>Pick up from<select value={place?.id ?? ""} onChange={(e) => setPlaceId(e.target.value)}>{places.map((p) => <option key={p.id} value={p.id}>{p.label}: {p.address}</option>)}</select></label>
              )}
              {places && places.length === 0 && !f.address && <p className={s.note}>Add a pickup address in <Link href="/profile">your profile</Link> first.</p>}
              {error && <p className={s.error} role="alert">{error}</p>}
              <button type="submit" className={s.inkButton} disabled={busy}><ShoppingBag size={18} aria-hidden /> {busy ? "Putting on sale…" : `Put ${count} on sale at ₹${price}`}</button>
            </form>
          </section>
        </div>
        <div className={s.page}>
          <h2 className={s.heading}>On sale now</h2>
          {!bags ? <p className={s.note}>Loading…</p> : open.length === 0 ? <p className={s.note}>Nothing on sale. Bags you put up show here with who reserved them.</p> : open.map((b) => <MyBag key={b.id} bag={b} live onChange={reload} />)}
          {past.length > 0 && <><h2 className={s.heading}>Earlier</h2>{past.slice(0, 5).map((b) => <MyBag key={b.id} bag={b} live={false} onChange={reload} />)}</>}
        </div>
      </div>
    </DonorShell>
  );
}

function MyBag({ bag, live, onChange }: { bag: Bag & { holds: Hold[] }; live: boolean; onChange: () => void }) {
  const sold = bag.holds.filter((h) => h.status !== "cancelled").length;
  return (
    <article className={s.paper} aria-labelledby={`mine-${bag.id}`}>
      <h2 id={`mine-${bag.id}`}>{bag.title}</h2>
      <dl className={s.lines}>
        <div><dt>Reserved</dt><dd>{sold} of {bag.count}</dd></div>
        <div><dt>Price</dt><dd>₹{bag.price} (worth ₹{bag.worth})</dd></div>
        <div><dt>Pick up</dt><dd>{time(bag.pickupFrom)}–{time(bag.pickupUntil)}</dd></div>
      </dl>
      {bag.holds.length > 0 && (
        <ul className={s.holds}>{bag.holds.map((h) => <HoldRow key={h.id} bagId={bag.id} hold={h} onChange={onChange} />)}</ul>
      )}
      {live && <button type="button" className={s.outlineButton} onClick={() => void closeBag(bag.id).then(onChange)}>Stop selling</button>}
    </article>
  );
}

function HoldRow({ bagId, hold, onChange }: { bagId: string; hold: Hold; onChange: () => void }) {
  const [code, setCode] = useState(""), [error, setError] = useState("");
  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try { await bagCollected(bagId, hold.id, code); onChange(); } catch (err) { setError((err as Error).message); }
  };
  return (
    <li>
      <span><b>{hold.name}</b></span>
      <a href={`tel:+91${hold.phone}`}><Phone size={14} aria-hidden /> {hold.phone.slice(0, 5)} {hold.phone.slice(5)}</a>
      {hold.status === "collected" ? <span className={s.done}>Collected, paid at pickup</span> : (
        <form onSubmit={(e) => void check(e)}>
          <input aria-label={`${hold.name}'s pickup code`} inputMode="numeric" maxLength={4} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="Code" />
          <button type="submit" className={s.outlineButton} disabled={code.length !== 4}>Collected</button>
        </form>
      )}
      {error && <p className={s.error} role="alert">{error}</p>}
    </li>
  );
}
