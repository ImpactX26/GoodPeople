"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import LunaMark from "@/components/brand/LunaMark";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "./ticket.module.css";

/** Logo intro on the sign-in screen: the printer feeds a stub, the moon rolls onto it, the rest feeds out. */
export type IntroPhase = "feed" | "roll" | "reveal" | "done";

export function Counter({
  busy = false,
  intro = "done",
  children,
}: {
  busy?: boolean;
  intro?: IntroPhase;
  children: ReactNode;
}) {
  return (
    <main className={s.counter} data-intro={intro}>
      <div className={s.printer} aria-hidden="true">
        <span className={s.printerLight} data-busy={busy} />
      </div>
      {children}
    </main>
  );
}

export function Ticket({
  tearing = false,
  onTorn,
  children,
  label,
}: {
  tearing?: boolean;
  onTorn?: () => void;
  children: ReactNode;
  label?: string;
}) {
  return (
    <div
      className={`${s.ticketShadow} ${tearing ? s.tearing : ""}`}
      onAnimationEnd={(e) => {
        if (tearing && e.target === e.currentTarget) onTorn?.();
      }}
    >
      <section className={s.ticket} aria-label={label}>
        {children}
      </section>
    </div>
  );
}

/** Letters of the wordmark and how far each tips when it lands: A most, L least. */
const WORD = [
  { ch: "L", tip: 4 },
  { ch: "U", tip: 9 },
  { ch: "N", tip: 15 },
  { ch: "A", tip: 22 },
];

export function Masthead({ tagline, intro = "done" }: { tagline?: string; intro?: IntroPhase }) {
  return (
    <header className={s.masthead} data-intro={intro}>
      <p className={s.lockup}>
        <span className={s.markRoll}>
          <LunaMark size={40} title={null} state={intro === "feed" || intro === "roll" ? "full" : "logo"} />
        </span>
        <span className={s.wordClip}>
          <span className={s.wordmark} aria-label="LUNA">
            {WORD.map(({ ch, tip }, i) => (
              <span
                key={ch}
                className={s.letter}
                aria-hidden="true"
                style={{ "--i": i, "--order": WORD.length - 1 - i, "--tip": `${tip}deg` } as CSSProperties}
              >
                <span className={s.letterTip}>{ch}</span>
              </span>
            ))}
          </span>
        </span>
      </p>
      {tagline && <p className={s.tagline}>{tagline}</p>}
    </header>
  );
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

export function stamp(date: Date) {
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${String(date.getFullYear()).slice(2)}  ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Ticket number + live clock. Renders after mount so server and client agree. */
export function TicketMeta({ left }: { left: string }) {
  const hydrated = useHydrated();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className={s.meta}>
      <span>{left}</span>
      <span>{hydrated ? stamp(now) : "\u00a0"}</span>
    </div>
  );
}

export function Rule({ solid = false }: { solid?: boolean }) {
  return <hr className={solid ? s.ruleSolid : s.rule} />;
}

export function Heading({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 className={s.heading} id={id} tabIndex={-1}>
      {children}
    </h2>
  );
}

export function Leader({
  label,
  value,
  action,
}: {
  label: string;
  value: ReactNode;
  action?: { label: string; onClick: () => void; a11y?: string };
}) {
  return (
    <div className={s.leader}>
      <span className={s.leaderLabel}>{label}</span>
      <span className={s.leaderDots} aria-hidden="true" />
      <span className={s.leaderValue}>{value}</span>
      {action && (
        <button type="button" className={s.leaderAction} onClick={action.onClick} aria-label={action.a11y}>
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Content that prints in with a stepped line-feed reveal. Change `k` to reprint. */
export function PrintIn({
  children,
  lines = 7,
  className = "",
}: {
  children: ReactNode;
  lines?: number;
  className?: string;
}) {
  const style = {
    "--print-steps": lines,
    "--print-ms": `${Math.min(140 + lines * 48, 620)}ms`,
  } as CSSProperties;
  return (
    <div className={`${s.printIn} ${className}`} style={style}>
      {children}
    </div>
  );
}
