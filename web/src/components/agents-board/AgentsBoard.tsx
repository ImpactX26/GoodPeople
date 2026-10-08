"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { ArrowRight, Check, ChevronLeft, MessageCircle, X } from "lucide-react";
import LunaMark from "@/components/brand/LunaMark";
import { caseListings, modelName, useTraceStream, type AgentName, type CaseListing, type Connection, type Point, type TraceEvent, type Verdict } from "@/lib/luna/console";
import { useNow, usePoll } from "@/lib/luna/usePoll";
import { Mascot, type Mood } from "./Mascots";
import {
  AGENTS,
  COL,
  JOB,
  KIND,
  NAME,
  PERSON,
  STAGES,
  STATUS,
  WAITS,
  buildOrders,
  clock,
  currentStage,
  elapsed,
  laneStatus,
  ruleSpeed,
  seconds,
  withCase,
  type Call,
  type Order,
  type Status,
  type Step,
} from "./board";
import s from "./board.module.css";

const MOOD: Record<Status, Mood> = { waiting: "sleep", on: "busy", thinking: "think", watching: "awake", wrapping: "awake", done: "happy", flagged: "worried" };
const POINT: Record<Point, string> = { intake: "Passport check", meals: "Meal pairing", plan: "Plan check", partner: "Partner check", problem: "Problem check", watch: "Watch", debrief: "Debrief" };
const VERDICT: Record<Verdict, string> = { agree: "Agreed", concern: "Concern", would_change: "Would change" };
const TOOL: Record<string, string> = { pair_meals: "Pair into meals", reorder_backups: "Move backups", flag_for_admin: "Flag for a person", nudge_partner: "Nudge the rider" };

type Pace = "step" | "real";
/** One event at a time, slow enough to follow a hand-off across the board; faster when the printer falls behind. */
const PACE_MS: Record<Pace, number> = { step: 850, real: 90 };
const KEEP = 1200;
/** Listings on the board before the older ones fold away. */
const SHOW = 4;
const CLEARED = "luna.agentsBoard.clearedAt";

const bySeq = (a: TraceEvent, b: TraceEvent) => a.seq - b.seq;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The busiest thing any listing's lane is doing, for the cast at the top. */
const RANK: Status[] = ["thinking", "on", "flagged", "watching", "wrapping", "done", "waiting"];

