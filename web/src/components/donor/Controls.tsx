"use client";

import { Minus, Plus } from "lucide-react";
import { useId, type ReactNode } from "react";
import s from "./donor.module.css";

/** Single-choice printed chips (radio group). */
export function ChoiceChips<T extends string>({ label, value, onChange, options, name }: {
  label: string; name: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; hint?: string }[];
}) {
  const id = useId();
  return (
    <div className={s.chips} role="radiogroup" aria-label={label}>
      {options.map(o => (
        <label key={o.value} className={s.chip} data-on={value === o.value}>
          <input type="radio" className={s.chipRadio} name={`${name}-${id}`} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}
        </label>
      ))}
    </div>
  );
}

/** Multi-choice printed chips (each is a toggle button). */
export function ToggleChips({ label, values, onChange, options }: {
  label: string; values: string[]; onChange: (v: string[]) => void; options: { value: string; label: string }[];
}) {
  return (
    <div className={s.chips} role="group" aria-label={label}>
      {options.map(o => {
        const on = values.includes(o.value);
        return (
          <button key={o.value} type="button" aria-pressed={on} className={s.chip}
            onClick={() => onChange(on ? values.filter(v => v !== o.value) : [...values, o.value])}>
            <span>{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function Stepper({ label, value, onChange, min, max, unit, step = 1 }: {
  label: string; value: number; onChange: (v: number) => void; min: number; max: number; unit: string; step?: number;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : min));
  return (
    <div className={s.stepper}>
      <button type="button" aria-label={`Fewer ${unit}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}><Minus size={20} aria-hidden /></button>
      <label>
        <input type="number" inputMode="numeric" min={min} max={max} value={value} aria-label={label}
          onChange={e => onChange(clamp(Number(e.target.value)))} />
        <span>{unit}</span>
      </label>
      <button type="button" aria-label={`More ${unit}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}><Plus size={20} aria-hidden /></button>
    </div>
  );
}

/** A labelled block in the List food form. */
export function Row({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className={s.row}>
      <header><h2>{title}</h2>{aside}</header>
      {children}
    </section>
  );
}
