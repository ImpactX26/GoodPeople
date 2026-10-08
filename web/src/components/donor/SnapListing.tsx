"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Check, MapPin, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/luna/api";
import { getProfile, type Session } from "@/lib/luna/auth";
import { ALLERGENS, inputTime, type ListingInput } from "@/lib/luna/listing";
import { farFrom, findDish, unitsFor, type BulkUnit } from "@/lib/luna/portions";
import { tripTime } from "@/lib/luna/trip";
import PhotoCanvas, { clearDraftPhoto, peekDraftPhoto } from "./PhotoCanvas";
import { clearRelist, peekRelist } from "./relist";
import { itemBody, servingsOfDraft, unitOf, type DraftItem } from "./draft";
import { ChoiceChips, Row, Stepper, ToggleChips } from "./Controls";
import DonorShell from "./DonorShell";
import AddressSheet from "./AddressSheet";
import { useAddresses } from "./useAddresses";
import s from "./donor.module.css";

type Category = DraftItem["category"];
const KINDS: { value: Category; label: string }[] = [
  { value: "cooked_meal", label: "Cooked meal" }, { value: "bakery", label: "Bakery" }, { value: "dairy", label: "Dairy & sweets" },
  { value: "packaged", label: "Packaged" }, { value: "beverages", label: "Drinks" }, { value: "raw_produce", label: "Raw produce" },
];
const COOKED = [{ value: "15", label: "15 min ago" }, { value: "30", label: "30 min" }, { value: "60", label: "1 h" }, { value: "120", label: "2 h" }, { value: "180", label: "3 h" }, { value: "exact", label: "Exact time" }];
const GOOD_FOR = [{ value: "", label: "Not sure" }, { value: "1", label: "1 h" }, { value: "2", label: "2 h" }, { value: "3", label: "3 h" }, { value: "4", label: "4 h" }, { value: "6", label: "6 h" }, { value: "8", label: "8 h+" }];
const WITHIN = [{ value: "30", label: "30 min" }, { value: "60", label: "1 hour" }, { value: "120", label: "2 hours" }, { value: "exact", label: "Set times" }];
const ALLERGEN_LABEL: Record<string, string> = { onion_garlic: "Onion / garlic" };
const label = (a: string) => ALLERGEN_LABEL[a] ?? a[0].toUpperCase() + a.slice(1);
const UNIT_WORD: Record<BulkUnit, string> = { kg: "kg", g: "g", L: "litres", ml: "ml", pcs: "pieces", plates: "plates", cups: "cups" };

let seq = 0;
function blankItem(photo = ""): DraftItem {
  return { key: `i${Date.now()}${seq++}`, photo, dish: "", category: "cooked_meal", diet: "veg", jain: false, halal: "unsure", spice: "medium", contains: [],
    mode: "bulk", count: 10, feeds: 4, amount: 5, unit: "kg", servings: null, cookedAt: Date.now() - 15 * 60_000, storage: "hot", temp: "", goodFor: "" };
}

type Step = "food" | "pickup" | "review";

/**
 * List food as a session: add each food the kitchen is giving away (photo, tags, how much, cooked and kept),
 * see Luna's servings recommendation in yellow and accept it or set the exact number, then end the session
 * with the shared pickup details and send it all at once.
 */
