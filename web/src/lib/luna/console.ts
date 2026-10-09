"use client";

/**
 * The agent console's feed (admin): GET /agents/reasoning/stream, Server-Sent Events over fetch so the token
 * stays in a header. It opens with a snapshot of recent events, then sends every decision, hand-off,
 * message and reasoning slip as it happens, and the watcher's pulse every 30 s.
 * Shapes mirror api/src/matching/reasoning/types.ts.
 */
import { useEffect, useRef, useState } from "react";
import { api, API_URL } from "./api";
import { getSession } from "./auth";

export type AgentName = "food" | "ngo" | "logistics" | "decision";
export type Person = "donor" | "ngo" | "partner" | "person";
export type Verdict = "agree" | "concern" | "would_change";
export type Point = "intake" | "meals" | "plan" | "partner" | "problem" | "watch" | "debrief";

export interface ActionRecord {
  tool: string;
  args: Record<string, unknown>;
  status: "done" | "blocked";
  note: string;
}

export interface Thought {
  id: string;
  at: number;
  doneAt?: number;
  agent: AgentName;
  point: Point;
  listingId?: string;
  shareId?: string;
  about: string;
  status: "thinking" | "done" | "failed" | "skipped";
  verdict?: Verdict;
  headline?: string;
  reasoning?: string[];
  alternative?: string;
  confidence?: number;
  actions?: ActionRecord[];
  model?: string;
  ms?: number;
  tokens?: number;
  error?: string;
}

/** `order`: the restaurant listing (lst_…) an event belongs to, before and after its case opens. */
export type TraceEvent = (
  | { type: "decision"; seq: number; at: number; agent: AgentName; kind: string; subject: string; reason: string; listingId?: string; shareId?: string; byReasoning?: boolean; ms?: number }
  | { type: "handoff"; seq: number; at: number; from: AgentName; to: AgentName; task: string; listingId?: string; shareId?: string; event?: string }
  | { type: "message"; seq: number; at: number; from?: AgentName; to: Person; text: string; listingId?: string }
  | { type: "thought"; seq: number; at: number; thought: Thought }
) & { order?: string };

export interface WatchPulse {
  at: number;
  live: number;
  shares: number;
  noticed: string[];
}

export interface ReasoningStatus {
  enabled: boolean;
  cap: number;
  callsToday: number;
  providers: { model: string; calls: number; fails: number; tokens: number; lastMs?: number; lastError?: string; coolingUntil?: number }[];
  watchEveryMs: number;
  thinking: number;
  queued: number;
}

export interface CaseListing {
  id: string;
  /** The restaurant listing (lst_…) this case came from. */
  sourceListingId?: string;
  donorName: string;
  items: { servings: number; name?: string }[];
  status: "review" | "matching" | "matched" | "partially_matched" | "unmatched" | "closed";
  unplacedServings: number;
  createdAt: number;
  /** Nobody took it before its window closed (the case closed with a sorry). */
  lapsed?: { at: number; asked: number; ended: "unsafe" | "collect_by"; cause?: "in_transit" };
}

export type Connection = "connecting" | "live" | "retrying" | "denied";

export interface TraceHandlers {
  snapshot(events: TraceEvent[], status: ReasoningStatus): void;
  events(batch: TraceEvent[]): void;
  status(s: ReasoningStatus): void;
  pulse(p: WatchPulse): void;
}

/** One SSE frame: its event name and its joined data lines. */
function parseFrame(frame: string) {
  const lines = frame.split("\n");
  const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
  const data = lines
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n");
  return { event, data };
}

/**
 * One live feed per page, shared by every view on it (the agents board and the call sheet): switching
 * between them keeps the connection and everything received so far. Server-Sent Events first; when a network
 * can't hold a stream open, it falls back to fetching GET /agents/reasoning/trace every few seconds.
 */
const feed = {
  events: [] as TraceEvent[],
  status: null as ReasoningStatus | null,
  pulses: [] as WatchPulse[],
  ready: false,
  conn: "connecting" as Connection,
  subs: new Set<{ h: { current: TraceHandlers }; setConn: (c: Connection) => void }>(),
  ctrl: null as AbortController | null,
  stopTimer: 0 as ReturnType<typeof setTimeout> | 0,
};
const KEEP_EVENTS = 3000;
const keyOf = (e: TraceEvent) => `${e.type}:${e.seq}:${e.at}`;

function setConn(c: Connection) {
  feed.conn = c;
  for (const s of feed.subs) s.setConn(c);
}

function onSnapshot(events: TraceEvent[], status: ReasoningStatus) {
  feed.events = events.slice(-KEEP_EVENTS);
  feed.status = status;
  feed.ready = true;
  setConn("live");
  for (const s of feed.subs) s.h.current.snapshot(feed.events, status);
}

