/**
 * Inbound WhatsApp: Meta's webhook verification and incoming replies (button
 * taps, pickup and drop codes, location pins).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { Actor, Luna, Result } from "../luna.ts";
import type { MatchingStore } from "../store.ts";
import { whatsappEnv } from "./client.ts";
import { fromWhatsApp } from "./phone.ts";

export interface Inbound {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  interactive?: { button_reply?: { id: string } };
  button?: { payload: string };
  location?: { latitude: number; longitude: number };
}

/** All messages in one webhook delivery (status updates are ignored). */
export function messagesOf(payload: unknown): Inbound[] {
  const out: Inbound[] = [];
  const p = payload as { entry?: { changes?: { value?: { messages?: Inbound[] } }[] }[] };
  for (const e of p.entry ?? []) for (const ch of e.changes ?? []) out.push(...(ch.value?.messages ?? []));
  return out;
}

export function validSignature(raw: string, header: string | undefined, secret: string) {
  if (!header?.startsWith("sha256=")) return false;
  const want = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

const HELP = "Hi, this is Luna! Reply using the buttons on our messages. On a pickup, send the restaurant's 4-digit pickup code here; at the NGO, send their drop code.";

export async function handleInbound(luna: Luna, store: MatchingStore, m: Inbound, now: number): Promise<"duplicate" | "handled"> {
  if (!(await store.insert("wa_in", { id: m.id, at: now }))) return "duplicate";
  const phone = fromWhatsApp(m.from);
  const by: Actor = { phone };
  const answer = async (r: Result) => {
    const text = r.ok ? r.message : r.error;
    if (text) await luna.notify(phone, text, now);
  };

  const payload = m.interactive?.button_reply?.id ?? m.button?.payload;
  if (payload) {
    const [kind, key, action] = payload.split(":");
    if (kind === "share") await answer(await luna.ngoReply(key, action === "accept", by, now));
    else if (kind === "redirect") await answer(await luna.redirectReply(key, action === "accept", by, now));
    else if (kind === "ask") await answer(await luna.partnerReply(key, action === "accept", by, now));
    else if (kind === "trip" && action === "late") await answer(await luna.late(key, by, now));
    else if (kind === "fb" && (action === "fewer" || action === "right" || action === "more")) await answer(await luna.feedback(key, action, by, now));
    else if (kind === "gap") await answer(await luna.gapReply(key, action === "yes", by, now));
    return "handled";
  }

  // Codes and location pins belong to the partner's current trip.
  if (m.type === "location" && m.location) {
    const trip = await luna.activeTripFor(phone);
    if (trip) await answer(await luna.location(trip.id, { lat: m.location.latitude, lng: m.location.longitude }, by, now));
    return "handled";
  }
  const body = m.text?.body.trim() ?? "";
  if (/^\d{4}$/.test(body)) {
    const trip = await luna.activeTripFor(phone);
    const which = trip?.status === "assigned" ? "pickup" : "drop";
    await answer(trip ? await luna.enterCode(trip.id, which, body, by, now) : { ok: false, error: "We couldn't find a trip in progress for you." });
    return "handled";
  }
  await luna.notify(phone, HELP, now);
  return "handled";
}

export function whatsappWebhook(luna: Luna, store: MatchingStore, clock: () => number = Date.now) {
  const app = new Hono();

  app.get("/", (c) => {
    const ok = c.req.query("hub.mode") === "subscribe" && !!whatsappEnv.verifyToken && c.req.query("hub.verify_token") === whatsappEnv.verifyToken;
    return ok ? c.text(c.req.query("hub.challenge") ?? "") : c.text("Forbidden", 403);
  });

  app.post("/", async (c) => {
    const raw = await c.req.text();
    // Checked only when the app secret is configured.
    if (whatsappEnv.appSecret && !validSignature(raw, c.req.header("X-Hub-Signature-256"), whatsappEnv.appSecret))
      return c.text("Bad signature", 401);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return c.text("Bad JSON", 400);
    }
    // Answer Meta straight away; process in the background.
    for (const m of messagesOf(payload)) {
      handleInbound(luna, store, m, clock()).catch((err) => console.error("whatsapp inbound", err));
    }
    return c.text("OK");
  });

  return app;
}
