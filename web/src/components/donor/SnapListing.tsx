"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, MapPin, Plus } from "lucide-react";
import { api } from "@/lib/luna/api";
import { getProfile, type Session } from "@/lib/luna/auth";
import { ALLERGENS, inputTime, type ListingInput } from "@/lib/luna/listing";
import { tripTime } from "@/lib/luna/trip";
import PhotoCanvas, { clearDraftPhoto, peekDraftPhoto } from "./PhotoCanvas";
import { clearRelist, peekRelist } from "./relist";
import { ChoiceChips, Row, Stepper, ToggleChips } from "./Controls";
import DonorShell from "./DonorShell";
import AddressSheet from "./AddressSheet";
import { useAddresses } from "./useAddresses";
import s from "./donor.module.css";

type Category = NonNullable<ListingInput["category"]>;
const KINDS: { value: Category; label: string }[] = [
  { value: "cooked_meal", label: "Cooked meal" }, { value: "bakery", label: "Bakery" }, { value: "dairy", label: "Dairy & sweets" },
  { value: "packaged", label: "Packaged" }, { value: "beverages", label: "Drinks" }, { value: "raw_produce", label: "Raw produce" },
];
const COOKED = [{ value: "15", label: "15 min ago" }, { value: "30", label: "30 min" }, { value: "60", label: "1 h" }, { value: "120", label: "2 h" }, { value: "180", label: "3 h" }, { value: "exact", label: "Exact time" }];
const WITHIN = [{ value: "30", label: "30 min" }, { value: "60", label: "1 hour" }, { value: "120", label: "2 hours" }, { value: "exact", label: "Set times" }];
const ALLERGEN_LABEL: Record<string, string> = { onion_garlic: "Onion / garlic" };
const label = (a: string) => ALLERGEN_LABEL[a] ?? a[0].toUpperCase() + a.slice(1);

