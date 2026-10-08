/**
 * The agents' trace: every decision, hand-off, message and thought, in order, for the agent console.
 * In-process like live.ts (the API is one Railway service): a ring of recent events for a console that
 * connects late, and a bus for the live stream. Decisions and thoughts are also in the store, so a restart
 * only loses hand-offs and messages from the ring.
 */
import { EventEmitter } from "node:events";
import type { AgentName, Decision, OutboxMessage } from "../types.ts";
import type { Person, Thought, TraceEvent, WatchPulse } from "./types.ts";

const KEEP = 800;
const bus = new EventEmitter();
bus.setMaxListeners(0);
const ring: TraceEvent[] = [];
let seq = 0;

/**
 * What the current operation is about. Agents run one operation at a time (runtime.serial), so the last
 * decision tells which case and agent a message that follows belongs to.
 */
let op: { listingId?: string; agent?: AgentName; startedAt?: number } = {};

type Draft = TraceEvent extends infer E ? (E extends TraceEvent ? Omit<E, "seq"> & { seq?: number } : never) : never;

function emit(e: Draft) {
  const ev = { ...e, seq: e.seq ?? ++seq } as TraceEvent;
  ring.push(ev);
  if (ring.length > KEEP) ring.splice(0, ring.length - KEEP);
  bus.emit("event", ev);
  return ev;
}

/** Hide handover codes: the console is on a projector. */
const redact = (text: string) => text.replace(/(code\b[^0-9\n]{0,24})\d{4}\b/gi, "$1••••");

const PERSON: Record<string, Person> = { donor: "donor", recipient: "ngo", partner: "partner" };

export const trace = {
  /** Reserve a place in the order now, for an event only known after the operation (Food → Decision). */
  nextSeq: () => ++seq,

  beginOp() {
    op = { startedAt: performance.now() };
  },

  decision(d: Decision) {
    op = { ...op, listingId: d.listingId ?? op.listingId, agent: d.agent ?? op.agent };
    if (!d.agent) return;
    const data = (d.data ?? {}) as { shareId?: unknown; thoughtId?: unknown };
    emit({
      type: "decision",
      at: d.at,
      agent: d.agent,
      kind: d.kind,
      subject: d.subject,
      reason: d.reason,
      listingId: d.listingId,
      shareId: typeof data.shareId === "string" ? data.shareId : undefined,
      byReasoning: typeof data.thoughtId === "string" || undefined,
      ms: op.startedAt === undefined ? undefined : Math.round((performance.now() - op.startedAt) * 10) / 10,
    });
  },

  message(m: OutboxMessage, listingId?: string, from?: AgentName) {
    const to = PERSON[m.audience.split(":")[0]] ?? "person";
    emit({ type: "message", at: m.createdAt, from: from ?? op.agent, to, text: redact(m.text), listingId: listingId ?? op.listingId });
  },

  handoff(h: { at: number; from: AgentName; to: AgentName; task: string; listingId?: string; shareId?: string; event?: string; seq?: number }) {
    emit({ type: "handoff", ...h });
  },

  thought(t: Thought) {
    emit({ type: "thought", at: t.doneAt ?? t.at, thought: t });
  },

  pulse(p: WatchPulse) {
    bus.emit("pulse", p);
  },

  recent(limit = 400): TraceEvent[] {
    return [...ring].sort((a, b) => a.at - b.at || a.seq - b.seq).slice(-limit);
  },

  on(fn: (e: TraceEvent) => void) {
    bus.on("event", fn);
    return () => void bus.off("event", fn);
  },

  onPulse(fn: (p: WatchPulse) => void) {
    bus.on("pulse", fn);
    return () => void bus.off("pulse", fn);
  },
};
