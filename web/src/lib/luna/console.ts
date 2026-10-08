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

export type TraceEvent =
  | { type: "decision"; seq: number; at: number; agent: AgentName; kind: string; subject: string; reason: string; listingId?: string; shareId?: string; byReasoning?: boolean; ms?: number }
  | { type: "handoff"; seq: number; at: number; from: AgentName; to: AgentName; task: string; listingId?: string; shareId?: string; event?: string }
  | { type: "message"; seq: number; at: number; from?: AgentName; to: Person; text: string; listingId?: string }
  | { type: "thought"; seq: number; at: number; thought: Thought };

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
  donorName: string;
  items: { servings: number; name?: string }[];
  status: "review" | "matching" | "matched" | "partially_matched" | "unmatched" | "closed";
  unplacedServings: number;
  createdAt: number;
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

/** Keeps one stream open while mounted and hands each frame to `handlers`. Reconnects after a drop. */
export function useTraceStream(handlers: TraceHandlers): Connection {
  const [conn, setConn] = useState<Connection>("connecting");
  const ref = useRef(handlers);
  useEffect(() => {
    ref.current = handlers;
  });

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      while (!ctrl.signal.aborted) {
        const token = getSession()?.token;
        if (!token) return setConn("denied");
        try {
          const res = await fetch(`${API_URL}/agents/reasoning/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401 || res.status === 403) return setConn("denied");
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
              const { event, data } = parseFrame(buffer.slice(0, cut));
              buffer = buffer.slice(cut + 2);
              if (!event || !data) continue;
              const h = ref.current;
              const body = JSON.parse(data);
              if (event === "snapshot") {
                setConn("live");
                h.snapshot(body.events, body.status);
              } else if (event === "events") h.events(body);
              else if (event === "status") h.status(body);
              else if (event === "pulse") h.pulse(body);
            }
          }
        } catch {
          /* dropped: reconnect below */
        }
        if (ctrl.signal.aborted) return;
        setConn("retrying");
        await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => ctrl.abort();
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