export default function SnapListing({ session }: { session: Session }) {
  const router = useRouter(), f = getProfile(session.role, session.phone)?.fields ?? {};
  const [relist] = useState(peekRelist);
  const [photo, setPhoto] = useState(peekDraftPhoto), [error, setError] = useState(""), [busy, setBusy] = useState(false), [review, setReview] = useState(false);
  const [dish, setDish] = useState(relist?.dish ?? ""), [category, setCategory] = useState<Category>(relist?.category ?? "cooked_meal");
  const [diet, setDiet] = useState<ListingInput["diet"]>(relist?.diet ?? "veg"), [jain, setJain] = useState(relist?.jain ?? false), [halal, setHalal] = useState<ListingInput["halal"]>(relist?.halal ?? "unsure");
  const [spice, setSpice] = useState<ListingInput["spice"]>(relist?.spice ?? "medium"), [contains, setContains] = useState<string[]>(relist?.contains ?? []);
  const [mode, setMode] = useState<ListingInput["entryMode"]>(relist?.entryMode ?? "per_person_pack"), [count, setCount] = useState(relist?.count ?? 10), [feeds, setFeeds] = useState(relist && relist.entryMode === "shared_pack" ? relist.feedsEach : 4);
  // a relisting keeps the real cooking time: the food didn't get fresher
  const [cookedPreset, setCookedPreset] = useState(relist ? "exact" : "15"), [cooked, setCooked] = useState(() => inputTime(relist?.cookedAt ?? Date.now() - 15 * 60_000));
  const [storage, setStorage] = useState<ListingInput["storage"]>(relist?.storage ?? "hot"), [temp, setTemp] = useState(relist?.temperatureC != null ? String(relist.temperatureC) : "");
  const [within, setWithin] = useState("60"), [ready, setReady] = useState(() => inputTime(Date.now())), [collect, setCollect] = useState(() => inputTime(Date.now() + 60 * 60_000));
  const addresses = useAddresses(session.token);
  const [addressId, setAddressId] = useState<string | null>(null), [notesOverride, setNotesOverride] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const chosen = addresses.list?.find(a => a.id === addressId) ?? addresses.list?.find(a => a.isDefault) ?? null;
  const notes = notesOverride ?? chosen?.notes ?? "";
  const [containers, setContainers] = useState<ListingInput["containers"]>(relist?.containers ?? ((f.containers as ListingInput["containers"]) || "donor_packs")), [declaration, setDeclaration] = useState(false);
  const [snap, setSnap] = useState<{ cookedAt: number; readyFrom: number; collectBy: number } | null>(null);
  const action = useRef<{ key: string; body: string } | null>(null), formRef = useRef<HTMLFormElement>(null);

  if (session.role !== "donor") return <DonorShell title="List food"><p className={s.note}>Sign in as a donor to post food.</p></DonorShell>;

  const servings = count * (mode === "shared_pack" ? feeds : 1);
  const times = () => {
    const now = Date.now();
    const cookedAt = cookedPreset === "exact" ? new Date(cooked).getTime() : now - Number(cookedPreset) * 60_000;
    const readyFrom = within === "exact" ? new Date(ready).getTime() : now;
    const collectBy = within === "exact" ? new Date(collect).getTime() : now + Number(within) * 60_000;
    return { cookedAt, readyFrom, collectBy };
  };
  const body = (): ListingInput => ({ dish: dish.trim(), category, diet, jain: diet === "veg" && jain, halal, spice, contains,
    entryMode: mode, count, feedsEach: mode === "shared_pack" ? feeds : 1, photo, ...times(), storage,
    temperatureC: temp.trim() === "" ? null : Number(temp), containers,
    pickup: { name: f.org || f.name || "Pickup", address: chosen?.address ?? "", area: f.area || "Bengaluru", notes, lat: chosen?.lat ?? NaN, lng: chosen?.lng ?? NaN },
    contactName: f.name || f.org, contactPhone: session.phone, declarationAccepted: declaration });

  const toReview = () => {
    setError("");
    if (!photo) return setError("Add a photo of the food first.");
    if (!dish.trim()) return setError("Tell us what the food is.");
    if (jain && contains.some(a => ["egg", "seafood", "onion_garlic"].includes(a))) return setError("Jain food can't contain egg, seafood, onion or garlic. Untick Jain or the ingredient.");
    if (!chosen) return setError("Add a pickup address: tap “New address” under Pickup.");
    if (!formRef.current?.reportValidity()) return;
    if (!declaration) return setError("Tick the food-safety confirmation to continue.");
    setSnap(times()); setReview(true); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const submit = async () => {
    setBusy(true); setError("");
    const payload = JSON.stringify(relist ? { ...body(), replaces: relist.from } : body());
    if (!action.current || action.current.body !== payload) action.current = { key: crypto.randomUUID(), body: payload };
    try {
      const result = await api<{ listingUrl: string }>("/listings", { method: "POST", token: session.token, headers: { "Idempotency-Key": action.current.key }, body: payload });
      clearDraftPhoto(); clearRelist();
      router.push(result.listingUrl);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  const t = snap ?? { cookedAt: 0, readyFrom: 0, collectBy: 0 };

  return (
    <DonorShell title={review ? "Check and send" : "List food"} back={review ? { label: "Edit", onClick: () => setReview(false) } : { label: "Home", href: "/donor" }}>
      <form ref={formRef} className={s.compose} onSubmit={e => { e.preventDefault(); if (review) void submit(); else toReview(); }} noValidate={review}>
        <div className={s.composeMedia}>
          <PhotoCanvas photo={photo} onPhoto={setPhoto} onError={setError} tall alt={dish || "Your food photo"} />
        </div>

        <div className={s.composeBody}>
          {relist && !review && <p className={s.relistNote} role="status"><b>Relisting.</b> The fixes from the photo check are filled in. Check them, then send.</p>}
          {review ? (
            <section className={s.reviewTicket} aria-label="Your donation">
              <h2 className={s.reviewTitle}>{dish}</h2>
              <dl className={s.leaders}>
                <div><dt>Feeds</dt><dd>{servings} {servings === 1 ? "person" : "people"}</dd></div>
                <div><dt>Packed</dt><dd>{mode === "shared_pack" ? `${count} boxes × ${feeds}` : `${count} meal boxes`}</dd></div>
                <div><dt>Kind</dt><dd>{KINDS.find(k => k.value === category)?.label}</dd></div>
                <div><dt>Diet</dt><dd>{diet === "veg" ? (jain ? "Veg · Jain" : "Veg") : diet === "egg" ? "Veg with egg" : `Non-veg${halal === "yes" ? " · Halal" : ""}`}</dd></div>
                <div><dt>Contains</dt><dd>{contains.length ? contains.map(label).join(", ") : "Nothing listed"}</dd></div>
                <div><dt>Cooked</dt><dd>{tripTime(t.cookedAt)} · {storage === "hot" ? "kept hot" : storage === "fridge" ? "in a fridge" : "room temp"}{temp ? ` · ${temp}°C` : ""}</dd></div>
                <div><dt>Collect</dt><dd>{tripTime(t.readyFrom)}–{tripTime(t.collectBy)}</dd></div>
                <div><dt>Pickup</dt><dd>{chosen ? `${chosen.label} · ${chosen.address}` : ""}</dd></div>
                <div><dt>Boxes</dt><dd>{containers === "donor_packs" ? "Packed and ready" : "Partner brings containers"}</dd></div>
              </dl>
              <p className={s.note}>When you send it, Luna’s food check grades it and finds an NGO. Your first listing is also checked by a Luna team member.</p>
            </section>
          ) : (
            <>
              <p className={s.mediaNote}>Luna’s food check looks at this photo, the cooking time and how it was kept, then grades it.</p>
              <Row title="What is it?">
                <input className={s.bigInput} required maxLength={120} value={dish} onChange={e => setDish(e.target.value)} placeholder="e.g. Vegetable biryani" aria-label="Dish name" />
                <ChoiceChips label="Kind of food" name="kind" value={category} onChange={setCategory} options={KINDS} />
              </Row>

              <Row title="Diet">
                <ChoiceChips label="Diet" name="diet" value={diet} onChange={v => { setDiet(v); if (v !== "veg") setJain(false); }}
                  options={[{ value: "veg", label: "Veg" }, { value: "egg", label: "Veg + egg" }, { value: "nonveg", label: "Non-veg" }]} />
                {diet === "veg" && (
                  <button type="button" className={s.chip} aria-pressed={jain} onClick={() => setJain(!jain)}>
                    <span>Jain</span><small>no onion, garlic, root veg</small>
                  </button>
                )}
                {diet === "nonveg" && (
                  <ChoiceChips label="Halal" name="halal" value={halal} onChange={setHalal}
                    options={[{ value: "yes", label: "Halal" }, { value: "no", label: "Not halal" }, { value: "unsure", label: "Not sure" }]} />
                )}
                <ChoiceChips label="Spice" name="spice" value={spice} onChange={setSpice}
                  options={[{ value: "mild", label: "Mild" }, { value: "medium", label: "Medium" }, { value: "hot", label: "Spicy" }]} />
              </Row>

              <Row title="Contains" aside={<span className={s.rowHint}>Tick every allergen</span>}>
                <ToggleChips label="Contains" values={contains} onChange={setContains} options={ALLERGENS.map(a => ({ value: a, label: label(a) }))} />
              </Row>

              <Row title="How much?">
                <ChoiceChips label="Packing" name="pack" value={mode} onChange={setMode}
                  options={[{ value: "per_person_pack", label: "One meal per box" }, { value: "shared_pack", label: "Shared boxes" }]} />
                <div className={s.steppers}>
                  <Stepper label="Number of boxes" value={count} onChange={setCount} min={1} max={200} unit={count === 1 ? "box" : "boxes"} />
                  {mode === "shared_pack" && <Stepper label="People fed by each box" value={feeds} onChange={setFeeds} min={1} max={50} unit="feeds" />}
                </div>
              </Row>

              <Row title="Cooked">
                <ChoiceChips label="When it was cooked" name="cooked" value={cookedPreset} onChange={setCookedPreset} options={COOKED} />
                {cookedPreset === "exact" && <label className={s.field}><span>Cooked at</span><input type="datetime-local" required value={cooked} onChange={e => setCooked(e.target.value)} /></label>}
                <ChoiceChips label="How it has been kept" name="storage" value={storage} onChange={setStorage}
                  options={[{ value: "hot", label: "Kept hot", hint: "60°C or more" }, { value: "room", label: "Room temp" }, { value: "fridge", label: "In a fridge", hint: "5°C or less" }]} />
                <label className={s.field} data-inline><span>Thermometer reading <small>(optional)</small></span>
                  <span className={s.unitInput}><input type="number" inputMode="decimal" step="0.5" min={-30} max={120} value={temp} onChange={e => setTemp(e.target.value)} placeholder="—" /><b>°C</b></span>
                </label>
              </Row>

              <Row title="Pickup">
                <ChoiceChips label="Collect within" name="within" value={within} onChange={setWithin} options={WITHIN} />
                {within === "exact" && (
                  <div className={s.twoUp}>
                    <label className={s.field}><span>Ready from</span><input type="datetime-local" required value={ready} onChange={e => setReady(e.target.value)} /></label>
                    <label className={s.field}><span>Collect by</span><input type="datetime-local" required value={collect} onChange={e => setCollect(e.target.value)} /></label>
                  </div>
                )}
                <div className={s.places} role="radiogroup" aria-label="Pickup address">
                  {addresses.list === null && <p className={s.note}>{addresses.error || "Loading your addresses…"}</p>}
                  {addresses.list?.map(a => (
                    <label key={a.id} className={s.place} data-on={chosen?.id === a.id}>
                      <input type="radio" className={s.chipRadio} name="pickup-address" checked={chosen?.id === a.id}
                        onChange={() => { setAddressId(a.id); setNotesOverride(null); }} />
                      <MapPin size={18} aria-hidden />
                      <span><b>{a.label}</b>{a.address}</span>
                    </label>
                  ))}
                  {addresses.list && addresses.list.length < addresses.max && (
                    <button type="button" className={s.placeAdd} onClick={() => setAdding(true)}><Plus size={18} aria-hidden /> New address</button>
                  )}
                </div>
                {chosen && (
                  <label className={s.field}><span>Instructions for the partner <small>(optional)</small></span>
                    <textarea maxLength={200} value={notes} onChange={e => setNotesOverride(e.target.value)} placeholder="e.g. Use the kitchen entrance" />
                  </label>
                )}
                <Link href="/profile" className={s.textLink}>Manage saved addresses</Link>
                <ChoiceChips label="Containers" name="containers" value={containers} onChange={setContainers}
                  options={[{ value: "donor_packs", label: "Packed, ready to carry" }, { value: "partner_brings", label: "Partner brings boxes" }]} />
              </Row>

              <label className={s.declare}>
                <input type="checkbox" checked={declaration} onChange={e => setDeclaration(e.target.checked)} />
                <span className={s.box} aria-hidden>{declaration && <Check size={16} strokeWidth={3} />}</span>
                <span>I confirm this food was handled safely and the ingredients, quantities and times are correct.</span>
              </label>
            </>
          )}
        </div>

        <div className={s.actionBar}>
          {error && <p className={s.barError} role="alert">{error}</p>}
          <div className={s.barRow}>
            <p className={s.servings} aria-live="polite"><b>{servings}</b><span>{servings === 1 ? "serving" : "servings"}</span></p>
            {review && <button type="button" className={s.ghost} onClick={() => setReview(false)} disabled={busy}><ArrowLeft size={18} aria-hidden /> Edit</button>}
            <button className={s.primary} disabled={busy}>
              {review ? (busy ? "Sending…" : "Send to Luna") : "Review"} <ArrowRight size={18} aria-hidden />
            </button>
          </div>
        </div>
      </form>
      <AddressSheet token={session.token} open={adding} initial={null} canDelete={false}
        onSave={async a => { const list = await addresses.save(a); setAddressId(list.find(x => x.id === a.id)?.id ?? null); setNotesOverride(null); setAdding(false); }}
        onClose={() => setAdding(false)} />
    </DonorShell>
  );
}