function onEvents(batch: TraceEvent[]) {
  if (!batch.length) return;
  feed.events = [...feed.events, ...batch].slice(-KEEP_EVENTS);
  for (const s of feed.subs) s.h.current.events(batch);
}

async function streamOnce(ctrl: AbortController, token: string): Promise<"denied" | "dropped"> {
  const res = await fetch(`${API_URL}/agents/reasoning/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
  if (res.status === 401 || res.status === 403) return "denied";
  if (!res.ok || !res.body) return "dropped";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return "dropped";
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let cut: number;
    while ((cut = buffer.indexOf("\n\n")) >= 0) {
      const { event, data } = parseFrame(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      if (!event || !data) continue;
      const body = JSON.parse(data);
      if (event === "snapshot") onSnapshot(body.events, body.status);
      else if (event === "events") onEvents(body);
      else if (event === "status") {
        feed.status = body;
        for (const s of feed.subs) s.h.current.status(body);
      } else if (event === "pulse") {
        feed.pulses = [...feed.pulses, body].slice(-20);
        for (const s of feed.subs) s.h.current.pulse(body);
      }
    }
  }
}

/** The fallback: the same snapshot, fetched every few seconds; only events not seen yet are passed on. */
async function pollOnce(ctrl: AbortController, token: string): Promise<"denied" | "ok" | "failed"> {
  const res = await fetch(`${API_URL}/agents/reasoning/trace`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
  if (res.status === 401 || res.status === 403) return "denied";
  if (!res.ok) return "failed";
  const body = (await res.json()) as { events: TraceEvent[]; status: ReasoningStatus };
  if (!feed.ready) onSnapshot(body.events, body.status);
  else {
    const seen = new Set(feed.events.map(keyOf));
    onEvents(body.events.filter((e) => !seen.has(keyOf(e))));
    feed.status = body.status;
    for (const s of feed.subs) s.h.current.status(body.status);
    setConn("live");
  }
  return "ok";
}

async function run(ctrl: AbortController) {
  let streamFailures = 0;
  while (!ctrl.signal.aborted) {
    const token = getSession()?.token;
    if (!token) return setConn("denied");
    try {
      // A stream that keeps dropping (or never opens) gives way to polling, retried as a stream now and then.
      const result = streamFailures < 2 ? await streamOnce(ctrl, token) : await pollOnce(ctrl, token);
      if (result === "denied") return setConn("denied");
      if (result === "dropped") streamFailures++;
      if (result === "failed") setConn("retrying");
      if (streamFailures >= 2 && result === "ok" && Math.random() < 0.05) streamFailures = 0;
    } catch {
      if (ctrl.signal.aborted) return;
      streamFailures++;
      if (!feed.ready || streamFailures < 2) setConn("retrying");
    }
    if (ctrl.signal.aborted) return;
    await new Promise((r) => setTimeout(r, streamFailures >= 2 ? 3000 : 1500));
  }
}

/** Hands every frame of the page's shared feed to `handlers`; a view opened later first gets everything so far. */
export function useTraceStream(handlers: TraceHandlers): Connection {
  const [conn, setLocal] = useState<Connection>(feed.conn);
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const sub = { h: ref, setConn: setLocal };
    feed.subs.add(sub);
    if (feed.stopTimer) {
      clearTimeout(feed.stopTimer);
      feed.stopTimer = 0;
    }
    if (feed.ready && feed.status) {
      ref.current.snapshot(feed.events, feed.status);
      for (const p of feed.pulses) ref.current.pulse(p);
    }
    if (!feed.ctrl) {
      const ctrl = (feed.ctrl = new AbortController());
      queueMicrotask(() => void run(ctrl));
    }
    return () => {
      feed.subs.delete(sub);
      // Keep the connection a little while, so switching views doesn't reconnect.
      if (!feed.subs.size)
        feed.stopTimer = setTimeout(() => {
          feed.ctrl?.abort();
          feed.ctrl = null;
          feed.ready = false;
          feed.conn = "connecting";
        }, 30_000);
    };
  }, []);

  return conn;
}

/** "gemini:gemini-3.5-flash-lite" → "Gemini 3.5 Flash-Lite"; "groq:openai/gpt-oss-120b" → "GPT-OSS 120B on Groq". */
export function modelName(m?: string) {
  if (!m) return "";
  const [provider, rest = ""] = m.split(":");
  const id = rest.split("/").pop() ?? rest;
  if (provider === "gemini")
    return id
      .replace(/^gemini-/, "Gemini ")
      .replace(/-flash-lite$/, " Flash-Lite")
      .replace(/-flash$/, " Flash");
  if (provider === "groq") return `${id.replace(/^gpt-oss-(\d+)b$/, "GPT-OSS $1B")} on Groq`;
  return m;
}

/** The cases the agents are working on, newest first. */
export const caseListings = () => api<CaseListing[]>("/agents/admin/listings", { token: getSession()?.token ?? null });