export default function AgentsBoard() {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [printed, setPrinted] = useState(0);
  // Events after this seq arrived while the board was open: those animate. The snapshot prints still.
  const [liveFrom, setLiveFrom] = useState(Number.POSITIVE_INFINITY);
  const [pace, setPace] = useState<Pace>("step");
  // Only rendered after hydration (AgentsRoute waits), so storage can be read up front.
  const [clearedAt, setClearedAt] = useState(() => {
    try {
      return Number(localStorage.getItem(CLEARED)) || 0;
    } catch {
      return 0; // storage blocked: the board starts with everything
    }
  });
  const [showAll, setShowAll] = useState(false);
  // Whether an AI model is checking the rules at all on this server; null until the stream says.
  const [aiOn, setAiOn] = useState<boolean | null>(null);
  const now = useNow(1000);

  const conn = useTraceStream({
    snapshot(evs, st) {
      setAiOn(st.enabled);
      const sorted = [...evs].sort(bySeq);
      setEvents(sorted);
      setPrinted(sorted.length);
      setLiveFrom(sorted.at(-1)?.seq ?? 0);
    },
    events(batch) {
      setEvents((prev) => {
        const next = [...prev, ...[...batch].sort(bySeq)];
        const over = next.length - KEEP;
        if (over > 0) setPrinted((p) => Math.max(0, p - over));
        return over > 0 ? next.slice(over) : next;
      });
    },
    status: (st) => setAiOn(st.enabled),
    pulse() {},
  });

  const waiting = events.length - printed;
  useEffect(() => {
    if (waiting <= 0) return;
    const ms = pace === "real" ? PACE_MS.real : waiting > 14 ? 160 : PACE_MS.step;
    const id = setTimeout(() => setPrinted((p) => Math.min(p + 1, events.length)), ms);
    return () => clearTimeout(id);
  }, [waiting, printed, pace, events.length]);

  const cases = usePoll(caseListings, 5000);
  const caseById = useMemo(() => new Map((cases.data ?? []).map((l) => [l.id, l])), [cases.data]);
  const caseNo = useMemo(() => {
    const m = new Map<string, number>();
    [...(cases.data ?? [])].sort((a, b) => a.createdAt - b.createdAt).forEach((l, i) => m.set(l.id, i + 1));
    return m;
  }, [cases.data]);

  const orders = useMemo(() => buildOrders(events.slice(0, printed)).map((o) => withCase(o, caseById.get(o.id))), [events, printed, caseById]);
  const onBoard = orders.filter((o) => o.firstAt >= clearedAt);
  const folded = showAll ? 0 : Math.max(0, onBoard.length - SHOW);
  const shown = onBoard.slice(folded);

  const cast = useMemo(() => {
    const out = {} as Record<AgentName, Mood>;
    for (const a of AGENTS) {
      const best = shown.map((o) => laneStatus(o, a)).sort((x, y) => RANK.indexOf(x) - RANK.indexOf(y))[0];
      out[a] = !best || best === "waiting" ? "sleep" : best === "done" || best === "watching" ? "awake" : MOOD[best];
    }
    return out;
  }, [shown]);
  const anyBusy = Object.values(cast).some((m) => m === "busy" || m === "think");

  // A listing that arrives while the board is open scrolls into view, so the room sees its row print.
  const rows = useRef(new Map<string, HTMLLIElement>());
  const scrolled = useRef<string | null>(null);
  const newest = shown.at(-1);
  useEffect(() => {
    if (!newest || newest.firstSeq <= liveFrom || scrolled.current === newest.id) return;
    scrolled.current = newest.id;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rows.current.get(newest.id)?.scrollIntoView({ behavior: still ? "auto" : "smooth", block: "start" });
  }, [newest, liveFrom]);

  const clear = () => {
    const at = clearedAt ? 0 : Date.now();
    setClearedAt(at);
    setShowAll(false);
    try {
      if (at) localStorage.setItem(CLEARED, String(at));
      else localStorage.removeItem(CLEARED);
    } catch {
      /* storage blocked: the board clears for this visit only */
    }
  };

  const hiddenByClear = orders.length - onBoard.length;

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
            Agents at work
            <span className={s.city}>Bengaluru</span>
          </h1>
          <span className={s.chip} data-state={conn}>
            <span className={s.led} data-state={conn !== "live" ? "busy" : anyBusy ? "busy" : "ready"} aria-hidden="true" />
            {conn === "live" ? (anyBusy ? "Working" : "Live") : conn === "denied" ? "Admins only" : conn === "retrying" ? "Reconnecting" : "Connecting"}
          </span>
          {aiOn === false && <span className={s.barStamp}>AI check off</span>}
        </div>
        <div className={s.controls}>
          <div className={s.segmented} role="radiogroup" aria-label="Pace">
            {(
              [
                ["step", "Step by step"],
                ["real", "Real time"],
              ] as [Pace, string][]
            ).map(([v, label]) => (
              <button key={v} type="button" role="radio" aria-checked={pace === v} className={s.segment} onClick={() => setPace(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <nav className={s.account} aria-label="Board">
          <button type="button" className={s.barButton} onClick={clear}>
            <span className={s.long}>{clearedAt ? "Show earlier listings" : "Clear the board"}</span>
            <span className={s.short} aria-hidden="true">
              {clearedAt ? "Show all" : "Clear"}
            </span>
          </button>
          <Link href="/console" className={s.barButton}>
            Call sheet
          </Link>
          <Link href="/admin" className={s.barButton}>
            Food map
          </Link>
        </nav>
      </header>

      <main className={s.main}>
        {/* ---------- The cast ---------- */}
        <section className={s.castWrap} aria-labelledby="cast-title">
          <div className={s.cast}>
          <div className={s.castHead}>
            <h2 id="cast-title" className={s.castTitle}>
              Four agents, one listing
            </h2>
            <p className={s.castNote}>
              {aiOn === false
                ? "Each agent\u2019s rules decide in milliseconds. The AI check is off on this server, so the rules decide alone and no model judges the calls."
                : "Each agent\u2019s rules decide in milliseconds. About a second later an AI model checks the call, says why, and can step in within the rules."}
            </p>
          </div>
          <ol className={s.castList}>
            {AGENTS.map((a) => (
              <li key={a} className={s.castItem}>
                <Mascot agent={a} mood={cast[a]} size={92} className={s.castSticker} />
                <div>
                  <h3 className={s.castName}>{NAME[a]}</h3>
                  <p className={s.castJob}>{JOB[a]}</p>
                </div>
              </li>
            ))}
          </ol>
          </div>
        </section>

        {folded > 0 && (
          <button type="button" className={s.earlier} onClick={() => setShowAll(true)}>
            Show {plural(folded, "earlier listing")}
          </button>
        )}

        {shown.length === 0 ? (
          <Empty conn={conn} cleared={hiddenByClear > 0} />
        ) : (
          <ol className={s.orders}>
            {shown.map((o) => (
              <OrderRow
                key={o.id}
                o={o}
                l={caseById.get(o.id)}
                n={caseNo.get(o.id)}
                liveFrom={liveFrom}
                now={now}
                rowRef={(el) => {
                  if (el) rows.current.set(o.id, el);
                  else rows.current.delete(o.id);
                }}
              />
            ))}
          </ol>
        )}
      </main>
    </div>
  );
}

/* ---------- one listing: its order slip, four printers and the hand-offs ---------- */

function OrderRow({ o, l, n, liveFrom, now, rowRef }: { o: Order; l?: CaseListing; n?: number; liveFrom: number; now: number; rowRef: (el: HTMLLIElement | null) => void }) {
  const servings = l?.items.reduce((k, i) => k + i.servings, 0);
  const donor = l?.donorName ?? o.passport?.split(" from ").at(1) ?? "New listing";
  const food = l?.items
    .map((i) => i.name)
    .filter(Boolean)
    .join(", ");
  const start = l?.createdAt ?? o.firstAt;
  const end = o.closedAt ?? o.deliveredAt;
  const took = (end ?? now) - start;
  const stage = currentStage(o);
  const deliveredSeq = o.stages.delivered;
  return (
    <li className={s.order} ref={rowRef} data-live={o.firstSeq > liveFrom} data-done={end !== undefined}>
      <div className={s.slipWrap}>
      <header className={s.slip}>
        {deliveredSeq !== undefined && (
          <span className={s.bigStamp} data-live={deliveredSeq > liveFrom} aria-hidden="true">
            Delivered
          </span>
        )}
        <span className={s.no}>{n ? `#${n}` : "New"}</span>
        <div className={s.slipText}>
          <h2 className={s.donor}>{donor}</h2>
          <p className={s.slipMeta}>
            {servings ? plural(servings, "serving") : (o.passport?.split(" from ")[0] ?? "")}
            {food ? ` · ${food}` : ""}
          </p>
          <p className={s.slipTime}>
            Listed {clock(start)} · <strong>{end !== undefined ? `took ${elapsed(took)}` : `${elapsed(took)} so far`}</strong>
          </p>
        </div>
        <ol className={s.stages} aria-label="Where the food is">
          {STAGES.map((st) => {
            const doneAt = o.stages[st.key];
            const isNow = stage === st.key;
            const state = o.stopped && isNow ? "stopped" : doneAt !== undefined ? "done" : isNow ? "now" : "next";
            return (
              <li key={st.key} className={s.stage} data-state={state} aria-current={isNow ? "step" : undefined}>
                <span className={s.stageMark} data-stamp={state === "done" && doneAt! > liveFrom}>
                  {state === "done" ? <Check size={16} strokeWidth={3} aria-hidden="true" /> : state === "stopped" ? <X size={16} strokeWidth={3} aria-hidden="true" /> : null}
                </span>
                <span className={s.stageLabel}>{st.label}</span>
                <span className="visually-hidden">{state === "done" ? ", done" : state === "now" ? ", now" : state === "stopped" ? ", stopped" : ""}</span>
              </li>
            );
          })}
        </ol>
      </header>
      </div>

      <Handoffs calls={o.calls} liveFrom={liveFrom} done={end !== undefined} />

      <div className={s.stations}>
        {AGENTS.map((a) => (
          <Station key={a} o={o} agent={a} liveFrom={liveFrom} />
        ))}
      </div>
    </li>
  );
}

function Station({ o, agent, liveFrom }: { o: Order; agent: AgentName; liveFrom: number }) {
  const [open, setOpen] = useState(false);
  const lane = o.lanes[agent];
  const status = laneStatus(o, agent);
  // A hand-off landing makes the sticker hop: its wrapper remounts per call, so the animation replays.
  const heard = lane.asked && lane.asked.seq > liveFrom ? lane.asked.key : "rest";
  const hidden = open ? 0 : Math.max(0, lane.steps.length - 4);
  return (
    <section className={s.station} data-agent={agent} data-status={status} aria-label={`${NAME[agent]}: ${STATUS[status]}`}>
      <div className={s.housing}>
        <span key={heard} className={s.sticker} data-heard={heard !== "rest"}>
          <Mascot agent={agent} mood={MOOD[status]} size={80} />
        </span>
        <h3 className={s.stationName}>{NAME[agent]}</h3>
        <span className={s.state}>
          <span className={s.led} data-state={status === "waiting" ? "off" : status === "on" || status === "thinking" ? "busy" : status === "flagged" ? "hold" : "ready"} aria-hidden="true" />
          {STATUS[status]}
        </span>
      </div>
      <div className={s.paperWrap}>
      <div className={s.paper}>
        {status === "waiting" ? (
          <p className={s.waits}>{WAITS[agent]}</p>
        ) : (
          <ol className={s.steps}>
            {hidden > 0 && (
              <li>
                <button type="button" className={s.earlierSteps} onClick={() => setOpen(true)}>
                  {plural(hidden, "earlier line")}
                </button>
              </li>
            )}
            {lane.steps.slice(hidden).map((st, i, arr) => (
              <StepRow key={st.key} st={st} live={st.seq > liveFrom} latest={i === arr.length - 1} />
            ))}
            {status === "on" && (
              <li className={s.working}>
                <span className={s.workingSquare} aria-hidden="true" />
                Working on it
              </li>
            )}
          </ol>
        )}
      </div>
      </div>
    </section>
  );
}

function StepRow({ st, live, latest }: { st: Step; live: boolean; latest: boolean }) {
  const common = { className: s.step, "data-kind": st.kind, "data-live": live, "data-latest": latest };
  if (st.kind === "heard")
    return (
      <li {...common}>
        <p className={s.stepHead}>
          <Mascot agent={st.from} size={24} mood="awake" marks={false} line className={s.miniSticker} />
          <span>From the {NAME[st.from]}</span>
          <time className={s.stepTime}>{clock(st.at)}</time>
        </p>
        <p className={s.stepText}>{st.text}</p>
      </li>
    );
  if (st.kind === "sent")
    return (
      <li {...common}>
        <p className={s.stepHead}>
          <ArrowRight size={14} aria-hidden="true" />
          <span>Sent to the {NAME[st.to]}</span>
          <time className={s.stepTime}>{clock(st.at)}</time>
        </p>
        <p className={s.stepText}>{st.text}</p>
      </li>
    );
  if (st.kind === "rule") {
    const red = st.decision === "escalated" || st.decision === "message_failed";
    return (
      <li {...common}>
        <p className={s.stepHead}>
          <span>
            Rules · <span className={red ? s.red : undefined}>{KIND[st.decision] ?? st.decision.replace(/_/g, " ")}</span>
            {st.more.length > 0 && <span className={s.count}>×{st.more.length + 1}</span>}
          </span>
          {st.ms !== undefined && <span className={s.speed}>{ruleSpeed(st.ms)}</span>}
        </p>
        <p className={s.stepText}>{st.text}</p>
        {st.more.length > 0 && (
          <details className={s.more}>
            <summary>Show the other {st.more.length}</summary>
            <ul>
              {st.more.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </details>
        )}
      </li>
    );
  }
  if (st.kind === "message")
    return (
      <li {...common}>
        <p className={s.stepHead}>
          <MessageCircle size={14} aria-hidden="true" />
          <span>WhatsApp to {PERSON[st.to]}</span>
          <time className={s.stepTime}>{clock(st.at)}</time>
        </p>
        <p className={s.stepText}>&ldquo;{st.text}&rdquo;</p>
      </li>
    );
  const t = st.thought;
  const flagged = t.actions?.some((a) => a.tool === "flag_for_admin" && a.status === "done");
  return (
    <li {...common} data-status={t.status}>
      <p className={s.stepHead}>
        <span>AI check · {POINT[t.point]}</span>
        {t.ms !== undefined && <span className={s.speed}>{seconds(t.ms)}</span>}
      </p>
      {t.status === "thinking" ? (
        <p className={s.stepText}>
          Looking at: {t.about}
          <span className={s.caret} aria-hidden="true" />
        </p>
      ) : t.status === "done" ? (
        <>
          <p className={s.stamps}>
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
          </p>
          {t.headline && <p className={s.stepText}>{t.headline}</p>}
          {(t.actions ?? []).map((a, i) => (
            <p key={i} className={s.action}>
              <span>{TOOL[a.tool] ?? a.tool}</span>
              <span className={s.dots} aria-hidden="true" />
              <strong className={a.status === "blocked" ? s.red : undefined}>{a.status === "done" ? "Done" : "Blocked"}</strong>
            </p>
          ))}
          {(!!t.reasoning?.length || t.alternative) && (
            <details className={s.more}>
              <summary>Why</summary>
              <ul>
                {(t.reasoning ?? []).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
                {t.alternative && <li>Would instead: {t.alternative}</li>}
              </ul>
            </details>
          )}
          <p className={s.model}>Checked by {modelName(t.model) || "an AI model"}</p>
        </>
      ) : (
        <>
          <p className={s.stamps}>
            <span className={s.stamp} data-tone={t.status === "failed" ? "red" : "faded"}>
              {t.status === "failed" ? "No answer" : "Skipped"}
            </span>
          </p>
          <p className={s.stepText}>No model answered, so the rules carried on alone.</p>
        </>
      )}
    </li>
  );
}

/* ---------- the hand-offs: chits sliding across the counter, from printer to printer ---------- */

/** Hand-offs on the counter before the older ones fold. */
const CHITS = 4;

/** A finished listing keeps its whole route readable: the latest hand-off of each hop, in order. */
function hops(calls: Call[]) {
  const last = new Map<string, Call>();
  for (const c of calls) last.set(`${c.from}>${c.to}`, c);
  return [...last.values()].sort((a, b) => a.seq - b.seq);
}

function Handoffs({ calls, liveFrom, done }: { calls: Call[]; liveFrom: number; done: boolean }) {
  const [all, setAll] = useState(false);
  if (!calls.length) return null;
  const list = all ? calls : done ? hops(calls) : calls.slice(-CHITS);
  const folded = calls.length - list.length;
  return (
    <section className={s.pass} aria-label="Hand-offs between the agents, oldest first">
      {(folded > 0 || all) && (
        <button type="button" className={s.linkButton} onClick={() => setAll((v) => !v)}>
          {all ? (done ? "Fold to one per hop" : `Fold to the latest ${CHITS}`) : done ? `${plural(folded, "more hand-off")}` : `${plural(folded, "earlier hand-off")}`}
        </button>
      )}
      <ol className={s.calls} aria-live="polite">
        {list.map((c) => (
          <CallRow key={c.key} c={c} live={c.seq > liveFrom} />
        ))}
      </ol>
    </section>
  );
}

function CallRow({ c, live }: { c: Call; live: boolean }) {
  const a = Math.min(COL[c.from], COL[c.to]);
  const b = Math.max(COL[c.from], COL[c.to]);
  // The chit's words go on whichever side of the arrow has more counter.
  const side = 3.5 - b >= a + 0.5 ? "right" : "left";
  // The chit in flight exists only while it travels, so nothing can be left resting on the counter.
  const [flying, setFlying] = useState(live);
  const [heard, setHeard] = useState(live);
  useEffect(() => {
    if (!live) return;
    const a = setTimeout(() => setFlying(false), 1200);
    const b = setTimeout(() => setHeard(false), 4000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [live]);
  return (
    <li className={s.call} data-live={live} data-side={side} style={{ "--a": a, "--b": b } as CSSProperties}>
      <div className={s.track} data-dir={COL[c.to] > COL[c.from] ? "right" : "left"} aria-hidden="true">
        <span className={s.end}>
          <Mascot agent={c.from} size={30} mood="awake" marks={false} line />
        </span>
        <span className={s.line}>{flying && <span className={s.packet} onAnimationEnd={() => setFlying(false)} />}</span>
        <span className={s.end}>
          <Mascot agent={c.to} size={30} mood="awake" marks={false} line />
          {heard && <span className={s.heard}>Heard</span>}
        </span>
      </div>
      <p className={s.chit}>
        <span className={s.callWho}>
          {NAME[c.from]} <ArrowRight size={12} aria-label="to" /> {NAME[c.to]}
          <time className={s.callTime}>{clock(c.at)}</time>
        </span>
        <span className={s.callTask}>{c.task}</span>
      </p>
    </li>
  );
}

/* ---------- nothing on the board ---------- */

function Empty({ conn, cleared }: { conn: Connection; cleared: boolean }) {
  const [title, note] =
    conn === "denied"
      ? ["Admins only", "This board is for the Luna team. Sign in with an admin account to watch the agents."]
      : conn === "connecting"
        ? ["Connecting to the agents", "One moment while the board opens the line."]
        : conn === "retrying"
          ? ["Lost the line to the agents", "Trying again every few seconds. Listings made meanwhile will still show up."]
          : [
              "Waiting for food",
              cleared
                ? "The board is clear. List food from a donor phone: its order prints here, and you can watch the four agents pass it along."
                : "List food from a donor phone. Its order prints here, and you can watch the four agents pass it along.",
            ];
  return (
    <div className={s.empty} role="status">
      <h2 className={s.emptyTitle}>{title}</h2>
      <p className={s.emptyNote}>{note}</p>
      <div className={s.emptyLanes} aria-hidden="true">
        {AGENTS.map((a) => (
          <span key={a}>{WAITS[a]}</span>
        ))}
      </div>
    </div>
  );
}
