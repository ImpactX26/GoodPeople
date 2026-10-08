/**
 * The agents board's model: the trace stream folded into one order per listing, each with four lanes
 * (what each agent did for it), the hand-offs between them, and how far the food has travelled.
 */
import type { AgentName, CaseListing, Person, Thought, TraceEvent } from "@/lib/luna/console";

export const AGENTS: AgentName[] = ["food", "decision", "ngo", "logistics"];
export const COL: Record<AgentName, number> = { food: 0, decision: 1, ngo: 2, logistics: 3 };

export const NAME: Record<AgentName, string> = { food: "Food Agent", decision: "Decision Agent", ngo: "NGO Agent", logistics: "Logistics Agent" };
export const PERSON: Record<Person, string> = { donor: "Restaurant", ngo: "NGO", partner: "Rider", person: "Person" };

export const JOB: Record<AgentName, string> = {
  food: "Checks the food. Grades it A to D, works out how long it stays safe and how many it feeds.",
  decision: "Runs the case. Opens it, hands out the work, keeps everyone posted and closes it.",
  ngo: "Finds who can safely take it. Filters the NGOs, ranks them and splits the food into shares.",
  logistics: "Gets it there. Offers each share, finds a rider, checks the pickup and drop codes.",
};

/** What a lane says before its agent has been called. */
export const WAITS: Record<AgentName, string> = {
  food: "Waits for a listing.",
  decision: "Waits for the Food Passport.",
  ngo: "Waits for the Decision Agent to ask.",
  logistics: "Waits for a plan to run.",
};

export const KIND: Record<string, string> = {
  listed: "Listed",
  review: "Held for review",
  graded: "Graded",
  filtered: "Filtered out",
  ranked: "Ranked",
  offered: "Offered",
  accepted: "Accepted",
  declined: "Declined",
  expired: "No reply",
  assigned: "Rider assigned",
  picked_up: "Picked up",
  delayed: "Running late",
  redirected: "Redirected",
  escalated: "Escalated",
  replanned: "Re-planned",
  delivered: "Delivered",
  feedback: "Feedback",
  closed: "Case closed",
  message_failed: "Message failed",
  rated: "Rated",
  reassigned: "Reassigned",
  pledged: "Pledged",
  gap_outreach: "Asked for food",
};

export type Step =
  | { key: string; seq: number; at: number; kind: "heard"; from: AgentName; text: string }
  | { key: string; seq: number; at: number; kind: "sent"; to: AgentName; text: string }
  | { key: string; seq: number; at: number; kind: "rule"; decision: string; text: string; ms?: number; more: string[] }
  | { key: string; seq: number; at: number; kind: "thought"; thought: Thought }
  | { key: string; seq: number; at: number; kind: "message"; to: Person; text: string };

export interface Call {
  key: string;
  seq: number;
  at: number;
  from: AgentName;
  to: AgentName;
  task: string;
}

export interface Lane {
  steps: Step[];
  /** The latest work handed to this agent. */
  asked?: Call;
  /** The latest thing this agent produced: a step or a hand-off it made. */
  lastOut: number;
  /** The latest hand-off this agent made. */
  handedBack?: Call;
}

export type StageKey = "listed" | "checked" | "matched" | "picked" | "delivered";
export const STAGES: { key: StageKey; label: string }[] = [
  { key: "listed", label: "Listed" },
  { key: "checked", label: "Checked" },
  { key: "matched", label: "Matched" },
  { key: "picked", label: "Picked up" },
  { key: "delivered", label: "Delivered" },
];

export interface Order {
  id: string;
  firstSeq: number;
  firstAt: number;
  lastAt: number;
  lanes: Record<AgentName, Lane>;
  calls: Call[];
  /** The seq each stage completed at. */
  stages: Partial<Record<StageKey, number>>;
  closedAt?: number;
  deliveredAt?: number;
  stopped: boolean;
  /** "40 servings from Meghana Foods", from the Food Agent's hand-off, until the case list loads. */
  passport?: string;
}

const SENDS = new Set<AgentName>(["food", "ngo"]);

const STAGE_OF: Partial<Record<string, StageKey>> = { graded: "checked", accepted: "matched", picked_up: "picked", delivered: "delivered" };

function lanes(): Record<AgentName, Lane> {
  return { food: { steps: [], lastOut: 0 }, decision: { steps: [], lastOut: 0 }, ngo: { steps: [], lastOut: 0 }, logistics: { steps: [], lastOut: 0 } };
}

const listingOf = (e: TraceEvent) => (e.type === "thought" ? e.thought.listingId : e.listingId);

