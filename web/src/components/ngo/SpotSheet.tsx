"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { X } from "lucide-react";
import type { Spot } from "@/components/donor/LocationPicker";
import d from "@/components/donor/donor.module.css";

const LocationPicker = dynamic(() => import("@/components/donor/LocationPicker"), {
  ssr: false, loading: () => <div className={d.pickerLoading}>Loading the map…</div>,
});

/** The donor map picker in a sheet: find the NGO's gate (it locates you first), confirm the words, done. */
export default function SpotSheet({ token, open, initial, initialAddress, onDone, onClose }: {
  token: string; open: boolean; initial: Spot | null; initialAddress: string;
  onDone: (spot: Spot, address: string) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [spot, setSpot] = useState<Spot | null>(initial), [address, setAddress] = useState(initialAddress), [edited, setEdited] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const el = dialog.current; if (!el) return;
    if (open && !el.open) { setSpot(initial); setAddress(initialAddress); setEdited(!!initialAddress); setError(""); el.showModal(); }
    if (!open && el.open) el.close();
  }, [open, initial, initialAddress]);

  const done = () => {
    if (!spot) return setError("Move the map so the pin sits on your gate, or tap “Use my location”.");
    if (!address.trim()) return setError("Type the address so delivery partners can read it.");
    onDone(spot, address.trim().slice(0, 200));
  };

  return (
    <dialog ref={dialog} className={d.addressSheet} onClose={onClose} aria-labelledby="spot-title">
      <header className={d.sheetHead}>
        <h2 id="spot-title">Where food is delivered</h2>
        <button type="button" className={d.iconButton} onClick={onClose} aria-label="Close"><X size={20} aria-hidden /></button>
      </header>
      <div className={d.sheetBody}>
        {open && <LocationPicker token={token} value={spot} onChange={setSpot} autoLocate={!initial}
          onAddress={a => { if (!edited) setAddress(a); }} />}
        <label className={d.field}><span>Address partners will see</span>
          <textarea value={address} maxLength={200} onChange={e => { setAddress(e.target.value); setEdited(true); }} placeholder="Building, street, area" />
        </label>
        {error && <p className={d.barError} role="alert">{error}</p>}
      </div>
      <footer className={d.sheetFoot}>
        <button type="button" className={d.primary} onClick={done}>Use this spot</button>
      </footer>
    </dialog>
  );
}
