"use client";

import { useState } from "react";
import { Heading, Leader } from "@/components/ticket/Ticket";
import {
  answerOffer,
  answerRedirect,
  assignByHand,
  enterCode,
  fmtTime,
  foodLine,
  linked,
  ngoShares,
  sendFeedback,
  track,
  type NgoShare,
} from "@/lib/luna/agents";
import { usePoll } from "@/lib/luna/usePoll";
import s from "./agents.module.css";
import { BigCode, CodeEntry, Countdown, Reply, STATUS, Stamp, useAction } from "./ui";

export default function NgoPanel() {
  const link = usePoll(linked, 15000);
  const shares = usePoll(ngoShares, 4000);
  const mine = new Set(link.data?.recipients.map((r) => r.id));

  if (link.data && link.data.recipients.length === 0) {
    return (
      <>
        <Heading>Food offers</Heading>
        <p className={s.note}>This number isn&rsquo;t linked to an NGO yet. Ask the Luna team to link it (admin: Link people), then offers will print here.</p>
      </>
    );
  }

  const all = shares.data ?? [];
  const offers = all.filter((x) => (x.status === "offering" && x.ngoId && mine.has(x.ngoId)) || (x.redirect && mine.has(x.redirect.ngoId)));
  const active = all.filter((x) => ["finding_partner", "assigned", "picked_up"].includes(x.status) && x.ngoId && mine.has(x.ngoId) && !offers.includes(x));
  const done = all.filter((x) => x.status === "delivered" && x.ngoId && mine.has(x.ngoId)).slice(0, 5);

  return (
    <>
      <Heading>Food offers{link.data ? ` · ${link.data.recipients.map((r) => r.name).join(", ")}` : ""}</Heading>
      {shares.error && <p className={s.error}>{shares.error}</p>}
      {offers.length === 0 && <p className={s.note}>No offers right now. New ones print here with a countdown.</p>}
      {offers.map((x) => (
        <Offer key={x.id} share={x} onDone={shares.reload} />
      ))}
      {active.length > 0 && <Heading>On the way</Heading>}
      {active.map((x) => (
        <Incoming key={x.id} share={x} onDone={shares.reload} />
      ))}
      {done.length > 0 && <Heading>Delivered</Heading>}
      {done.map((x) => (
        <Delivered key={x.id} share={x} onDone={shares.reload} />
      ))}
    </>
  );
}

function Offer({ share, onDone }: { share: NgoShare; onDone: () => void }) {
  const action = useAction(onDone);
  const redirect = !!share.redirect;
  const until = redirect ? share.redirect!.deadlineAt : share.offerDeadlineAt ?? 0;
  const answer = redirect ? answerRedirect : answerOffer;
  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{foodLine(share.food)}</h3>
        {redirect ? <Stamp tone="urgent">Urgent</Stamp> : <Stamp>Grade {share.food.map((f) => f.grade).sort().at(-1)}</Stamp>}
      </div>
      <Leader label="From" value={share.donorName ?? "A restaurant"} />
      <Leader label="Can arrive by" value={fmtTime(redirect ? share.redirect!.arriveBy : share.arriveBy ?? 0)} />
      <Leader label="Reply within" value={<Countdown until={until} />} />
      {redirect && <p className={s.note}>A delivery nearby was delayed; this food needs a closer place to stay safe.</p>}
      <div className={s.buttons}>
        <button type="button" className={s.primary} disabled={action.busy} onClick={() => action.run(() => answer(share.id, true))}>
          Accept
        </button>
        <button type="button" className={s.outline} disabled={action.busy} onClick={() => action.run(() => answer(share.id, false))}>
          Decline
        </button>
      </div>
      <Reply msg={action.msg} />
    </article>
  );
}

function Incoming({ share, onDone }: { share: NgoShare; onDone: () => void }) {
  const action = useAction(onDone);
  const t = usePoll(() => track(share.id), 8000);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const manual = t.data?.partner?.manual;
  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{foodLine(share.food)}</h3>
        <Stamp>{STATUS[share.status]}</Stamp>
      </div>
      <Leader label="From" value={share.donorName ?? "A restaurant"} />
      {t.data?.partner && <Leader label="Partner" value={t.data.partner.name} />}
      {t.data?.eta && <Leader label="Arriving about" value={fmtTime(t.data.eta)} />}

      {share.status === "finding_partner" && (
        <form
          className={s.section}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void action.run(() => assignByHand(share.id, name.trim(), phone || undefined));
          }}
        >
          <p className={s.note}>We&rsquo;re asking delivery partners. You can also send someone yourself, e.g. staff who aren&rsquo;t on the app.</p>
          <div className={s.row}>
            <label className={s.field}>
              <span className={s.label}>Name</span>
              <input className={s.box} value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className={s.field}>
              <span className={s.label}>Phone (optional)</span>
              <input className={s.box} inputMode="numeric" value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))} />
            </label>
          </div>
          <button type="submit" className={s.outline} disabled={!name.trim() || action.busy}>
            Assign this person
          </button>
        </form>
      )}

      {(share.status === "assigned" || share.status === "picked_up") && share.dropCode && (
        <BigCode code={share.dropCode} label="Drop code · show it to the partner when the food arrives" />
      )}
      {manual && share.status === "assigned" && (
        <CodeEntry label="Pickup code (from your person at the restaurant)" busy={action.busy} onSubmit={(c) => action.run(() => enterCode(share.id, "pickup", c))} />
      )}
      {manual && share.status === "picked_up" && share.dropCode && (
        <button type="button" className={s.primary} disabled={action.busy} onClick={() => action.run(() => enterCode(share.id, "drop", share.dropCode!))}>
          Food received
        </button>
      )}
      <Reply msg={action.msg} />
    </article>
  );
}

function Delivered({ share, onDone }: { share: NgoShare; onDone: () => void }) {
  const action = useAction(onDone);
  const answers: ["fewer" | "right" | "more", string][] = [["fewer", "Fed fewer"], ["right", "About right"], ["more", "Fed more"]];
  return (
    <article className={s.card}>
      <div className={s.cardHead}>
        <h3 className={s.cardTitle}>{foodLine(share.food)}</h3>
        <Stamp tone="done">Delivered</Stamp>
      </div>
      {share.feedback ? (
        <p className={s.note}>Thanks for telling us how it went.</p>
      ) : (
        <>
          <p className={s.note}>How did it go?</p>
          <div className={s.choices}>
            {answers.map(([v, label]) => (
              <button key={v} type="button" className={s.choice} disabled={action.busy} onClick={() => action.run(() => sendFeedback(share.id, v))}>
                {label}
              </button>
            ))}
          </div>
        </>
      )}
      <Reply msg={action.msg} />
    </article>
  );
}
