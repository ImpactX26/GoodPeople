/**
 * The reasoning layer's records. A Thought is one LLM look at what an agent's rules just did; trace events
 * are everything the agent console draws: decisions, hand-offs between agents, messages to people and thoughts.
 */
import type { AgentName, DecisionKind } from "../types.ts";

/** agree: the rules got it right. concern: fine, with a risk to watch. would_change: a better safe option exists. */
export type Verdict = "agree" | "concern" | "would_change";

/** Which moment of a case the reasoning looked at. */
export type Point = "intake" | "meals" | "plan" | "partner" | "problem" | "watch" | "debrief";

export interface ActionRecord {
  tool: string;
  args: Record<string, unknown>;
  status: "done" | "blocked";
  /** What it changed, or why the guardrail stopped it. */
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
  /** What the rules did that this looks at, in a line. */
  about: string;
  status: "thinking" | "done" | "failed" | "skipped";
  verdict?: Verdict;
  headline?: string;
  reasoning?: string[];
  alternative?: string;
  confidence?: number;
  actions?: ActionRecord[];
  /** Exact model that answered: "gemini:gemini-3.5-flash-lite", "groq:openai/gpt-oss-120b". */
  model?: string;
  ms?: number;
  tokens?: number;
  /** Why no model answered (all failed, budget used, no key). */
  error?: string;
}

/** The people at either end of the chain, as the console draws them. */
export type Person = "donor" | "ngo" | "partner" | "person";

export type TraceEvent =
  | { type: "decision"; seq: number; at: number; agent: AgentName; kind: DecisionKind; subject: string; reason: string; listingId?: string; shareId?: string; byReasoning?: boolean; /** Milliseconds from the start of the operation to this decision: how fast the rules answered. */ ms?: number }
  | { type: "handoff"; seq: number; at: number; from: AgentName; to: AgentName; task: string; listingId?: string; shareId?: string; event?: string }
  | { type: "message"; seq: number; at: number; from?: AgentName; to: Person; text: string; listingId?: string }
  | { type: "thought"; seq: number; at: number; thought: Thought };

/** Every 30 s: what the watcher looked at. Broadcast only, never kept. */
export interface WatchPulse {
  at: number;
  live: number;
  shares: number;
  noticed: string[];
}
