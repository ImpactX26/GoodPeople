"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { clearToday, setToday, type Ngo, type Urgency } from "@/lib/luna/ngoAgent";
import { ChoiceChips, Row, Stepper } from "@/components/donor/Controls";
import { URGENCIES } from "./NgoListingForm";
import d from "@/components/donor/donor.module.css";
import s from "./ngo.module.css";

const dayName = () => new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" });

/** Today's listing: changes the default listing until midnight, then Luna goes back to the defaults. */
export default function TodaySheet({ ngo, open, onClose, onSaved }: { ngo: Ngo; open: boolean; onClose: () => void; onSaved: () => Promise<void> | void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const t = ngo.today_active ? ngo.today : null;
  const [meals, setMeals] = useState(0), [room, setRoom] = useState(0), [urgency, setUrgency] = useState<Urgency>("MEDIUM");
  const [start, setStart] = useState("08:00"), [end, setEnd] = useState("21:00"), [busy, setBusy] = useState(false), [error, setError] = useState("");

  useEffect(() => {
    const el = dialog.current; if (!el) return;
    if (open && !el.open) {
      setMeals(t?.meals_needed ?? ngo.current_demand.meals_needed);
      setRoom(t?.available_capacity_today ?? ngo.capacity.daily_meal_capacity);
      setUrgency(t?.urgency ?? ngo.current_demand.urgency);
      setStart(t?.receiving_hours?.start ?? ngo.receiving_hours.start); setEnd(t?.receiving_hours?.end ?? ngo.receiving_hours.end);
      setError(""); el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open, t, ngo]);

  const save = async () => {
    setError("");
    if (start >= end) return setError("“Until” has to be later than “From”.");
    setBusy(true);
    try {
      await setToday(ngo.ngo_id, { meals_needed: meals, available_capacity_today: room, urgency, receiving_hours: { start, end } });
      await onSaved(); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const reset = async () => {
    setBusy(true); setError("");
    try { await clearToday(ngo.ngo_id); await onSaved(); onClose(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const usual = `Usually ${ngo.current_demand.meals_needed} needed · room for ${ngo.capacity.daily_meal_capacity} · ${ngo.receiving_hours.start}–${ngo.receiving_hours.end}`;

  return (
    <dialog ref={dialog} className={d.addressSheet} onClose={onClose} aria-labelledby="today-sheet-title">
      <header className={d.sheetHead}>
        <h2 id="today-sheet-title">Today’s listing</h2>
        <button type="button" className={d.iconButton} onClick={onClose} aria-label="Close"><X size={20} aria-hidden /></button>
      </header>
      <div className={d.sheetBody}>
        <p className={s.todayIntro}><b>{dayName()} only.</b> These replace your default listing until midnight, then Luna goes back to the defaults. <span>{usual}</span></p>
        <Row title="Meals today">
          <div className={d.steppers}>
            <Stepper label="Meals you need today" value={meals} onChange={setMeals} min={0} max={5000} step={10} unit="needed today" />
            <Stepper label="Meals you have room for today" value={room} onChange={setRoom} min={0} max={ngo.capacity.daily_meal_capacity} step={10} unit="room today" />
          </div>
        </Row>
        <Row title="How urgent today">
          <ChoiceChips label="How urgent today" name="today-urgency" value={urgency} onChange={setUrgency} options={URGENCIES} />
        </Row>
        <Row title="Receiving today">
          <div className={s.hoursPair}>
            <label className={d.field}><span>From</span><input type="time" value={start} onChange={e => setStart(e.target.value)} /></label>
            <label className={d.field}><span>Until</span><input type="time" value={end} onChange={e => setEnd(e.target.value)} /></label>
          </div>
        </Row>
        {error && <p className={d.barError} role="alert">{error}</p>}
      </div>
      <footer className={d.sheetFoot}>
        {t && <button type="button" className={d.ghost} disabled={busy} onClick={() => void reset()}>Back to default</button>}
        <button type="button" className={d.primary} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Use for today"}</button>
      </footer>
    </dialog>
  );
}
