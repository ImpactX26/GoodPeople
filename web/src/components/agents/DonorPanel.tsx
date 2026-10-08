"use client";

import { useState } from "react";
import { Heading, Leader, Rule } from "@/components/ticket/Ticket";
import { fmtTime, foodLine, listFood, listingDetail, myListings, type Diet, type Grade, type Listing, type NewItem, type Storage } from "@/lib/luna/agents";
import { usePoll } from "@/lib/luna/usePoll";
import s from "./agents.module.css";
import { BigCode, Reply, STATUS, Stamp, useAction } from "./ui";

const DIETS: [Diet, string][] = [["veg", "Veg"], ["jain", "Jain"], ["egg", "Egg"], ["nonveg", "Non-veg"]];
const UNITS = ["kg", "L", "pieces", "trays"];
const STORAGE: [Storage, string][] = [["room", "Room temp"], ["fridge", "Fridge"], ["hot", "Kept hot"]];

type Draft = { name: string; servings: string; amount: string; unit: string; diet: Diet; grade: Grade; safeHours: string; confidence: string };
const blank = (): Draft => ({ name: "", servings: "", amount: "", unit: "kg", diet: "veg", grade: "A", safeHours: "6", confidence: "90" });

export default function DonorPanel() {
  const listings = usePoll(myListings, 5000);
  return (
    <>
      <ListFood onListed={listings.reload} />
      <Rule />
      <Heading>Your donations</Heading>
      {listings.error && <p className={s.error}>{listings.error}</p>}
      {listings.data?.length === 0 && <p className={s.note}>Nothing listed yet. Your donations and where they went will print here.</p>}
      <div>
        {listings.data?.slice(0, 5).map((l) => (
          <Donation key={l.id} listing={l} />
        ))}
      </div>
    </>
  );
}

