"use client";

import { useState } from "react";
import { adminPartners, adminRecipients, approve, decisions, escalations, fmtTime, foodLine, linkPhone, reviewQueue, type Decision } from "@/lib/luna/agents";
import { usePoll } from "@/lib/luna/usePoll";
import s from "./agents.module.css";
import { Reply, useAction } from "./ui";

type Tab = "feed" | "flags" | "review" | "link";
const TABS: [Tab, string][] = [["feed", "Feed"], ["flags", "Flags"], ["review", "Review"], ["link", "Link people"]];

/** Admin: every agent decision with its reason, escalations, first-listing review, and linking phones. */
export default function AgentFeed({ headingClass }: { headingClass?: string }) {
  const [tab, setTab] = useState<Tab>("feed");
  return (
    <div>
      <h3 className={headingClass}>Agent feed &amp; flags</h3>
      <div className={s.tabs} role="tablist">
        {TABS.map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={s.choice} data-on={tab === t} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "feed" && <Feed load={() => decisions(40)} empty="No decisions yet. List some food to see the agents at work." />}
      {tab === "flags" && <Feed load={escalations} empty="Nothing needs a person right now." />}
      {tab === "review" && <Review />}
      {tab === "link" && <LinkPeople />}
    </div>
  );
}

function Feed({ load, empty }: { load: () => Promise<Decision[]>; empty: string }) {
  const { data, error } = usePoll(load, 5000);
  if (error) return <p className={s.error}>{error}</p>;
  if (!data) return <p className={s.note}>Loading&hellip;</p>;
  if (!data.length) return <p className={s.note}>{empty}</p>;
  return (
    <ul className={s.feed} aria-live="polite">
      {data.map((d) => (
        <li key={d.id} data-kind={d.kind}>
          <span className={s.feedMeta}>
            <span>{fmtTime(d.at)}</span>
            <span>{d.agent ?? "agent"}</span>
            <span>{d.kind.replace("_", " ")}</span>
          </span>
          <span className={s.feedText}>{d.reason}</span>
        </li>
      ))}
    </ul>
  );
}

function Review() {
  const queue = usePoll(reviewQueue, 5000);
  const action = useAction(queue.reload);
  if (!queue.data) return <p className={s.note}>Loading&hellip;</p>;
  if (!queue.data.length) return <p className={s.note}>No first listings waiting for a check.</p>;
  return (
    <div className={s.section}>
      {queue.data.map((l) => (
        <div key={l.id} className={s.card}>
          <p className={s.feedText}>
            <strong>{l.donorName}</strong>: {foodLine(l.items)} · listed {fmtTime(l.createdAt)}
          </p>
          <button type="button" className={s.small} disabled={action.busy} onClick={() => action.run(() => approve(l.id))}>
            Approve
          </button>
        </div>
      ))}
      <Reply msg={action.msg} />
    </div>
  );
}

function LinkPeople() {
  const [kind, setKind] = useState<"recipients" | "partners">("recipients");
  const recipients = usePoll(adminRecipients, 30000);
  const partners = usePoll(adminPartners, 30000);
  const list = (kind === "recipients" ? recipients.data : partners.data) ?? [];
  const [id, setId] = useState("");
  const [phone, setPhone] = useState("");
  const action = useAction(() => {
    void recipients.reload();
    void partners.reload();
  });
  const chosen = id && list.some((x) => x.id === id) ? id : "";
  return (
    <form
      className={s.section}
      onSubmit={(e) => {
        e.preventDefault();
        if (chosen && phone.length === 10) void action.run(() => linkPhone(kind, chosen, phone));
      }}
    >
      <p className={s.note}>Let a team phone stand in for a sample NGO or delivery partner. Linked ones stop answering automatically.</p>
      <div className={s.choices}>
        {(["recipients", "partners"] as const).map((k) => (
          <button key={k} type="button" className={s.choice} data-on={kind === k} onClick={() => setKind(k)}>
            {k === "recipients" ? "NGO" : "Partner"}
          </button>
        ))}
      </div>
      <label className={s.field}>
        <span className={s.label}>{kind === "recipients" ? "NGO" : "Partner"}</span>
        <select className={s.select} value={chosen} onChange={(e) => setId(e.target.value)}>
          <option value="">Choose…</option>
          {list.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.phone ? ` · linked ${x.phone}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className={s.field}>
        <span className={s.label}>Phone</span>
        <input className={s.box} inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="10-digit mobile" />
      </label>
      <button type="submit" className={s.outline} disabled={!chosen || phone.length !== 10 || action.busy}>
        Link
      </button>
      <Reply msg={action.msg} />
    </form>
  );
}
