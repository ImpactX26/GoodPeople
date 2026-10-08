"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut, MapPin, Plus } from "lucide-react";
import { formatPhone, getProfile, getSession, signOut, updateProfile, type Session } from "@/lib/luna/auth";
import { AREAS } from "@/lib/luna/roles";
import { useHydrated } from "@/lib/luna/useHydrated";
import type { SavedAddress } from "@/lib/luna/addresses";
import { stamp } from "@/components/ticket/Ticket";
import { ChoiceChips, Row } from "./Controls";
import DonorShell from "./DonorShell";
import AddressSheet from "./AddressSheet";
import { useAddresses } from "./useAddresses";
import s from "./donor.module.css";

const KINDS = ["Restaurant", "Caterer", "Hotel", "Event organiser", "Household"] as const;

export default function DonorProfileRoute() {
  const hydrated = useHydrated(), router = useRouter();
  const session = hydrated ? getSession() : null;
  useEffect(() => {
    if (!hydrated) return;
    if (!session) router.replace("/login"); else if (session.role !== "donor") router.replace(`/${session.role}`);
  }, [hydrated, session, router]);
  if (!session || session.role !== "donor") return <DonorShell title="Your profile"><p className={s.loading}>Loading your profile…</p></DonorShell>;
  return <DonorProfile session={session} />;
}

function DonorProfile({ session }: { session: Session }) {
  const router = useRouter();
  const [fields, setFields] = useState<Record<string, string>>(() => getProfile(session.role, session.phone)?.fields ?? {});
  const [draft, setDraft] = useState(fields), [saving, setSaving] = useState(false), [saved, setSaved] = useState(""), [error, setError] = useState("");
  const { list, max, error: listError, save, remove } = useAddresses(session.token);
  const [editing, setEditing] = useState<SavedAddress | null | "new">(null);
  const dirty = ["name", "org", "kind", "area"].some(k => (draft[k] ?? "") !== (fields[k] ?? ""));

  const saveDetails = async () => {
    setError(""); setSaved("");
    if (!draft.name?.trim()) return setError("Add your name.");
    if (!draft.org?.trim()) return setError("Add your business or household name.");
    setSaving(true);
    try {
      const p = await updateProfile(session, { ...fields, ...draft, name: draft.name.trim(), org: draft.org.trim() });
      setFields(p.fields); setDraft(p.fields); setSaved("Saved.");
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };

  return (
    <DonorShell title="Your profile" back={{ label: "Home", href: "/donor" }}>
      <div className={s.profile}>
        <section className={s.profileCard} aria-labelledby="pickup-addresses">
          <header className={s.profileHead}>
            <h2 id="pickup-addresses">Pickup addresses</h2>
            <span className={s.rowHint}>{list ? `${list.length} of ${max}` : ""}</span>
          </header>
          <p className={s.note}>Where delivery partners collect your food. The default is picked automatically when you list food.</p>
          {list === null ? <p className={s.note}>{listError || "Loading…"}</p> : (
            <ul className={s.addressList}>
              {list.map(a => (
                <li key={a.id} className={s.addressCard} data-default={a.isDefault}>
                  <MapPin size={20} aria-hidden />
                  <div>
                    <b>{a.label}{a.isDefault && <span className={s.stamp}>Default</span>}</b>
                    <p>{a.address}</p>
                    {a.notes && <p className={s.note}>{a.notes}</p>}
                  </div>
                  <div className={s.addressActions}>
                    <button type="button" className={s.textButton} onClick={() => setEditing(a)}>Edit</button>
                    {!a.isDefault && <button type="button" className={s.textButton} onClick={() => void save({ ...a, isDefault: true })}>Make default</button>}
                  </div>
                </li>
              ))}
              {list.length === 0 && <li className={s.addressEmpty}>No saved addresses yet. Add the place partners should collect from.</li>}
            </ul>
          )}
          {list && list.length < max && (
            <button type="button" className={s.addButton} onClick={() => setEditing("new")}><Plus size={18} aria-hidden /> Add an address</button>
          )}
        </section>

        <section className={s.profileCard} aria-labelledby="business-details">
          <header className={s.profileHead}><h2 id="business-details">Your details</h2></header>
          <label className={s.field}><span>Your name</span><input value={draft.name ?? ""} maxLength={120} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label className={s.field}><span>Business or household name</span><input value={draft.org ?? ""} maxLength={120} onChange={e => setDraft({ ...draft, org: e.target.value })} /></label>
          <Row title="You are a">
            <ChoiceChips label="Donor type" name="kind" value={draft.kind ?? ""} onChange={v => setDraft({ ...draft, kind: v })} options={KINDS.map(k => ({ value: k, label: k }))} />
          </Row>
          <label className={s.field}><span>Area</span>
            <select className={s.select} value={draft.area ?? ""} onChange={e => setDraft({ ...draft, area: e.target.value })}>
              <option value="" disabled>Choose your area</option>
              {AREAS.map(a => <option key={a}>{a}</option>)}
            </select>
          </label>
          <dl className={s.leaders}>
            <div><dt>Mobile</dt><dd>{formatPhone(session.phone)}</dd></div>
            {fields.verification && <div><dt>Verified</dt><dd>{fields.verification}</dd></div>}
            <div><dt>Signed in</dt><dd>{stamp(new Date(session.signedInAt))}</dd></div>
          </dl>
          {error && <p className={s.barError} role="alert">{error}</p>}
          <div className={s.profileActions}>
            {saved && !dirty && <span className={s.note} role="status">{saved}</span>}
            <button type="button" className={s.primary} disabled={!dirty || saving} onClick={() => void saveDetails()}>{saving ? "Saving…" : "Save details"}</button>
          </div>
        </section>

        <button type="button" className={s.ghost} data-wide onClick={() => { signOut(); router.replace("/login"); }}><LogOut size={18} aria-hidden /> Sign out</button>
      </div>

      <AddressSheet token={session.token} open={editing !== null} initial={editing === "new" ? null : editing}
        canDelete={!!list && list.length > 0}
        onSave={async a => { await save(a); setEditing(null); }}
        onDelete={async id => { await remove(id); setEditing(null); }}
        onClose={() => setEditing(null)} />
    </DonorShell>
  );
}
