"use client";

import { useState, type ReactNode } from "react";
import { ApiError } from "@/lib/luna/api";
import type { Result } from "@/lib/luna/agents";
import { useNow } from "@/lib/luna/usePoll";
import s from "./agents.module.css";

/** Runs an agent action: disables the button while busy and shows the agent's reply or error. */
export function useAction(after?: () => void) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function run(fn: () => Promise<Result | unknown>) {
    setBusy(true);
    setMsg(null);
    try {
      const r = (await fn()) as Partial<Result> | undefined;
      if (r && r.ok === false && "error" in r) setMsg({ ok: false, text: String(r.error) });
      else if (r && r.ok && "message" in r && r.message) setMsg({ ok: true, text: r.message });
      after?.();
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.message : "Something went wrong." });
    } finally {
      setBusy(false);
    }
  }
  return { busy, msg, run };
}

export function Reply({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return msg.ok ? (
    <p className={s.ok} role="status">
      {msg.text}
    </p>
  ) : (
    <p className={s.error} role="alert">
      {msg.text}
    </p>
  );
}

export function Countdown({ until, label = "left" }: { until: number; label?: string }) {
  const now = useNow();
  const left = Math.max(0, until - now);
  const m = Math.floor(left / 60_000);
  const sec = Math.floor((left % 60_000) / 1000);
  return (
    <span className={s.countdown} data-low={left < 60_000}>
      {left ? `${m}:${String(sec).padStart(2, "0")} ${label}` : "time's up"}
    </span>
  );
}

export function Stamp({ children, tone }: { children: ReactNode; tone?: "urgent" | "done" }) {
  return (
    <span className={s.stamp} data-tone={tone}>
      {children}
    </span>
  );
}

export function BigCode({ code, label }: { code: string; label: string }) {
  return (
    <div className={s.bigCode}>
      <span>{label}</span>
      <strong>{code}</strong>
    </div>
  );
}

/** A 4-digit code box with a confirm button. */
export function CodeEntry({ label, onSubmit, busy }: { label: string; onSubmit: (code: string) => void; busy: boolean }) {
  const [code, setCode] = useState("");
  return (
    <form
      className={s.row}
      onSubmit={(e) => {
        e.preventDefault();
        if (code.length === 4) onSubmit(code);
      }}
    >
      <label className={s.field}>
        <span className={s.label}>{label}</span>
        <input
          className={`${s.box} ${s.code}`}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={4}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
          aria-label={label}
        />
      </label>
      <button type="submit" className={s.primary} disabled={busy || code.length !== 4} style={{ alignSelf: "end" }}>
        Confirm
      </button>
    </form>
  );
}

export const STATUS: Record<string, string> = {
  review: "Being checked",
  matching: "Matching",
  matched: "Matched",
  partially_matched: "Partly matched",
  unmatched: "No match",
  closed: "Done",
  offering: "Offered",
  finding_partner: "Finding partner",
  assigned: "Partner coming",
  picked_up: "On the way",
  delivered: "Delivered",
  unplaced: "Passed on",
  failed: "Stopped",
};