export default function SnapListing({ session }: { session: Session }) {
  const router = useRouter(), f = getProfile(session.role, session.phone)?.fields ?? {};
  const [relist] = useState(peekRelist);
  const [step, setStep] = useState<Step>("food");
  const [items, setItems] = useState<DraftItem[]>(() => relist?.items.slice(0, -1) ?? []);
  const [cur, setCur] = useState<DraftItem>(() => relist?.items.at(-1) ?? blankItem(peekDraftPhoto()));
  const [cookedPreset, setCookedPreset] = useState(relist ? "exact" : "15"), [cooked, setCooked] = useState(() => inputTime(cur.cookedAt));
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [within, setWithin] = useState("60"), [ready, setReady] = useState(() => inputTime(Date.now())), [collect, setCollect] = useState(() => inputTime(Date.now() + 60 * 60_000));
  const addresses = useAddresses(session.token);
  const [addressId, setAddressId] = useState<string | null>(null), [notesOverride, setNotesOverride] = useState<string | null>(null), [adding, setAdding] = useState(false);
  const chosen = addresses.list?.find(a => a.id === addressId) ?? addresses.list?.find(a => a.isDefault) ?? null;
  const notes = notesOverride ?? chosen?.notes ?? "";
  const [containers, setContainers] = useState<ListingInput["containers"]>(relist?.containers ?? ((f.containers as ListingInput["containers"]) || "donor_packs")), [declaration, setDeclaration] = useState(false);
  const [snap, setSnap] = useState<{ readyFrom: number; collectBy: number } | null>(null);
  const action = useRef<{ key: string; body: string } | null>(null), formRef = useRef<HTMLFormElement>(null);

  if (session.role !== "donor") return <DonorShell title="List food"><p className={s.note}>Sign in as a donor to post food.</p></DonorShell>;

  const set = <K extends keyof DraftItem>(k: K, v: DraftItem[K]) => setCur(c => ({ ...c, [k]: v }));
  const { rec, servings } = servingsOfDraft(cur);
  const sessionServings = items.reduce((n, d) => n + servingsOfDraft(d).servings, 0) + (step === "food" && cur.dish.trim() ? servings : 0);
  const cookedAtNow = () => (cookedPreset === "exact" ? new Date(cooked).getTime() : Date.now() - Number(cookedPreset) * 60_000);
  const match = findDish(cur.dish, cur.category), units = unitsFor(match);

  /** The food being edited, checked and finished; null with an error shown when something's missing. */
  const finishCurrent = (): DraftItem | null => {
    setError("");
    if (!cur.photo) { setError("Add a photo of this food first."); return null; }
    if (!cur.dish.trim()) { setError("Say what this food is."); return null; }
    if (cur.jain && cur.contains.some(a => ["egg", "seafood", "onion_garlic"].includes(a))) { setError("Jain food can't contain egg, seafood, onion or garlic. Untick Jain or the ingredient."); return null; }
    if (servings < 1) { setError("That amount serves no one. Check the quantity."); return null; }
    if (cookedPreset === "exact" && !cooked) { setError("Say when it was cooked."); return null; }
    return { ...cur, cookedAt: cookedAtNow() };
  };
  const addAnother = () => {
    const done = finishCurrent(); if (!done) return;
    setItems(list => [...list, done]);
    setCur(blankItem()); setCookedPreset("15");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const endFoods = () => {
    // the food on screen counts if it's filled in; an empty one is simply not added
    if (cur.dish.trim() || cur.photo) { const done = finishCurrent(); if (!done) return; setItems(list => [...list, done]); setCur(blankItem()); }
    else if (!items.length) return setError("Add at least one food.");
    setError(""); setStep("pickup"); window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const editItem = (key: string) => {
    const it = items.find(i => i.key === key); if (!it) return;
    setItems(list => list.filter(i => i.key !== key));
    if (cur.dish.trim() && cur.photo) setItems(list => [...list, { ...cur, cookedAt: cookedAtNow() }]);
    setCur(it); setCookedPreset("exact"); setCooked(inputTime(it.cookedAt)); setStep("food");
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const times = () => {
    const now = Date.now();
    return { readyFrom: within === "exact" ? new Date(ready).getTime() : now, collectBy: within === "exact" ? new Date(collect).getTime() : now + Number(within) * 60_000 };
  };
  const body = () => ({
    items: items.map(itemBody), ...times(), containers,
    pickup: { name: f.org || f.name || "Pickup", address: chosen?.address ?? "", area: f.area || "Bengaluru", notes, lat: chosen?.lat ?? NaN, lng: chosen?.lng ?? NaN },
    contactName: f.name || f.org, contactPhone: session.phone, declarationAccepted: declaration,
  });
  const toReview = () => {
    setError("");
    if (!chosen) return setError("Add a pickup address: tap “New address” under Pickup.");
    if (!formRef.current?.reportValidity()) return;
    if (!declaration) return setError("Tick the food-safety confirmation to continue.");
    setSnap(times()); setStep("review"); window.scrollTo({ top: 0, behavior: "smooth" });
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
  const total = items.reduce((n, d) => n + servingsOfDraft(d).servings, 0);
  const t = snap ?? { readyFrom: 0, collectBy: 0 };
  const title = step === "review" ? "Check and send" : step === "pickup" ? "Pickup" : items.length ? `Food ${items.length + 1}` : "List food";
  const back = step === "review" ? { label: "Edit", onClick: () => setStep("pickup") } : step === "pickup" ? { label: "Foods", onClick: () => setStep("food") } : { label: "Home", href: "/donor" };

  return (
    <DonorShell title={title} back={back}>
      <form ref={formRef} className={s.compose} onSubmit={e => { e.preventDefault(); if (step === "food") endFoods(); else if (step === "pickup") toReview(); else void submit(); }} noValidate={step !== "pickup"}>
        <div className={s.composeMedia}>
          {step === "food"
            ? <PhotoCanvas key={cur.key} photo={cur.photo} onPhoto={p => set("photo", p)} onError={setError} tall alt={cur.dish || "Your food photo"} />
            : <SessionTray items={items} onEdit={editItem} onRemove={key => setItems(list => list.filter(i => i.key !== key))} onAdd={() => { setStep("food"); }} />}
        </div>

        <div className={s.composeBody}>
          {relist && step === "food" && <p className={s.relistNote} role="status"><b>Relisting.</b> The fixes from the photo check are filled in. Check each food, then send.</p>}
          {step === "food" && items.length > 0 && (
            <SessionTray items={items} onEdit={editItem} onRemove={key => setItems(list => list.filter(i => i.key !== key))} compact />
          )}

          {step === "review" ? (
            <section className={s.reviewTicket} aria-label="Your donation">
              <h2 className={s.reviewTitle}>{items.length === 1 ? items[0].dish : `${items.length} foods`}</h2>
              <ul className={s.reviewItems}>
                {items.map(d => { const v = servingsOfDraft(d); return (
                  <li key={d.key}><b>{d.dish}</b><span>{v.servings} servings · {d.diet === "veg" ? (d.jain ? "Veg · Jain" : "Veg") : d.diet === "egg" ? "Veg with egg" : "Non-veg"} · cooked {tripTime(d.cookedAt)}, {d.storage === "hot" ? "kept hot" : d.storage === "fridge" ? "in a fridge" : "room temp"}{d.goodFor ? ` · good for about ${d.goodFor} h` : ""}</span></li>
                ); })}
              </ul>
              <dl className={s.leaders}>
                <div><dt>Feeds</dt><dd>about {total} people</dd></div>
                <div><dt>Collect</dt><dd>{tripTime(t.readyFrom)}–{tripTime(t.collectBy)}</dd></div>
                <div><dt>Pickup</dt><dd>{chosen ? `${chosen.label} · ${chosen.address}` : ""}</dd></div>
                <div><dt>Boxes</dt><dd>{containers === "donor_packs" ? "Packed and ready" : "Partner brings containers"}</dd></div>
              </dl>
              <p className={s.note}>When you send it, Luna checks every food, finds the right NGOs (more than one if needed) and tells you exactly what to pack for each delivery partner. One pickup code works for all of them.</p>
            </section>
          ) : step === "pickup" ? (
            <>
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
          ) : (
            <>
              <p className={s.mediaNote}>Luna’s food check looks at this photo, the cooking time and how it was kept, then grades it.</p>
              <Row title="What is it?">
                <input className={s.bigInput} maxLength={120} value={cur.dish} onChange={e => set("dish", e.target.value)} placeholder="e.g. Veg biryani, Dal, Payasam" aria-label="Dish name" />
                {cur.dish.trim() && match.how === "fuzzy" && match.dish && match.dish.name.toLowerCase() !== cur.dish.trim().toLowerCase() && (
                  <button type="button" className={s.suggest} onClick={() => set("dish", match.dish!.name)}>Did you mean <b>{match.dish.name}</b>?</button>
                )}
                <ChoiceChips label="Kind of food" name="kind" value={cur.category} onChange={v => set("category", v)} options={KINDS} />
              </Row>

              <Row title="Diet">
                <ChoiceChips label="Diet" name="diet" value={cur.diet} onChange={v => setCur(c => ({ ...c, diet: v, jain: v === "veg" && c.jain }))}
                  options={[{ value: "veg", label: "Veg" }, { value: "egg", label: "Veg + egg" }, { value: "nonveg", label: "Non-veg" }]} />
                {cur.diet === "veg" && (
                  <button type="button" className={s.chip} aria-pressed={cur.jain} onClick={() => set("jain", !cur.jain)}>
                    <span>Jain</span><small>no onion, garlic, root veg</small>
                  </button>
                )}
                {cur.diet === "nonveg" && (
                  <ChoiceChips label="Halal" name="halal" value={cur.halal} onChange={v => set("halal", v)}
                    options={[{ value: "yes", label: "Halal" }, { value: "no", label: "Not halal" }, { value: "unsure", label: "Not sure" }]} />
                )}
                <ChoiceChips label="Spice" name="spice" value={cur.spice} onChange={v => set("spice", v)}
                  options={[{ value: "mild", label: "Mild" }, { value: "medium", label: "Medium" }, { value: "hot", label: "Spicy" }]} />
              </Row>

              <Row title="Contains" aside={<span className={s.rowHint}>Tick every allergen</span>}>
                {match.dish?.contains?.length ? (
                  <p className={s.note}>{match.dish.name} usually has {match.dish.contains.map(label).join(", ").toLowerCase()}. <button type="button" className={s.textButton} onClick={() => set("contains", [...new Set([...cur.contains, ...match.dish!.contains!])])}>Tick these</button></p>
                ) : null}
                <ToggleChips label="Contains" values={cur.contains} onChange={v => set("contains", v)} options={ALLERGENS.map(a => ({ value: a, label: label(a) }))} />
              </Row>

              <Row title="How much?">
                <ChoiceChips label="How it's packed" name="mode" value={cur.mode} onChange={v => setCur(c => ({ ...c, mode: v, servings: null }))}
                  options={[{ value: "bulk", label: "Loose", hint: "vessel, tray, kg / litres" }, { value: "per_person_pack", label: "One meal per box" }, { value: "shared_pack", label: "Shared boxes" }]} />
                {cur.mode === "bulk" ? (
                  <div className={s.steppers}>
                    <Stepper label="Amount" value={cur.amount} onChange={v => setCur(c => ({ ...c, amount: v, servings: null }))} min={1} max={500} unit={UNIT_WORD[unitOf(cur)]} />
                    <ChoiceChips label="Unit" name="unit" value={unitOf(cur)} onChange={v => setCur(c => ({ ...c, unit: v, servings: null }))}
                      options={units.map(u => ({ value: u, label: UNIT_WORD[u] }))} />
                  </div>
                ) : (
                  <div className={s.steppers}>
                    <Stepper label="Number of boxes" value={cur.count} onChange={v => setCur(c => ({ ...c, count: v, servings: null }))} min={1} max={2000} unit={cur.count === 1 ? "box" : "boxes"} />
                    {cur.mode === "shared_pack" && <Stepper label="People fed by each box" value={cur.feeds} onChange={v => setCur(c => ({ ...c, feeds: v, servings: null }))} min={1} max={50} unit="feeds" />}
                  </div>
                )}
                <Recommendation rec={rec} servings={servings} custom={cur.servings !== null} onAccept={() => set("servings", null)} onChange={v => set("servings", v)} />
              </Row>

              <Row title="Cooked">
                <ChoiceChips label="When it was cooked" name="cooked" value={cookedPreset} onChange={setCookedPreset} options={COOKED} />
                {cookedPreset === "exact" && <label className={s.field}><span>Cooked at</span><input type="datetime-local" value={cooked} onChange={e => setCooked(e.target.value)} /></label>}
                <ChoiceChips label="How it has been kept" name="storage" value={cur.storage} onChange={v => set("storage", v)}
                  options={[{ value: "hot", label: "Kept hot", hint: "60°C or more" }, { value: "room", label: "Room temp" }, { value: "fridge", label: "In a fridge", hint: "5°C or less" }]} />
                <label className={s.field} data-inline><span>Thermometer reading <small>(optional)</small></span>
                  <span className={s.unitInput}><input type="number" inputMode="decimal" step="0.5" min={-30} max={120} value={cur.temp} onChange={e => set("temp", e.target.value)} placeholder="—" /><b>°C</b></span>
                </label>
              </Row>
              <Row title="Stays good for">
                <ChoiceChips label="How long it stays good from now" name="goodfor" value={cur.goodFor} onChange={v => set("goodFor", v)} options={GOOD_FOR} />
                <p className={s.note}>Your best guess, from now. Luna never promises it stays good longer than you say, and uses its food-safety rules when they say sooner.</p>
              </Row>

              <button type="button" className={s.addFood} onClick={addAnother}><Plus size={18} aria-hidden /> Add another food to this session</button>
            </>
          )}
        </div>

        <div className={s.actionBar}>
          {error && <p className={s.barError} role="alert">{error}</p>}
          <div className={s.barRow}>
            <p className={s.servings} aria-live="polite"><b>{step === "food" ? sessionServings : total}</b><span>servings{items.length ? ` · ${items.length + (step === "food" && cur.dish.trim() ? 1 : 0)} foods` : ""}</span></p>
            <button className={s.primary} disabled={busy}>
              {step === "review" ? (busy ? "Sending…" : "Send to Luna") : step === "pickup" ? "Review" : "Done adding food"} <ArrowRight size={18} aria-hidden />
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

/** Luna's recommendation in yellow: "Can serve about N people". Accept it, or set the exact number. */
function Recommendation({ rec, servings, custom, onAccept, onChange }: {
  rec: ReturnType<typeof servingsOfDraft>["rec"]; servings: number; custom: boolean; onAccept: () => void; onChange: (n: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const far = custom && farFrom(servings, rec.servings);
  return (
    <div className={s.reco} data-custom={custom}>
      <p className={s.recoLine}>
        <b>{custom ? `You set ${servings} servings` : `Can serve ${rec.estimate ? "about " : ""}${rec.servings} ${rec.servings === 1 ? "person" : "people"}`}</b>
        <span>{rec.why}{rec.role === "extra" ? " · counted as a sweet or extra, not a meal" : rec.role === "staple" ? " · a base like rice or roti; it makes a meal with a curry" : rec.role === "side" ? " · a curry or side; it makes a meal with rice or roti" : ""}</span>
      </p>
      {far && <p className={s.recoWarn}>That’s quite different from the {rec.servings} we’d expect. We’ll use your number.</p>}
      {editing ? (
        <div className={s.recoEdit}>
          <Stepper label="Exact servings" value={servings} onChange={onChange} min={1} max={5000} unit="servings" />
          <button type="button" className={s.textButton} onClick={() => setEditing(false)}>Done</button>
        </div>
      ) : (
        <div className={s.recoActions}>
          {custom
            ? <button type="button" className={s.ghost} onClick={onAccept}>Use Luna’s {rec.servings}</button>
            : <span className={s.recoOk}><Check size={16} strokeWidth={3} aria-hidden /> Using this</span>}
          <button type="button" className={s.ghost} onClick={() => { if (!custom) onChange(rec.servings); setEditing(true); }}><Pencil size={14} aria-hidden /> Set exact number</button>
        </div>
      )}
    </div>
  );
}

/** The foods added to this session so far. */
function SessionTray({ items, onEdit, onRemove, onAdd, compact = false }: { items: DraftItem[]; onEdit: (key: string) => void; onRemove: (key: string) => void; onAdd?: () => void; compact?: boolean }) {
  return (
    <section className={s.tray} data-compact={compact} aria-label="Foods in this session">
      <h2>In this session · {items.length} {items.length === 1 ? "food" : "foods"}</h2>
      <ul>
        {items.map(d => { const v = servingsOfDraft(d); return (
          <li key={d.key}>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local photo data URL */}
            {d.photo && <img src={d.photo} alt="" />}
            <span><b>{d.dish}</b>{v.servings} servings</span>
            <button type="button" className={s.iconButton} onClick={() => onEdit(d.key)} aria-label={`Edit ${d.dish}`}><Pencil size={16} aria-hidden /></button>
            <button type="button" className={s.iconButton} onClick={() => onRemove(d.key)} aria-label={`Remove ${d.dish}`}><Trash2 size={16} aria-hidden /></button>
          </li>
        ); })}
      </ul>
      {onAdd && <button type="button" className={s.addFood} onClick={onAdd}><Plus size={18} aria-hidden /> Add another food</button>}
      {!compact && !onAdd && <p className={s.note}><ArrowLeft size={14} aria-hidden /> Go back to add more food.</p>}
    </section>
  );
}
