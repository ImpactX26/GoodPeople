"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Crosshair, MapPin } from "lucide-react";
import type { Session } from "@/lib/luna/auth";
import { AREAS } from "@/lib/luna/roles";
import { AREA_COORDS, CATEGORIES, getNgo, ngoIdFor, saveNgo, type Ngo, type NgoStatus, type Urgency } from "@/lib/luna/ngoAgent";
import { ChoiceChips, Row, Stepper, ToggleChips } from "@/components/donor/Controls";
import SpotSheet from "./SpotSheet";
import d from "@/components/donor/donor.module.css";
import s from "./ngo.module.css";

const DIETARY = [
  { value: "vegetarian_only", label: "Veg only" },
  { value: "jain_only", label: "Jain / no onion-garlic" },
  { value: "halal_only", label: "Halal" },
  { value: "nut_free", label: "Nut-free" },
];
export const URGENCIES: { value: Urgency; label: string; hint: string }[] = [
  { value: "LOW", label: "Low", hint: "Can wait" },
  { value: "MEDIUM", label: "Medium", hint: "Would help" },
  { value: "HIGH", label: "High", hint: "Need it today" },
  { value: "CRITICAL", label: "Critical", hint: "People will go hungry" },
];

interface Form {
  name: string; area: string; address: string; latitude: number; longitude: number; pinned: boolean;
  mealsNeeded: number; urgency: Urgency; dailyCapacity: number; serviceKm: number; start: string; end: string;
  people: string; categories: string[]; dietary: string[];
}

const areaOf = (n: Ngo) => n.address?.split(",").map(p => p.trim()).find(p => p in AREA_COORDS) ?? "";
function blank(org?: string, area?: string): Form {
  const a = area && AREA_COORDS[area] ? area : AREAS[0];
  return { name: org ?? "", area: a, address: "", ...AREA_COORDS[a], pinned: false, mealsNeeded: 100, urgency: "HIGH", dailyCapacity: 300,
    serviceKm: 8, start: "08:00", end: "21:00", people: "", categories: ["cooked_meal", "bakery", "packaged"], dietary: [] };
}
function fromNgo(n: Ngo): Form {
  return { name: n.name, area: areaOf(n) || AREAS[0], address: (n.address ?? "").replace(/,\s*Bengaluru$/, ""), latitude: n.location.latitude,
    longitude: n.location.longitude,
    pinned: !Object.values(AREA_COORDS).some(c => c.latitude === n.location.latitude && c.longitude === n.location.longitude), mealsNeeded: n.current_demand.meals_needed, urgency: n.current_demand.urgency,
    dailyCapacity: n.capacity.daily_meal_capacity, serviceKm: Math.round(n.service_area_km), start: n.receiving_hours.start, end: n.receiving_hours.end,
    people: n.population_served ? String(n.population_served) : "", categories: n.accepted_categories, dietary: n.dietary_constraints };
}

/**
 * The NGO's default listing: what Luna uses every day unless today's listing changes it.
 * Phone first: one column of printed rows, steppers instead of typed numbers, the map for the address,
 * and one save action in the thumb zone.
 */
