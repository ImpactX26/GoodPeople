"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Bike, ChevronLeft, HandHeart, Pause, Play, Store, type LucideIcon } from "lucide-react";
import LunaMark from "@/components/brand/LunaMark";
import {
  caseListings,
  modelName,
  useTraceStream,
  type AgentName,
  type CaseListing,
  type Person,
  type Point,
  type ReasoningStatus,
  type Thought,
  type TraceEvent,
  type Verdict,
  type WatchPulse,
} from "@/lib/luna/console";
import { usePoll } from "@/lib/luna/usePoll";
import ViewSwitch, { type AgentsView } from "@/components/agents-board/ViewSwitch";
import s from "./console.module.css";

/* ---------- the stations, left to right in the order food travels ---------- */

type Lane = { name: string; short: string; sub: string; icon?: LucideIcon };
const LANES: Lane[] = [
  { name: "Restaurant", short: "Rest.", sub: "phone", icon: Store },
  { name: "Food", short: "Food", sub: "agent" },
  { name: "Decision", short: "Dec.", sub: "agent" },
  { name: "NGO", short: "NGO", sub: "agent" },
  { name: "Logistics", short: "Log.", sub: "agent" },
  { name: "NGO", short: "NGO", sub: "phone", icon: HandHeart },
  { name: "Rider", short: "Rider", sub: "phone", icon: Bike },
];
const N = LANES.length;
const AGENT_LANE: Record<AgentName, number> = { food: 1, decision: 2, ngo: 3, logistics: 4 };
const PERSON_LANE: Partial<Record<Person, number>> = { donor: 0, ngo: 5, partner: 6 };
const AGENT: Record<AgentName, string> = { food: "Food", decision: "Decision", ngo: "NGO", logistics: "Logistics" };
const PERSON: Record<Person, string> = { donor: "Restaurant", ngo: "NGO", partner: "Rider", person: "Person" };
const POINT: Record<Point, string> = { intake: "Passport check", meals: "Meal pairing", plan: "Plan check", partner: "Partner check", problem: "Problem check", watch: "Watch", debrief: "Debrief" };
const VERDICT: Record<Verdict, string> = { agree: "Agreed", concern: "Concern", would_change: "Would change" };
const KIND: Record<string, string> = {
  listed: "listed",
  review: "case",
  graded: "graded",
  filtered: "filtered out",
  ranked: "ranked",
  picked_up: "picked up",
  gap_outreach: "asked for food",
  message_failed: "message failed",
};
const TOOL: Record<string, string> = { pair_meals: "Pair into meals", reorder_backups: "Move backups", flag_for_admin: "Flag for a person", nudge_partner: "Nudge the rider" };

/** Text block width, in lanes: wide enough to read, anchored where the mark is. */
const SPAN = 4;
const KEEP = 600;

/* ---------- rows: what the call sheet prints ---------- */

type Base = { key: string; at: number; seq: number; listingId?: string };
type Row =
  | (Base & { kind: "call"; from: AgentName; to: AgentName; task: string })
  | (Base & { kind: "message"; from: AgentName; to: Person; text: string; more: string[] })
  | (Base & { kind: "rule"; agent: AgentName; decision: string; reason: string; ms?: number; more: string[] })
  | (Base & { kind: "thought"; thought: Thought });

const GROUPED = new Set(["filtered", "gap_outreach"]);

