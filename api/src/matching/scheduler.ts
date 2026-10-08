/**
 * Polls instead of setting timers: every deadline lives in the store, so a
 * restart or redeploy loses nothing (SRS "Reliable").
 */
import type { Luna } from "./luna.ts";
import { config } from "./config.ts";
import type { MatchingStore } from "./store.ts";
import type { WhatsAppClient } from "./whatsapp/client.ts";
import { drainOutbox } from "./whatsapp/outbox.ts";

export function startScheduler(luna: Luna, store: MatchingStore, client: WhatsAppClient) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await luna.tick(Date.now());
      await drainOutbox(store, client, Date.now());
    } catch (err) {
      console.error("luna tick", err);
    } finally {
      running = false;
    }
  }, config.tickMs);
  timer.unref();   // the HTTP server keeps the process alive; the tick alone shouldn't
  return () => clearInterval(timer);
}
