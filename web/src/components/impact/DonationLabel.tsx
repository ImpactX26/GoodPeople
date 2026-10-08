"use client";

import { useRef } from "react";
import { Printer } from "lucide-react";
import type { DonationLabel as Label } from "@/lib/luna/impact";
import { printOnly } from "./print";
import s from "./impact.module.css";

const when = (ms: number) => new Date(ms).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const KEEP = {
  hot: "Keep hot (above 57 °C), or cool quickly and refrigerate.",
  fridge: "Keep refrigerated (below 5 °C).",
  room: "Keep covered, out of the sun. Eat by the time above.",
} as const;
const MARK = { veg: "Veg", nonveg: "Non-veg", egg: "Contains egg" } as const;

/** The FSSAI veg / non-veg mark, in ink: a dot in a square for veg, a triangle for non-veg. */
function DietMark({ mark }: { mark: Label["items"][number]["mark"] }) {
  return (
    <svg className={s.dietMark} viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="2" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" />
      {mark === "nonveg" ? <polygon points="12,6 18,17 6,17" fill="currentColor" /> : <circle cx="12" cy="12" r="5" fill="currentColor" />}
    </svg>
  );
}

/**
 * The donation label (SRS §9, "legal compliance, done for them"): food name, source, preparation time,
 * consume-by, a veg / non-veg mark and the allergens, ready to print and stick on the food. `compact` is the
 * partner's view at pickup (no print button).
 */
export default function DonationLabel({ label, compact = false }: { label: Label; compact?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  return (
    <section className={s.labelWrap} aria-labelledby={`label-${label.ref}`}>
      {!compact && (
        <header className={s.labelHead} data-no-print>
          <h2 id={`label-${label.ref}`}>Donation label</h2>
          <p>What FSSAI expects on donated food, filled in for you. Print it and stick it on the containers, or show it at pickup.</p>
        </header>
      )}
      <article className={s.label} ref={ref} aria-label={compact ? `Donation label ${label.ref}` : undefined} data-compact={compact || undefined}>
        <p className={s.labelTop}><b>Donated food · not for sale</b><span>{label.ref}</span></p>
        {label.items.map((it, i) => (
          <div key={i} className={s.labelItem}>
            <p className={s.labelFood}><DietMark mark={it.mark} /><b>{it.name}</b><em>{MARK[it.mark]}{it.jain ? " · Jain" : ""}</em></p>
            <dl className={s.labelLines}>
              <div><dt>Prepared</dt><dd>{when(it.preparedAt)}</dd></div>
              <div data-strong><dt>Consume by</dt><dd>{it.consumeBy ? when(it.consumeBy) : "Not for people"}</dd></div>
              <div><dt>Servings</dt><dd>{it.servings}</dd></div>
              <div><dt>Contains</dt><dd>{it.allergens.length ? it.allergens.map((a) => a.replace("_", " / ")).join(", ") : "None declared"}</dd></div>
            </dl>
            <p className={s.labelKeep}>{KEEP[it.storage]}</p>
          </div>
        ))}
        <footer className={s.labelFoot}>
          <p><b>From</b> {label.source.name}, {label.source.address}</p>
          <p><b>FSSAI lic.</b> {label.source.fssai ?? "not given"} · <b>Listed</b> {when(label.listedAt)}</p>
          <p>Consume-by checked by Luna&rsquo;s Food Agent from cooking time, storage and the photo.</p>
        </footer>
      </article>
      {!compact && (
        <button type="button" className={s.printButton} data-no-print onClick={() => printOnly(ref.current)}>
          <Printer size={18} aria-hidden /> Print label
        </button>
      )}
    </section>
  );
}
