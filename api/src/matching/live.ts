/**
 * Instant updates (spec §14.2, "live stream"). Every message an agent sends a person (an offer to an NGO,
 * a pickup request to a partner, an update to a donor) also pings that person's open app over
 * Server-Sent Events, so screens refresh the moment an agent decides instead of on the next poll.
 * In-process: the API runs as one Railway service; the app's slow poll covers a missed ping.
 */
import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(0);

export interface LivePing { kind: string; at: number }

/** Tell everyone signed in with this phone that something changed for them. */
export function ping(phone: string | undefined, kind = "update") {
  if (phone) bus.emit(phone, { kind, at: Date.now() } satisfies LivePing);
}

export function onPing(phone: string, fn: (p: LivePing) => void) {
  bus.on(phone, fn);
  return () => { bus.off(phone, fn); };
}
