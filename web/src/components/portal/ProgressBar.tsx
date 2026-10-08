import { Check, Circle, Loader, X } from "lucide-react";
import s from "./portal.module.css";

export type StepState = "pending" | "active" | "done" | "failed";

const STATE_WORD: Record<StepState, string> = { done: "done", active: "in progress", failed: "failed", pending: "not yet" };

export function StepIcon({ state, size = 16 }: { state: StepState; size?: number }) {
  if (state === "done") return <Check size={size} aria-hidden="true" />;
  if (state === "failed") return <X size={size} aria-hidden="true" />;
  if (state === "active") return <Loader size={size} aria-hidden="true" className={s.spin} />;
  return <Circle size={size - 4} aria-hidden="true" />;
}

/** The case status bar, the same on the donor, NGO and delivery partner screens. */
export default function ProgressBar({ steps }: { steps: { key: string; label: string; state: StepState }[] }) {
  return (
    <ol className={s.progress} style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
      {steps.map((p) => (
        <li key={p.key} data-state={p.state} aria-label={`${p.label}: ${STATE_WORD[p.state]}`}>
          <span className={s.progressDot}>
            <StepIcon state={p.state} size={14} />
          </span>
          <span className={s.progressLabel}>{p.label}</span>
        </li>
      ))}
    </ol>
  );
}

/** NOW / NEXT lines under a status bar. */
export function NowNext({ now, next }: { now: string; next?: string | null }) {
  return (
    <div className={s.nowNext}>
      <span className={s.nowTag}>Now</span>
      <span className={s.nowText}>{now}</span>
      {next && (
        <>
          <span className={s.nowTag} data-next="true">
            Next
          </span>
          <span className={s.nextText}>{next}</span>
        </>
      )}
    </div>
  );
}
