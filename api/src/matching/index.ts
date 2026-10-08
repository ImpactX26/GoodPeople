/**
 * Luna's agents (Food, NGO, Logistics, Decision): wires them, their store,
 * routes, the WhatsApp webhook and the scheduler into the API.
 */
import type { Hono } from "hono";
import type { DonorKind } from "../map/model.ts";
import { store as authStore } from "../store.ts";
import type { GapDonor } from "./gaps.ts";
import { createLuna } from "./luna.ts";
import { matchingRoutes } from "./routes.ts";
import { startScheduler } from "./scheduler.ts";
import { areaIdFromName } from "./seed.ts";
import { matchingStore } from "./store.ts";
import { syncDirectory } from "./directory.ts";
import type { Luna } from "./luna.ts";
import { defaultClient, whatsappConfigured } from "./whatsapp/client.ts";
import { whatsappWebhook } from "./whatsapp/webhook.ts";

const DONOR_KIND: Record<string, DonorKind> = {
  Restaurant: "restaurant",
  Caterer: "caterer",
  Hotel: "hotel",
  "Event organiser": "caterer",
  Household: "household",
};

/** Signed-up donors, for gap outreach. */
async function listDonors(): Promise<GapDonor[]> {
  const out: GapDonor[] = [];
  for (const p of await authStore.listProfiles("donor")) {
    const areaId = areaIdFromName(p.fields.area);
    if (!areaId) continue; // "Somewhere else in Bengaluru": no area to match against
    out.push({ key: p.phone, phone: p.phone, name: p.fields.org || p.fields.name || "A donor", areaId, kind: DONOR_KIND[p.fields.kind] ?? "restaurant" });
  }
  return out;
}

let running: Luna | null = null;
/** The agents mounted on this API process (null until mountMatching ran, e.g. in unit tests). */
export const agents = () => running;
export { matchingStore };

export async function mountMatching(app: Hono) {
  await matchingStore.init();
  const luna = createLuna({ store: matchingStore, listDonors });
  await luna.seed();
  running = luna;
  // Real NGOs (their default + today's listing) and volunteer partners, refreshed every minute.
  const sync = () => syncDirectory(matchingStore).then((n) => n, (e) => console.error("directory sync failed", e));
  await sync();
  setInterval(() => void sync(), 60_000).unref();
  app.route("/agents", matchingRoutes(luna, matchingStore));
  app.route("/webhooks/whatsapp", whatsappWebhook(luna, matchingStore));
  startScheduler(luna, matchingStore, defaultClient());
  console.log(`Luna agents ready (WhatsApp ${whatsappConfigured ? "live" : "logging to console"})`);
  return luna;
}
