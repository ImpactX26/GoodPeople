/**
 * Sends queued messages. The agent only writes to the outbox, so a failed send
 * never undoes a decision; failures retry with backoff and then show up in the
 * admin decision feed.
 */
import { randomUUID } from "node:crypto";
import { config } from "../config.ts";
import type { MatchingStore } from "../store.ts";
import type { WhatsAppClient } from "./client.ts";

let draining = false;

export async function drainOutbox(store: MatchingStore, client: WhatsAppClient, now: number) {
  if (draining) return;
  draining = true;
  try {
    const due = (await store.list("outbox", { status: "pending" })).filter((m) => m.nextAt <= now).sort((a, b) => a.createdAt - b.createdAt);
    for (const m of due) {
      if (!m.to) {
        // A sample (unclaimed) NGO, partner or donor: nobody to message.
        console.log(`[simulated → ${m.audience}] ${m.text}`);
        await store.put("outbox", { ...m, status: "simulated" });
        continue;
      }
      try {
        await client.send(m.to, m);
        await store.put("outbox", { ...m, status: "sent", attempts: m.attempts + 1 });
      } catch (err) {
        const attempts = m.attempts + 1;
        const error = String((err as Error).message ?? err);
        if (attempts >= config.outboxMaxAttempts) {
          await store.put("outbox", { ...m, status: "failed", attempts, error });
          await store.insert("decision", {
            id: `d-${randomUUID()}`,
            at: now,
            subject: m.audience,
            kind: "message_failed",
            reason: `Couldn't send a WhatsApp message to ${m.audience} after ${attempts} tries.`,
            data: { outboxId: m.id, error },
          });
        } else {
          const nextAt = now + config.outboxBaseBackoffMs * 2 ** (attempts - 1);
          await store.put("outbox", { ...m, attempts, nextAt, error });
        }
      }
    }
  } finally {
    draining = false;
  }
}
