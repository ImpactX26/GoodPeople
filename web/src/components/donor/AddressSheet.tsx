"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Check, Trash2, X } from "lucide-react";
import { newAddressId, type SavedAddress } from "@/lib/luna/addresses";
import type { Spot } from "./LocationPicker";
import s from "./donor.module.css";

const LocationPicker = dynamic(() => import("./LocationPicker"), {
  ssr: false, loading: () => <div className={s.pickerLoading}>Loading the map…</div>,
});
const LABELS = ["Kitchen", "Home", "Banquet hall", "Office"];

/** Add or edit one saved pickup address: name it, pin it on the map, confirm the words. */
export default function AddressSheet({ token, open, initial, canDelete, onSave, onDelete, onClose }: {
  token: string; open: boolean; initial: SavedAddress | null; canDelete: boolean;
  onSave: (a: SavedAddress) => Promise<void>; onDelete?: (id: string) => Promise<void>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [label, setLabel] = useState(""), [address, setAddress] = useState(""), [edited, setEdited] = useState(false);
  const [suggested, setSuggested] = useState(""), [notes, setNotes] = useState(""), [spot, setSpot] = useState<Spot | null>(null);
  const [isDefault, setIsDefault] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");

  useEffect(() => {
    const d = dialog.current; if (!d) return;
    if (open && !d.open) {
      setLabel(initial?.label ?? "Kitchen"); setAddress(initial?.address ?? ""); setEdited(!!initial); setSuggested("");
      setNotes(initial?.notes ?? ""); setSpot(initial ? { lat: initial.lat, lng: initial.lng } : null);
      setIsDefault(initial?.isDefault ?? false); setError(""); d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open, initial]);

  const save = async () => {
    setError("");
    if (!label.trim()) return setError("Give this address a short name, like Kitchen.");
    if (!spot) return setError("Put the pin on the pickup spot: tap “Use my location” or drag the map.");
    if (!address.trim()) return setError("Type the address so the partner can read it.");
    setBusy(true);
    try {
      await onSave({ id: initial?.id ?? newAddressId(), label: label.trim().slice(0, 40), address: address.trim().slice(0, 200),
        notes: notes.trim().slice(0, 200), lat: spot.lat, lng: spot.lng, isDefault });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <dialog ref={dialog} className={s.addressSheet} onClose={onClose} aria-labelledby="address-sheet-title">
      <header className={s.sheetHead}>
        <h2 id="address-sheet-title">{initial ? "Edit pickup address" : "New pickup address"}</h2>
        <button type="button" className={s.iconButton} onClick={onClose} aria-label="Close"><X size={20} aria-hidden /></button>
      </header>
      <div className={s.sheetBody}>
        <div className={s.chips} role="group" aria-label="Address name">
          {LABELS.map(l => (
            <button key={l} type="button" className={s.chip} aria-pressed={label === l} onClick={() => setLabel(l)}><span>{l}</span></button>
          ))}
          <input className={s.chipInput} value={LABELS.includes(label) ? "" : label} onChange={e => setLabel(e.target.value)}
            placeholder="Other name" maxLength={40} aria-label="Other address name" />
        </div>

        {open && <LocationPicker token={token} value={spot} onChange={setSpot}
          onAddress={a => { setSuggested(a); if (!edited) setAddress(a); }} />}

        <label className={s.field}><span>Address the partner will see</span>
          <textarea value={address} maxLength={200} onChange={e => { setAddress(e.target.value); setEdited(true); }}
            placeholder="Building, street, area" />
        </label>
        {edited && suggested && suggested !== address && (
          <button type="button" className={s.suggest} onClick={() => { setAddress(suggested); setEdited(false); }}>
            Use the map’s address: <b>{suggested}</b>
          </button>
        )}
        <label className={s.field}><span>Instructions for the partner <small>(optional)</small></span>
          <textarea value={notes} maxLength={200} onChange={e => setNotes(e.target.value)} placeholder="e.g. Side gate, ask for Raju at the kitchen" />
        </label>
        <label className={s.declare}>
          <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
          <span className={s.box} aria-hidden>{isDefault && <Check size={16} strokeWidth={3} />}</span>
          <span>Use this address by default when I list food</span>
        </label>
        {error && <p className={s.barError} role="alert">{error}</p>}
      </div>
      <footer className={s.sheetFoot}>
        {initial && canDelete && onDelete && (
          <button type="button" className={s.ghost} disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(initial.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>
            <Trash2 size={16} aria-hidden /> Delete
          </button>
        )}
        <button type="button" className={s.primary} disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save address"}</button>
      </footer>
    </dialog>
  );
}