/** Adds one event to the sheet: new row, a row that grows (a run of the same rule), or a slip that finishes. */
function absorb(rows: Row[], e: TraceEvent): Row[] {
  const base = { at: e.at, seq: e.seq, listingId: e.type === "thought" ? e.thought.listingId : e.listingId };
  const last = rows.at(-1);
  switch (e.type) {
    case "thought": {
      const key = `t:${e.thought.id}`;
      const i = rows.findIndex((r) => r.key === key);
      if (i >= 0) return rows.map((r, j) => (j === i ? ({ ...r, thought: e.thought, listingId: e.thought.listingId ?? r.listingId } as Row) : r));
      return [...rows, { ...base, key, kind: "thought", thought: e.thought }];
    }
    case "decision": {
      // The reasoning's own flags print on its slip, not twice.
      if (e.byReasoning) return rows;
      if (GROUPED.has(e.kind) && last?.kind === "rule" && last.decision === e.kind && last.agent === e.agent && last.listingId === e.listingId)
        return [...rows.slice(0, -1), { ...last, more: [...last.more, e.reason] }];
      return [...rows, { ...base, key: `d:${e.seq}:${e.at}`, kind: "rule", agent: e.agent, decision: e.kind, reason: e.reason, ms: e.ms, more: [] }];
    }
    case "handoff":
      return [...rows, { ...base, key: `h:${e.seq}:${e.at}`, kind: "call", from: e.from, to: e.to, task: e.task }];
    case "message": {
      if (PERSON_LANE[e.to] === undefined) return rows;
      // City-wide outreach to many restaurants reads as one row.
      if (!e.listingId && last?.kind === "message" && !last.listingId && last.to === e.to) return [...rows.slice(0, -1), { ...last, more: [...last.more, e.text] }];
      return [...rows, { ...base, key: `m:${e.seq}:${e.at}`, kind: "message", from: e.from ?? "decision", to: e.to, text: e.text, more: [] }];
    }
  }
}

const order = (a: TraceEvent, b: TraceEvent) => a.at - b.at || a.seq - b.seq;

/* ---------- small formatters ---------- */

const pad = (n: number) => String(n).padStart(2, "0");
const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const seconds = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/* ---------- the screen ---------- */

type Show = "all" | "calls" | "reasoning";