export default function NgoListingForm({ session, fields, onSaved }: { session: Session; fields: Record<string, string>; onSaved?: (n: Ngo) => void }) {
  const myId = ngoIdFor(session.phone);
  const [mine, setMine] = useState<Ngo | null | undefined>(undefined), [form, setForm] = useState<Form | null>(null);
  const [problem, setProblem] = useState(""), [notice, setNotice] = useState(""), [saving, setSaving] = useState(false), [mapOpen, setMapOpen] = useState(false);

  useEffect(() => {
    getNgo(myId).then(n => { setMine(n); setForm(n ? fromNgo(n) : blank(fields.org, fields.area)); })
      .catch((e: Error) => { setProblem(e.message); setMine(null); setForm(blank(fields.org, fields.area)); });
  }, [myId, fields.org, fields.area]);

  if (!form) return <p className={d.loading}>Loading your listing…</p>;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => (f ? { ...f, [k]: v } : f));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    setProblem(""); setNotice("");
    if (!form.name.trim()) return setProblem("Add your organisation name.");
    if (form.categories.length === 0) return setProblem("Pick at least one kind of food you accept.");
    if (form.start >= form.end) return setProblem("“Receive until” has to be later than “Receive from”.");
    const address = form.address.trim(), withArea = address.includes(form.area) ? address : [address, form.area].filter(Boolean).join(", ");
    const ngo: Ngo = {
      // keep what the agent has learnt about us, and today's listing
      ...(mine ?? { active_donations: 0, donations_received_today: 0, reliability: { source: "none" }, history: { category_stats: {} }, status: "ACTIVE" as NgoStatus }),
      ngo_id: myId, name: form.name.trim(), address: `${withArea}, Bengaluru`,
      location: { latitude: form.latitude, longitude: form.longitude }, service_area_km: form.serviceKm,
      capacity: { daily_meal_capacity: form.dailyCapacity, available_capacity_today: form.dailyCapacity },
      current_demand: { meals_needed: form.mealsNeeded, urgency: form.urgency },
      food_preferences: form.categories, accepted_categories: form.categories, dietary_constraints: form.dietary,
      receiving_hours: { start: form.start, end: form.end }, population_served: form.people ? Math.max(0, Math.round(Number(form.people) || 0)) : null,
      contact: { phone: `+91${session.phone}`, webhook_url: null }, data_source: "LIVE",
    };
    delete ngo.today_active;
    setSaving(true);
    try {
      const saved = await saveNgo(ngo);
      setMine(saved); onSaved?.(saved);
      setNotice(mine ? "Default listing saved. Luna uses it every day unless you set today’s listing." : "You’re listed. Luna can now offer you food.");
    } catch (err) { setProblem((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <form className={s.listing} onSubmit={submit} noValidate aria-labelledby="listing-title">
      <header className={s.listingHead}>
        <h2 id="listing-title">{mine ? "Default listing" : "List your NGO"}</h2>
        <p>What Luna uses every day to offer you food. To change just today, use <b>Today</b> on your home screen.</p>
      </header>

      <Row title="Organisation name">
        <input className={d.bigInput} value={form.name} maxLength={120} onChange={e => set("name", e.target.value)} placeholder="Registered name" aria-label="Organisation name" />
      </Row>

      <Row title="Where food is delivered">
        <div className={s.spot} data-pinned={form.pinned}>
          <MapPin size={20} aria-hidden />
          <p>{form.pinned && form.address ? form.address : form.pinned ? "Pinned on the map" : `Centre of ${form.area}. Pin your gate so partners find you.`}</p>
        </div>
        <div className={s.spotActions}>
          <button type="button" className={d.primary} onClick={() => setMapOpen(true)}>
            <Crosshair size={18} aria-hidden /> {form.pinned ? "Move the pin" : "Use my exact location"}
          </button>
        </div>
        <label className={d.field}><span>Area</span>
          <select className={d.select} value={form.area} onChange={e => setForm({ ...form, area: e.target.value, ...(form.pinned ? {} : AREA_COORDS[e.target.value]) })}>
            {AREAS.map(a => <option key={a}>{a}</option>)}
          </select>
        </label>
      </Row>

      <Row title="On a usual day">
        <div className={d.steppers}>
          <Stepper label="Meals you need" value={form.mealsNeeded} onChange={v => set("mealsNeeded", v)} min={0} max={5000} step={10} unit="meals needed" />
          <Stepper label="Meals you can take" value={form.dailyCapacity} onChange={v => set("dailyCapacity", v)} min={1} max={5000} step={10} unit="can take" />
        </div>
      </Row>

      <Row title="How urgent">
        <ChoiceChips label="How urgent" name="urgency" value={form.urgency} onChange={v => set("urgency", v)} options={URGENCIES} />
      </Row>

      <Row title="You receive food">
        <div className={s.hoursPair}>
          <label className={d.field}><span>From</span><input type="time" value={form.start} onChange={e => set("start", e.target.value)} /></label>
          <label className={d.field}><span>Until</span><input type="time" value={form.end} onChange={e => set("end", e.target.value)} /></label>
        </div>
      </Row>

      <Row title="Partners can come from">
        <div className={d.steppers}>
          <Stepper label="Pickup radius" value={form.serviceKm} onChange={v => set("serviceKm", v)} min={1} max={50} unit="km away" />
        </div>
        <label className={d.field} data-inline><span>People you serve <small>(optional)</small></span>
          <input inputMode="numeric" value={form.people} onChange={e => set("people", e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="e.g. 80" />
        </label>
      </Row>

      <Row title="Food you accept">
        <ToggleChips label="Food you accept" values={form.categories} onChange={v => set("categories", v)} options={CATEGORIES.map(c => ({ value: c.id, label: c.label }))} />
      </Row>

      <Row title="Food rules">
        <ToggleChips label="Food rules" values={form.dietary} onChange={v => set("dietary", v)} options={DIETARY} />
      </Row>

      <div className={d.actionBar} data-solo>
        {problem && <p className={d.barError} role="alert">{problem}</p>}
        {notice && !problem && <p className={s.saved} role="status">{notice}</p>}
        <div className={d.barRow}>
          <button type="submit" className={d.primary} disabled={saving}>{saving ? "Saving…" : mine ? "Save default listing" : "List my NGO"}</button>
        </div>
      </div>

      <SpotSheet token={session.token} open={mapOpen} initial={form.pinned ? { lat: form.latitude, lng: form.longitude } : null} initialAddress={form.pinned ? form.address : ""}
        onClose={() => setMapOpen(false)}
        onDone={(spot, address) => { setForm({ ...form, latitude: spot.lat, longitude: spot.lng, address, pinned: true }); setMapOpen(false); }} />
    </form>
  );
}