/** Folds events (in seq order) into orders, oldest first. */
export function buildOrders(events: TraceEvent[]): Order[] {
  const orders = new Map<string, Order>();
  for (const e of events) {
    // One row per restaurant listing, from the moment it's posted to the case closing.
    const id = e.order ?? listingOf(e);
    if (!id) continue;
    let o = orders.get(id);
    if (!o) {
      o = { id, firstSeq: e.seq, firstAt: e.at, lastAt: e.at, lanes: lanes(), calls: [], stages: { listed: e.seq }, stopped: false };
      orders.set(id, o);
    }
    o.lastAt = Math.max(o.lastAt, e.at);

    if (e.type === "handoff") {
      const call: Call = { key: `h${e.seq}`, seq: e.seq, at: e.at, from: e.from, to: e.to, task: e.task };
      o.calls.push(call);
      o.lanes[e.to].asked = call;
      o.lanes[e.to].steps.push({ key: `in${e.seq}`, seq: e.seq, at: e.at, kind: "heard", from: e.from, text: e.task });
      // The Food and NGO Agents' work is what they hand back (the Passport, the plan), so it prints on their own paper too.
      if (SENDS.has(e.from)) o.lanes[e.from].steps.push({ key: `out${e.seq}`, seq: e.seq, at: e.at, kind: "sent", to: e.to, text: e.task });
      o.lanes[e.from].lastOut = e.seq;
      o.lanes[e.from].handedBack = call;
      if (e.from === "food" && !o.passport) o.passport = e.task.replace(/^Food Passport:\s*/, "");
    } else if (e.type === "decision") {
      // The reasoning's own actions print on its slip, not twice.
      if (e.byReasoning) continue;
      if (e.kind === "listed" && !o.passport) o.passport = e.subject;
      const lane = o.lanes[e.agent];
      const last = lane.steps.at(-1);
      if (last?.kind === "rule" && last.decision === e.kind && (e.kind === "filtered" || e.kind === "rated")) last.more.push(e.reason);
      else lane.steps.push({ key: `d${e.seq}`, seq: e.seq, at: e.at, kind: "rule", decision: e.kind, text: e.reason, ms: e.ms, more: [] });
      lane.lastOut = e.seq;
      const stage = STAGE_OF[e.kind];
      if (stage && o.stages[stage] === undefined) o.stages[stage] = e.seq;
      if (e.kind === "delivered" || e.kind === "closed") {
        for (const s of ["checked", "matched", "picked", "delivered"] as StageKey[]) o.stages[s] ??= e.seq;
      }
      if (e.kind === "closed") o.closedAt = e.at;
      if (e.kind === "delivered") o.deliveredAt ??= e.at;
      if (e.kind === "escalated") o.stopped = true;
    } else if (e.type === "message") {
      const from = e.from ?? "decision";
      o.lanes[from].steps.push({ key: `m${e.seq}`, seq: e.seq, at: e.at, kind: "message", to: e.to, text: e.text.replace(/https?:\/\/\S+/g, "(map link)").replace(/\s*\n\s*/g, " ") });
      o.lanes[from].lastOut = e.seq;
    } else {
      const t = e.thought;
      const lane = o.lanes[t.agent];
      const i = lane.steps.findIndex((s) => s.kind === "thought" && s.thought.id === t.id);
      if (i >= 0) lane.steps[i] = { ...(lane.steps[i] as Extract<Step, { kind: "thought" }>), thought: t };
      else lane.steps.push({ key: `t${t.id}`, seq: e.seq, at: t.at, kind: "thought", thought: t });
      if (t.status !== "thinking") lane.lastOut = Math.max(lane.lastOut, e.seq);
    }
  }
  return [...orders.values()].sort((a, b) => a.firstSeq - b.firstSeq);
}

/** The case list fills in what the trace can't: who listed, what, and whether it's finished. */
export function withCase(o: Order, l?: CaseListing): Order {
  if (!l) return o;
  const stages = { ...o.stages };
  if (l.status === "closed") for (const s of ["checked", "matched", "picked", "delivered"] as StageKey[]) stages[s] ??= o.firstSeq;
  if (l.status === "matched") for (const s of ["checked", "matched"] as StageKey[]) stages[s] ??= o.firstSeq;
  return { ...o, stages, stopped: o.stopped || l.status === "unmatched" };
}

export type Status = "waiting" | "on" | "thinking" | "watching" | "wrapping" | "done" | "flagged";

export const STATUS: Record<Status, string> = {
  waiting: "Not yet",
  on: "On it",
  thinking: "Thinking",
  watching: "Watching",
  wrapping: "Wrapping up",
  done: "Done",
  flagged: "Needs a person",
};

const flags = (s: Step) =>
  (s.kind === "thought" && !!s.thought.actions?.some((a) => a.tool === "flag_for_admin" && a.status === "done")) || (s.kind === "rule" && s.decision === "escalated");

export function laneStatus(o: Order, agent: AgentName): Status {
  const lane = o.lanes[agent];
  if (!lane.steps.length && !lane.handedBack) return "waiting";
  if (lane.steps.some((s) => s.kind === "thought" && s.thought.status === "thinking")) return "thinking";
  if (lane.asked && lane.asked.seq > lane.lastOut) return "on";
  if (lane.steps.some(flags)) return "flagged";
  if (o.closedAt !== undefined) return "done";
  if (agent === "food" && lane.handedBack) return "done";
  if (agent === "ngo" && lane.handedBack && (!lane.asked || lane.handedBack.seq > lane.asked.seq)) return "done";
  if (agent === "logistics" && o.stages.delivered !== undefined) return "done";
  // Delivered, waiting on the NGO's feedback before the case closes.
  if (agent === "decision" && o.deliveredAt !== undefined) return "wrapping";
  return "watching";
}

/** The stage the food is at now: the first one not yet done. */
export function currentStage(o: Order): StageKey | null {
  if (o.closedAt !== undefined) return null;
  return STAGES.find((s) => o.stages[s.key] === undefined)?.key ?? null;
}

/* ---------- formatters ---------- */

const pad = (n: number) => String(n).padStart(2, "0");

export const clock = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const seconds = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

export const ruleSpeed = (ms?: number) => (ms === undefined ? "" : ms < 1 ? "<1 ms" : `${Math.round(ms)} ms`);

/** "3:12" or "1:04:09". */
export function elapsed(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