function ListFood({ onListed }: { onListed: () => void }) {
  const [items, setItems] = useState<Draft[]>([blank()]);
  const [storage, setStorage] = useState<Storage>("room");
  const [containers, setContainers] = useState("");
  const [notes, setNotes] = useState("");
  const action = useAction(onListed);
  const set = (i: number, patch: Partial<Draft>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const valid = items.every((i) => i.name.trim() && Number(i.servings) > 0);

  function submit() {
    const payload: NewItem[] = items.map((i) => ({
      name: i.name.trim(),
      servings: Math.round(Number(i.servings)),
      quantity: Number(i.amount) > 0 ? { amount: Number(i.amount), unit: i.unit } : undefined,
      diet: i.diet,
      grade: i.grade,
      safeTime: Math.round(Number(i.safeHours) * 60),
      confidence: Number(i.confidence),
    }));
    void action.run(async () => {
      await listFood({ items: payload, storage, containers: containers.split(",").map((c) => c.trim()).filter(Boolean), pickupNotes: notes.trim() || undefined });
      setItems([blank()]);
      setContainers("");
      setNotes("");
      return { ok: true, message: "Listed! Luna is finding it a home." };
    });
  }

  return (
    <form
      className={s.section}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) submit();
      }}
    >
      <Heading>List food</Heading>
      {items.map((it, i) => (
        <div key={i} className={s.itemBox}>
          <div className={s.itemHead}>
            <span>Item {i + 1}</span>
            {items.length > 1 && (
              <button type="button" className={s.small} onClick={() => setItems((xs) => xs.filter((_, j) => j !== i))}>
                Remove
              </button>
            )}
          </div>
          <label className={s.field}>
            <span className={s.label}>Dish</span>
            <input className={s.box} value={it.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="e.g. veg biryani" required />
          </label>
          <div className={s.row3}>
            <label className={s.field}>
              <span className={s.label}>Servings</span>
              <input className={s.box} inputMode="numeric" value={it.servings} onChange={(e) => set(i, { servings: e.target.value.replace(/\D/g, "") })} required />
            </label>
            <label className={s.field}>
              <span className={s.label}>How much</span>
              <input className={s.box} inputMode="decimal" value={it.amount} onChange={(e) => set(i, { amount: e.target.value.replace(/[^\d.]/g, "") })} placeholder="6" />
            </label>
            <label className={s.field}>
              <span className={s.label}>Unit</span>
              <select className={s.select} value={it.unit} onChange={(e) => set(i, { unit: e.target.value })}>
                {UNITS.map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </select>
            </label>
          </div>
          <div className={s.field}>
            <span className={s.label}>Diet</span>
            <div className={s.choices}>
              {DIETS.map(([d, label]) => (
                <button key={d} type="button" className={s.choice} data-on={it.diet === d} aria-pressed={it.diet === d} onClick={() => set(i, { diet: d })}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <details className={s.details}>
            <summary>
              Food check · Grade {it.grade}, safe {it.safeHours} h
            </summary>
            <p className={s.note} style={{ marginBottom: 10 }}>
              Filled in by hand until the AI Food Checker is connected.
            </p>
            <div className={s.field}>
              <span className={s.label}>Grade</span>
              <div className={s.choices}>
                {(["A", "B", "C", "D"] as Grade[]).map((g) => (
                  <button key={g} type="button" className={s.choice} data-on={it.grade === g} aria-pressed={it.grade === g} onClick={() => set(i, { grade: g })}>
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className={s.row} style={{ marginTop: 10 }}>
              <label className={s.field}>
                <span className={s.label}>Safe for (hours)</span>
                <input className={s.box} inputMode="decimal" value={it.safeHours} onChange={(e) => set(i, { safeHours: e.target.value.replace(/[^\d.]/g, "") })} />
              </label>
              <label className={s.field}>
                <span className={s.label}>Confidence %</span>
                <input className={s.box} inputMode="numeric" value={it.confidence} onChange={(e) => set(i, { confidence: e.target.value.replace(/\D/g, "").slice(0, 3) })} />
              </label>
            </div>
          </details>
        </div>
      ))}
      <button type="button" className={s.outline} onClick={() => setItems((xs) => [...xs, blank()])}>
        Add another item
      </button>
      <div className={s.field}>
        <span className={s.label}>Stored</span>
        <div className={s.choices}>
          {STORAGE.map(([v, label]) => (
            <button key={v} type="button" className={s.choice} data-on={storage === v} aria-pressed={storage === v} onClick={() => setStorage(v)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <label className={s.field}>
        <span className={s.label}>Partner must bring</span>
        <input className={s.box} value={containers} onChange={(e) => setContainers(e.target.value)} placeholder="2 insulated bags, 1 crate" />
      </label>
      <label className={s.field}>
        <span className={s.label}>Pickup note</span>
        <input className={s.box} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Kitchen back door" />
      </label>
      <button type="submit" className={s.primary} disabled={!valid || action.busy}>
        {action.busy ? "Listing…" : "List food"}
      </button>
      <Reply msg={action.msg} />
    </form>
  );
}

/** One listing: where each share went, the pickup code, and the agents' reasons. */
function Donation({ listing }: { listing: Listing }) {
  const detail = usePoll(() => listingDetail(listing.id), 5000);
  const d = detail.data;
  const tone = listing.status === "closed" ? "done" : listing.status === "unmatched" ? "urgent" : undefined;
  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{foodLine(listing.items)}</h3>
        <Stamp tone={tone}>{STATUS[d?.listing.status ?? listing.status]}</Stamp>
      </div>
      <p className={s.note}>Listed at {fmtTime(listing.createdAt)}</p>
      {d?.shares.map((sh) => {
        const servings = sh.lines.reduce((n, l) => n + l.servings, 0);
        const live = sh.status === "assigned";
        return (
          <div key={sh.id} className={s.section}>
            <Leader label={`${servings} servings → ${sh.ngoName ?? "finding an NGO"}`} value={STATUS[sh.status]} />
            {live && sh.pickupCode && <BigCode code={sh.pickupCode} label="Pickup code · show it to the partner" />}
          </div>
        );
      })}
      {d && d.timeline.length > 0 && (
        <details className={s.details}>
          <summary>Why ({d.timeline.length})</summary>
          <ul className={s.feed}>
            {d.timeline
              .filter((t) => t.kind !== "filtered")
              .slice(-8)
              .map((t) => (
                <li key={t.id}>
                  <span className={s.feedMeta}>
                    {fmtTime(t.at)} · {t.agent ?? "agent"}
                  </span>
                  <span className={s.feedText}>{t.reason}</span>
                </li>
              ))}
          </ul>
        </details>
      )}
    </article>
  );
}
