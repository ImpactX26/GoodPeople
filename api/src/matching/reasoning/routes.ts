/**
 * The agent console's feed (admin only): GET /agents/reasoning/stream is Server-Sent Events over fetch
 * (Authorization header, like /agents/me/stream). It opens with a snapshot of recent events and the
 * reasoning status, then sends every event as it happens and the watcher's pulse every 30 s.
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionFrom } from "../../auth.ts";
import type { MatchingStore } from "../store.ts";
import type { Reasoner } from "./reasoner.ts";
import { trace } from "./trace.ts";
import type { TraceEvent, WatchPulse } from "./types.ts";

/**
 * Recent events, from the kept feed: the same story on any screen, opened at any time, and after a restart.
 * A check that was still thinking when the server stopped is shown as interrupted, not thinking forever.
 */
async function snapshot(store: MatchingStore, limit: number): Promise<TraceEvent[]> {
  const kept = (await store.list("trace")).sort((a, b) => a.at - b.at || a.seq - b.seq).slice(-limit);
  if (kept.length) {
    const lastOf = new Map<string, number>();
    kept.forEach((e, i) => e.type === "thought" && lastOf.set(e.thought.id, i));
    const now = Date.now();
    return kept.map(({ id: _id, ...e }, i) =>
      e.type === "thought" && e.thought.status === "thinking" && lastOf.get(e.thought.id) === i && now - e.at > 3 * 60_000
        ? ({ ...e, thought: { ...e.thought, status: "failed", error: "Interrupted: the server restarted while this check ran." } } as TraceEvent)
        : (e as TraceEvent),
    );
  }
  const ring = trace.recent(limit);
  if (ring.length) return ring;
  const decisions = (await store.list("decision")).filter((d) => d.agent).sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0)).slice(-limit);
  const thoughts = (await store.list("thought")).sort((a, b) => a.at - b.at).slice(-Math.ceil(limit / 3));
  const events: Omit<TraceEvent, "seq">[] = [
    ...decisions.map((d) => ({ type: "decision" as const, at: d.at, agent: d.agent!, kind: d.kind, subject: d.subject, reason: d.reason, listingId: d.listingId })),
    ...thoughts.map((t) => ({ type: "thought" as const, at: t.doneAt ?? t.at, thought: t })),
  ];
  return events.sort((a, b) => a.at - b.at).map((e, i) => ({ ...e, seq: i - events.length }) as TraceEvent);
}

export function reasoningRoutes(reasoner: Reasoner, store: MatchingStore) {
  const app = new Hono();

  async function admin(c: Context) {
    const s = await sessionFrom(c.req.header("Authorization"));
    if (!s) return c.json({ error: "Not signed in." }, 401);
    if (s.role !== "admin") return c.json({ error: "Only for admin accounts." }, 403);
    return null;
  }

  app.get("/status", async (c) => (await admin(c)) ?? c.json(reasoner.status()));

  /** The same snapshot the stream opens with, for screens on networks that can't hold a stream open (they poll). */
  app.get("/trace", async (c) => {
    const denied = await admin(c);
    if (denied) return denied;
    const limit = Math.min(800, Number(c.req.query("limit") ?? 400));
    return c.json({ events: await snapshot(store, limit), status: reasoner.status() });
  });

  app.get("/thoughts", async (c) => {
    const denied = await admin(c);
    if (denied) return denied;
    const listingId = c.req.query("listingId");
    const all = await store.list("thought", listingId ? { listingId } : undefined);
    return c.json(all.sort((a, b) => b.at - a.at).slice(0, 200));
  });

  app.get("/stream", async (c) => {
    const denied = await admin(c);
    if (denied) return denied;
    const limit = Math.min(800, Number(c.req.query("limit") ?? 400));
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (stream) => {
      const events: TraceEvent[] = [];
      let pulse: WatchPulse | null = null;
      let wake: (() => void) | null = null;
      const offEvent = trace.on((e) => {
        events.push(e);
        wake?.();
      });
      const offPulse = trace.onPulse((p) => {
        pulse = p;
        wake?.();
      });
      const off = () => {
        offEvent();
        offPulse();
      };
      stream.onAbort(off);
      try {
        const first = await snapshot(store, limit);
        // Events that happened while the snapshot loaded can be in both: send them once.
        const sent = new Set(first.map((e) => `${e.type}:${e.seq}:${e.at}`));
        await stream.writeSSE({ event: "snapshot", data: JSON.stringify({ events: first, status: reasoner.status() }) });
        while (!stream.aborted) {
          if (!events.length && !pulse) await new Promise<void>((r) => ((wake = r), setTimeout(r, 20_000)));
          wake = null;
          const batch = events.splice(0).filter((e) => !sent.has(`${e.type}:${e.seq}:${e.at}`));
          if (batch.length) {
            await stream.writeSSE({ event: "events", data: JSON.stringify(batch) });
            if (batch.some((e) => e.type === "thought")) await stream.writeSSE({ event: "status", data: JSON.stringify(reasoner.status()) });
          }
          if (pulse) {
            await stream.writeSSE({ event: "pulse", data: JSON.stringify(pulse) });
            pulse = null;
          }
          if (!batch.length && !pulse) await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally {
        off();
      }
    });
  });

  return app;
}