export default function AgentConsole({ view = "sheet" }: { view?: AgentsView }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [printed, setPrinted] = useState(0);
  const [status, setStatus] = useState<ReasoningStatus | null>(null);
  const [pulses, setPulses] = useState<WatchPulse[]>([]);
  const [show, setShow] = useState<Show>("all");
  const [caseId, setCaseId] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sheet = useRef<HTMLDivElement>(null);

  const conn = useTraceStream({
    snapshot(events, st) {
      const built = [...events].sort(order).reduce(absorb, [] as Row[]).slice(-KEEP);
      setRows(built);
      setPrinted(built.length);
      setStatus(st);
    },
    events(batch) {
      setRows((prev) => {
        const next = [...batch].sort(order).reduce(absorb, prev);
        const over = next.length - KEEP;
        if (over > 0) setPrinted((p) => Math.max(0, p - over));
        return over > 0 ? next.slice(over) : next;
      });
    },
    status: setStatus,
    pulse: (p) => setPulses((prev) => [...prev, p].slice(-20)),
  });

  const cases = usePoll(caseListings, 5000);

  // The printer: one call at a time so the hand-offs can be followed, faster when it falls behind.
  const waiting = rows.length - printed;
  useEffect(() => {
    if (paused || waiting <= 0) return;
    const id = setTimeout(() => setPrinted((p) => Math.min(p + 1, rows.length)), waiting > 12 ? 60 : 280);
    return () => clearTimeout(id);
  }, [paused, waiting, printed, rows.length]);

  // A call landing lights the station or phone it reached (the head remounts per call, so its animation replays).
  const newest = printed > 0 ? rows[printed - 1] : undefined;
  const landing = newest?.kind === "call" ? AGENT_LANE[newest.to] : newest?.kind === "message" ? PERSON_LANE[newest.to] : undefined;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Stay on the newest call unless the reader scrolled back.
  useEffect(() => {
    if (follow && sheet.current) sheet.current.scrollTop = sheet.current.scrollHeight;
  }, [printed, follow, show, caseId]);

  const caseNo = useMemo(() => {
    const m = new Map<string, number>();
    [...(cases.data ?? [])].sort((a, b) => a.createdAt - b.createdAt).forEach((l, i) => m.set(l.id, i + 1));
    return m;
  }, [cases.data]);

  const visible = useMemo(
    () =>
      rows.slice(0, printed).filter((r) => {
        if (caseId && r.listingId !== caseId) return false;
        if (show === "calls") return r.kind === "call" || r.kind === "message";
        if (show === "reasoning") return r.kind === "thought";
        return true;
      }),
    [rows, printed, caseId, show],
  );

  const thoughts = useMemo(() => rows.filter((r): r is Extract<Row, { kind: "thought" }> => r.kind === "thought").map((r) => r.thought), [rows]);
  const busy = new Set(thoughts.filter((t) => t.status === "thinking").map((t) => AGENT_LANE[t.agent]));
  const shown = (picked && thoughts.find((t) => t.id === picked)) || [...thoughts].reverse().find((t) => t.status !== "thinking" && (!caseId || t.listingId === caseId)) || null;

  const lastPulse = pulses.at(-1);
  const nextLook = lastPulse && status ? Math.max(0, Math.ceil((lastPulse.at + status.watchEveryMs - now) / 1000)) : null;

  return (
    <div className={s.screen}>
      {/* ---------- Printer bar ---------- */}
      <header className={s.bar}>
        <div className={s.brand}>
          <Link href="/admin" className={s.back} aria-label="Back to the food map">
            <ChevronLeft size={18} aria-hidden="true" />
          </Link>
          <LunaMark size={26} title="Luna" className={s.barMark} />
          <h1 className={s.title}>
            Call sheet
            <span className={s.city}>Bengaluru</span>
          </h1>
          <span className={s.chip} data-state={conn}>
            <span className={s.led} data-busy={conn !== "live" || busy.size > 0} aria-hidden="true" />
            {conn === "live" ? (busy.size ? "Reasoning" : "Live") : conn === "denied" ? "Admins only" : conn === "retrying" ? "Reconnecting" : "Connecting"}
          </span>
        </div>
        <div className={s.controls}>
          <ViewSwitch view={view} groupClass={s.segmented} itemClass={s.segment} />
          <div className={s.segmented} role="radiogroup" aria-label="Show">
            {(
              [
                ["all", "Everything"],
                ["calls", "Hand-offs"],
                ["reasoning", "Reasoning"],
              ] as [Show, string][]
            ).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={show === v} className={s.segment} onClick={() => setShow(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <nav className={s.account} aria-label="Admin">
          <Link href="/admin" className={s.barButton}>
            Food map
          </Link>
          <Link href="/admin/reviews" className={s.barButton}>
            Reviews
          </Link>
        </nav>
      </header>

      {/* ---------- The rail: one ticket per case ---------- */}
      <section className={s.railWrap} aria-labelledby="cases-title">
        <h2 id="cases-title" className={s.railTitle}>
          Cases on the pass
        </h2>
        <div className={s.rail}>
          <ol className={s.tickets}>
            <li>
              <button type="button" className={`${s.ticket} ${s.ticketAll}`} data-on={caseId === null} aria-pressed={caseId === null} onClick={() => setCaseId(null)}>
                <span className={s.tRank}>All</span>
                <span className={s.tName}>Every case</span>
                <span className={s.tNote}>Calls from all stations, as they happen.</span>
              </button>
            </li>
            {(cases.data ?? []).slice(0, 14).map((l) => (
              <CaseTicket key={l.id} l={l} n={caseNo.get(l.id)} on={caseId === l.id} thoughts={thoughts.filter((t) => t.listingId === l.id)} onPick={() => setCaseId(caseId === l.id ? null : l.id)} />
            ))}
            {cases.data === null && Array.from({ length: 4 }, (_, i) => <li key={i} className={`${s.ticket} ${s.ticketBlank}`} aria-hidden="true" />)}
          </ol>
        </div>
      </section>

      {/* ---------- The call sheet and the reasoning slip ---------- */}
      <main className={s.body}>
        <section className={s.sheetWrap} aria-label="Call sheet">
          <div className={s.heads} aria-hidden="true">
            <span className={s.headTime}>Time</span>
            <div className={s.headLanes}>
              {LANES.map((lane, i) => (
                <LaneHead key={landing === i ? newest!.key : i} lane={lane} busy={busy.has(i)} hit={landing === i} />
              ))}
            </div>
          </div>
          <div
            className={s.sheet}
            ref={sheet}
            onScroll={(e) => {
              const el = e.currentTarget;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
          >
            <div className={s.paper}>
            <div className={s.guides} aria-hidden="true">
              {LANES.map((_, i) => (
                <span key={i} />
              ))}
            </div>
            {visible.length === 0 ? (
              <p className={s.empty}>
                {conn === "denied"
                  ? "The agent console is for Luna admins. Sign in with an admin account to watch the stations."
                  : caseId
                    ? "Nothing printed for this case yet."
                    : "Nothing has been called yet. List food from a donor phone and watch the stations call it through."}
              </p>
            ) : (
              <ol className={s.calls} aria-live="polite">
                {visible.map((r) => (
                  <CallRow key={r.key} r={r} n={r.listingId ? caseNo.get(r.listingId) : undefined} fresh={r === newest} picked={r.kind === "thought" && r.thought.id === shown?.id} onPick={(id) => setPicked(id)} />
                ))}
              </ol>
            )}
            </div>
          </div>
          {!follow && (
            <button
              type="button"
              className={s.latest}
              onClick={() => {
                setFollow(true);
                if (sheet.current) sheet.current.scrollTop = sheet.current.scrollHeight;
              }}
            >
              <ArrowDown size={15} aria-hidden="true" /> Back to the latest call
            </button>
          )}
        </section>

        <aside className={s.slipCol} aria-label="Reasoning">
          <ReasoningSlip t={shown} pinned={!!picked && shown?.id === picked} n={shown?.listingId ? caseNo.get(shown.listingId) : undefined} onUnpin={() => setPicked(null)} />
          <ModelCard status={status} now={now} />
        </aside>
      </main>

      {/* ---------- The tape: printing controls and the watcher ---------- */}
      <footer className={s.tape}>
        <div className={s.tapeControls}>
          <button type="button" className={s.iconButton} data-on={paused} aria-pressed={paused} aria-label={paused ? "Resume printing" : "Pause printing"} onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={17} aria-hidden="true" /> : <Pause size={17} aria-hidden="true" />}
          </button>
          <span className={s.waiting}>{paused && waiting > 0 ? `${waiting} call${waiting > 1 ? "s" : ""} waiting` : paused ? "Paused" : "Printing live"}</span>
        </div>
        <div className={s.watch}>
          <div className={s.watchCells} aria-hidden="true">
            {Array.from({ length: 20 }, (_, i) => {
              const p = pulses[pulses.length - 20 + i];
              return <span key={i} data-state={!p ? "none" : p.noticed.length ? "noticed" : p.live ? "live" : "quiet"} />;
            })}
          </div>
          <p className={s.readout}>
            <strong>Watcher</strong>
            {lastPulse ? (
              <>
                {" "}
                · looked at {lastPulse.live} live case{lastPulse.live === 1 ? "" : "s"} · {lastPulse.noticed.length ? <span className={s.red}>noticed {lastPulse.noticed.length}</span> : "nothing off"}
                {nextLook !== null && <> · next look in {nextLook} s</>}
              </>
            ) : (
              " · first look within 30 s"
            )}
          </p>
        </div>
      </footer>
    </div>
  );
}

/* ---------- pieces ---------- */

function LaneHead({ lane, busy, hit }: { lane: Lane; busy: boolean; hit: boolean }) {
  const Icon = lane.icon;
  if (Icon)
    return (
      <div className={s.phone} data-hit={hit}>
        <Icon size={15} aria-hidden="true" />
        <span className={s.headName}>{lane.name}</span>
        <span className={s.headShort}>{lane.short}</span>
        <span className={s.headSub}>{lane.sub}</span>
      </div>
    );
  return (
    <div className={s.station} data-hit={hit}>
      <span className={s.led} data-busy={busy} />
      <span className={s.headName}>{lane.name}</span>
      <span className={s.headShort}>{lane.short}</span>
      <span className={s.headSub}>{busy ? "reasoning" : lane.sub}</span>
    </div>
  );
}

function CaseTicket({ l, n, on, thoughts, onPick }: { l: CaseListing; n?: number; on: boolean; thoughts: Thought[]; onPick: () => void }) {
  const servings = l.items.reduce((k, i) => k + i.servings, 0);
  const flagged = thoughts.some((t) => t.actions?.some((a) => a.tool === "flag_for_admin" && a.status === "done"));
  const stage = l.lapsed ? (l.lapsed.cause === "in_transit" ? "Stopped: unsafe" : "No one responded") : { review: "Waiting for a review", matching: "Finding homes", matched: "On its way", partially_matched: "Partly placed", unmatched: "Nowhere safe yet", closed: "Closed" }[l.status];
  const checks = thoughts.filter((t) => t.status === "done").length;
  return (
    <li>
      <button type="button" className={s.ticket} data-on={on} aria-pressed={on} data-urgent={flagged || l.status === "unmatched"} onClick={onPick}>
        <span className={s.tRank}>{n ? `#${n}` : "Case"}</span>
        <span className={s.tName}>{l.donorName}</span>
        <span className={s.tServings}>
          {servings}
          <small>servings</small>
        </span>
        <span className={s.tNote}>
          {stage}
          {checks ? ` · ${checks} check${checks > 1 ? "s" : ""}` : ""}
          {flagged ? " · flagged" : ""}
        </span>
      </button>
    </li>
  );
}

/** Where a row's text starts: under its mark (the lane's centre), leaning left near the right edge. */
const textAt = (lane: number) => ({ "--x": Math.max(0, Math.min(lane + 0.5, N - SPAN)) }) as CSSProperties;

function Meta({ at, n }: { at: number; n?: number }) {
  return (
    <div className={s.meta}>
      <time>{clock(at)}</time>
      {n ? <span className={s.caseChip}>#{n}</span> : null}
    </div>
  );
}

function CallRow({ r, n, fresh, picked, onPick }: { r: Row; n?: number; fresh: boolean; picked: boolean; onPick: (id: string) => void }) {
  if (r.kind === "call" || r.kind === "message") {
    const a = AGENT_LANE[r.from];
    const b = r.kind === "call" ? AGENT_LANE[r.to] : PERSON_LANE[r.to]!;
    const left = b < a;
    return (
      <li className={s.row} data-kind={r.kind} data-fresh={fresh}>
        <Meta at={r.at} n={n} />
        <div className={s.lanes}>
          <span className={s.arrow} data-left={left} data-dashed={r.kind === "message"} style={{ "--l": Math.min(a, b), "--w": Math.abs(a - b) } as CSSProperties}>
            {r.kind === "call" && <span className={s.heard}>Heard</span>}
          </span>
          <div className={s.text} style={textAt(Math.min(a, b))}>
            <p className={s.label}>
              {AGENT[r.from]} <ArrowRight size={12} aria-label="to" /> {r.kind === "call" ? AGENT[r.to] : PERSON[r.to]}
              {r.kind === "message" && r.more.length > 0 && <span className={s.count}>×{r.more.length + 1}</span>}
            </p>
            <p className={r.kind === "call" ? s.say : s.said}>{r.kind === "call" ? r.task : r.text.split("\n")[0]}</p>
          </div>
        </div>
      </li>
    );
  }
  if (r.kind === "rule") {
    const lane = AGENT_LANE[r.agent];
    const urgent = r.decision === "escalated" || r.decision === "message_failed";
    return (
      <li className={s.row} data-kind="rule" data-fresh={fresh}>
        <Meta at={r.at} n={n} />
        <div className={s.lanes}>
          <span className={s.dot} style={{ "--l": lane } as CSSProperties} />
          <div className={s.text} style={textAt(lane)}>
            <p className={s.label}>
              {AGENT[r.agent]} · rules · <span className={urgent ? s.red : undefined}>{KIND[r.decision] ?? r.decision.replace(/_/g, " ")}</span>
              {r.more.length > 0 && <span className={s.count}>×{r.more.length + 1}</span>}
              {r.ms !== undefined && <span className={s.speed}>{r.ms < 1 ? "<1 ms" : `${Math.round(r.ms)} ms`}</span>}
            </p>
            <p className={s.reason}>{r.reason}</p>
            {r.more.length > 0 && (
              <details className={s.more}>
                <summary>Show the other {r.more.length}</summary>
                <ul>
                  {r.more.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        </div>
      </li>
    );
  }
  const t = r.thought;
  const lane = AGENT_LANE[t.agent];
  return (
    <li className={s.row} data-kind="thought" data-fresh={fresh}>
      <Meta at={t.at} n={n} />
      <div className={s.lanes}>
        <span className={s.hollow} data-thinking={t.status === "thinking"} style={{ "--l": lane } as CSSProperties} />
        <button type="button" className={s.thoughtSlip} style={textAt(lane)} data-picked={picked} data-status={t.status} onClick={() => onPick(t.id)} aria-label={`Read ${AGENT[t.agent]} reasoning in full`}>
          <span className={s.label}>
            {AGENT[t.agent]} · reasoning · {POINT[t.point]}
            {t.ms !== undefined && <span className={s.speed}>{seconds(t.ms)}</span>}
          </span>
          {t.status === "thinking" ? (
            <span className={s.thinking}>
              Looking at: {t.about}
              <span className={s.caret} aria-hidden="true" />
            </span>
          ) : t.status === "done" ? (
            <>
              <Stamps t={t} />
              {t.headline && <span className={s.headline}>{t.headline}</span>}
              {(t.reasoning ?? []).slice(0, 3).map((line, i) => (
                <span key={i} className={s.because}>
                  {line}
                </span>
              ))}
              {(t.actions ?? []).map((a, i) => (
                <span key={i} className={s.action} data-status={a.status}>
                  <span>{TOOL[a.tool] ?? a.tool}</span>
                  <span className={s.leaderDots} aria-hidden="true" />
                  <strong>{a.status === "done" ? "Done" : "Blocked"}</strong>
                </span>
              ))}
              <span className={s.model}>{modelName(t.model)}</span>
            </>
          ) : (
            <>
              <span className={s.stamps}>
                <span className={s.stamp} data-tone={t.status === "failed" ? "red" : "faded"}>
                  {t.status === "failed" ? "No answer" : "Skipped"}
                </span>
              </span>
              <span className={s.because}>The rules carried on without it. {t.error ? t.error.split(" | ")[0] : ""}</span>
            </>
          )}
        </button>
      </div>
    </li>
  );
}

function Stamps({ t }: { t: Thought }) {
  const flagged = t.actions?.some((a) => a.tool === "flag_for_admin" && a.status === "done");
  return (
    <span className={s.stamps}>
      {t.verdict && (
        <span className={s.stamp} data-tone={t.verdict}>
          {VERDICT[t.verdict]}
        </span>
      )}
      {flagged && (
        <span className={s.stamp} data-tone="red">
          Flagged
        </span>
      )}
    </span>
  );
}

function Leader({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={s.leader}>
      <span className={s.leaderLabel}>{label}</span>
      <span className={s.leaderDots} aria-hidden="true" />
      <span className={s.leaderValue}>{children}</span>
    </div>
  );
}

function ReasoningSlip({ t, pinned, n, onUnpin }: { t: Thought | null; pinned: boolean; n?: number; onUnpin: () => void }) {
  if (!t)
    return (
      <div className={s.slip}>
        <h2 className={s.slipTitle}>Reasoning</h2>
        <p className={s.slipNote}>Each agent&rsquo;s rules decide in milliseconds. About a second later its reasoning checks the call, says why, and can act within what the rules allow. It prints here.</p>
      </div>
    );
  return (
    <div className={s.slip} key={t.id}>
      <div className={s.printIn}>
        <h2 className={s.slipTitle}>{AGENT[t.agent]} agent</h2>
        <p className={s.slipWhen}>
          {POINT[t.point]}
          {n ? ` · case #${n}` : ""} · {clock(t.doneAt ?? t.at)}
          {pinned ? (
            <button type="button" className={s.linkButton} onClick={onUnpin}>
              Follow the latest
            </button>
          ) : null}
        </p>
        <p className={s.slipNote}>{t.about}</p>
        {t.status === "done" && <Stamps t={t} />}
        {t.headline && <p className={s.slipHeadline}>{t.headline}</p>}
        {t.status === "thinking" && <p className={s.slipNote}>Thinking&hellip;</p>}
        {(t.status === "failed" || t.status === "skipped") && <p className={s.slipNote}>No model answered, so the rules carried on alone. {t.error}</p>}
        {!!t.reasoning?.length && (
          <>
            <hr className={s.rule} />
            <h3 className={s.slipHeading}>Why</h3>
            <ul className={s.why}>
              {t.reasoning.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </>
        )}
        {t.alternative && (
          <>
            <h3 className={s.slipHeading}>Would instead</h3>
            <p className={s.slipBody}>{t.alternative}</p>
          </>
        )}
        {!!t.actions?.length && (
          <>
            <hr className={s.rule} />
            <h3 className={s.slipHeading}>Actions, through the guardrails</h3>
            {t.actions.map((a, i) => (
              <div key={i} className={s.actionBlock}>
                <Leader label={TOOL[a.tool] ?? a.tool}>
                  <span className={a.status === "blocked" ? s.blocked : undefined}>{a.status === "done" ? "Done" : "Blocked"}</span>
                </Leader>
                <p className={s.actionNote}>{a.note}</p>
              </div>
            ))}
          </>
        )}
        {t.status === "done" && (
          <>
            <hr className={s.rule} />
            <Leader label="Model">{modelName(t.model)}</Leader>
            <Leader label="Answered in">{seconds(t.ms)}</Leader>
            {t.tokens ? <Leader label="Tokens">{t.tokens.toLocaleString("en-IN")}</Leader> : null}
            {t.confidence !== undefined && <Leader label="Confidence">{Math.round(t.confidence * 100)}%</Leader>}
          </>
        )}
      </div>
    </div>
  );
}

function ModelCard({ status, now }: { status: ReasoningStatus | null; now: number }) {
  return (
    <div className={s.card}>
      <h2 className={s.slipHeading}>Models</h2>
      {!status ? (
        <p className={s.slipNote}>Connecting&hellip;</p>
      ) : !status.enabled ? (
        <p className={s.slipNote}>Reasoning is off on the server: no model key is set. The rules run alone.</p>
      ) : (
        <>
          {status.providers.map((p, i) => {
            const resting = (p.coolingUntil ?? 0) > now;
            return (
              <Leader key={p.model} label={`${i === 0 ? "First" : "Then"} · ${modelName(p.model)}`}>
                {resting ? <span className={s.red}>resting</span> : `${p.calls} call${p.calls === 1 ? "" : "s"}${p.lastMs ? ` · ${seconds(p.lastMs)}` : ""}`}
              </Leader>
            );
          })}
          <Leader label="Today">
            {status.callsToday} of {status.cap} calls
          </Leader>
        </>
      )}
    </div>
  );
}
