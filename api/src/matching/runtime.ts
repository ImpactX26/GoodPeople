/**
 * What every agent shares: the store, a single queue so only one operation
 * changes state at a time, the decision log, the outbox and small helpers.
 */
import { randomInt, randomUUID } from "node:crypto";
import { config } from "./config.ts";
import { itemName } from "./engine/reasons.ts";
import { effectiveGrade, safeUntil } from "./engine/safety.ts";
import type { Kind, Kinds, MatchingStore } from "./store.ts";
import type { AgentName, Decision, DecisionKind, Item, Listing, OfferLine, OutboxMessage } from "./types.ts";
import type { Message } from "./whatsapp/templates.ts";
import { donationUpdate } from "./whatsapp/templates.ts";
import { ping } from "./live.ts";
import { trace } from "./reasoning/trace.ts";

/** Who is acting: a signed-in or WhatsApp phone, an admin, or the demo simulator. */
export type Actor = { phone: string } | { admin: true } | { sim: true };
export type Result = { ok: true; message?: string } | { ok: false; error: string; status?: number };

export const ok = (message?: string): Result => ({ ok: true, message });
export const fail = (error: string, status = 409): Result => ({ ok: false, error, status });

export const owns = (by: Actor, phone?: string) => "admin" in by || "sim" in by || ("phone" in by && !!phone && by.phone === phone);

/** Without simulation, only people a real phone has claimed take part. */
export const usable = <T extends { phone?: string }>(xs: T[]) => (config.simulateUnclaimed ? xs : xs.filter((x) => x.phone));

export const code4 = () => String(randomInt(1000, 10000));

export const itemsOf = (l: Listing, lines: OfferLine[]): Item[] =>
  lines.map((ln) => ({ ...l.items.find((i) => i.id === ln.itemId)!, servings: ln.servings }));

export const servingsOf = (lines: OfferLine[]) => lines.reduce((n, l) => n + l.servings, 0);

export const foodOf = (l: Listing, lines: OfferLine[]) => [...new Set(itemsOf(l, lines).map(itemName))].join(" + ");

/** The earliest "safe until" across the food in these lines. */
export const safeUntilOf = (l: Listing, lines: OfferLine[]) => Math.min(...itemsOf(l, lines).map((i) => safeUntil(i, l.createdAt)));

export const worstGrade = (l: Listing, lines: OfferLine[]) => itemsOf(l, lines).map(effectiveGrade).sort().at(-1) ?? "A";

/** NGO offer countdown: remaining safe time ÷ 6, within bounds. */
export function countdown(l: Listing, lines: OfferLine[], now: number) {
  const left = safeUntilOf(l, lines) - now;
  return Math.min(config.countdownMaxMs, Math.max(config.countdownMinMs, left / config.countdownDivisor));
}

export function createRuntime(store: MatchingStore) {
  let queue: Promise<unknown> = Promise.resolve();
  /** Orders decisions made in the same millisecond. */
  let seq = 0;

  return {
    store,

    /** Run one operation at a time. Agents call each other only from inside it. */
    serial<T>(fn: () => Promise<T>): Promise<T> {
      const go = () => {
        trace.beginOp();
        return fn();
      };
      const run = queue.then(go, go);
      queue = run.catch(() => {});
      return run;
    },

    id: (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`,

    async decide(agent: AgentName, now: number, kind: DecisionKind, subject: string, reason: string, listingId?: string, data?: unknown) {
      const d: Decision = { id: `d-${randomUUID().slice(0, 8)}`, at: now, seq: ++seq, agent, kind, subject, reason, listingId, data };
      await store.insert("decision", d);
      trace.decision(d);
      return d;
    },

    /**
     * `listingId` and `from` are for the agent console only; without them the message joins the case and agent
     * the last decision was about. Each agent gets a runtime that fills in `from` (see `as`).
     */
    async send(now: number, to: string | undefined, audience: string, m: Message, listingId?: string, from?: AgentName) {
      const out: OutboxMessage = { id: `m-${randomUUID().slice(0, 8)}`, to, audience, ...m, status: "pending", attempts: 0, nextAt: now, createdAt: now };
      await store.insert("outbox", out);
      trace.message(out, listingId, from);
      ping(to, audience.split(":")[0]);
    },

    toDonor(now: number, l: Listing, text: string) {
      return this.send(now, l.donorPhone, `donor:${l.donorPhone}`, donationUpdate(text), l.id);
    },

    async mustGet<K extends Kind>(kind: K, key: string): Promise<Kinds[K]> {
      const doc = await store.get(kind, key);
      if (!doc) throw new Error(`${kind} ${key} not found`);
      return doc;
    },

    /** The same runtime, with every message it sends credited to `agent` in the trace. */
    as(agent: AgentName) {
      const send = this.send;
      return { ...this, send: (now: number, to: string | undefined, audience: string, m: Message, listingId?: string) => send(now, to, audience, m, listingId, agent) };
    },

    /** One bad record must not stop the tick for everything after it. */
    async safely(what: string, fn: () => Promise<unknown>) {
      try {
        await fn();
      } catch (err) {
        console.error(`luna agents: ${what} failed`, err);
      }
    },
  };
}

export type Runtime = ReturnType<typeof createRuntime>;
