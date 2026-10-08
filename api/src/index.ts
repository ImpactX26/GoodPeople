import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth, me } from "./auth.ts";
import { areaDetail, mapWeek } from "./map/model.ts";
import { mountMatching } from "./matching/index.ts";
import { store, storeKind } from "./store.ts";
import { delivery } from "./trips/routes.ts";
import { trips } from "./trips/repository.ts";
import { checkCodeConfig } from "./trips/codes.ts";
import { TRIP_CONFIG } from "./trips/config.ts";
import { food, sweepListings } from "./listings/routes.ts";
import { addresses, addressRepo } from "./addresses.ts";
import { listings } from "./listings/repository.ts";
import { tickNgoOffers } from "./listings/offers.ts";

/**
 * Browsers allowed to call the API. CORS_ORIGINS is a comma-separated list
 * (the Netlify site); local dev frontends on localhost are always allowed.
 */
const allowed = (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const isLocal = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);

const app = new Hono();
app.use(logger());
app.use(
  "*",
  cors({
    origin: (o) => (o && (allowed.includes(o) || isLocal(o)) ? o : null),
    allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key", "Last-Event-ID"],
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
    maxAge: 600,
  }),
);

app.get("/health", (c) => c.json({ ok: true, store: storeKind }));
app.route("/auth", auth);
app.route("/me", me);
app.route("/", delivery);
app.route("/", food);
app.route("/", addresses);

// The map week is deterministic sample data: compute once, cache in the CDN/browser for a minute.
const week = mapWeek();
app.get("/map/week", (c) => {
  c.header("Cache-Control", "public, max-age=60");
  return c.json(week);
});
app.get("/map/areas/:id", (c) => {
  const d = areaDetail(c.req.param("id"));
  return d ? c.json(d) : c.json({ error: "Unknown area." }, 404);
});

app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong." }, 500);
});

const port = Number(process.env.PORT ?? 8787);
await store.init();
await listings.init();
await addressRepo.init();
// Trip tables are additive; persistent code encryption needs a stable environment secret.
if (!process.env.DATABASE_URL || process.env.TRIP_CODE_SECRET) {
  checkCodeConfig();
  await trips.init();
  await trips.cleanup(Date.now());
  await tickNgoOffers();
  let tickingOffers = false;
  setInterval(() => {
    if (tickingOffers) return;
    tickingOffers = true;
    void tickNgoOffers().catch(() => console.error("NGO offer timer failed; retrying next tick")).finally(() => { tickingOffers = false; });
  }, TRIP_CONFIG.ngoOfferTickMs).unref();
  setInterval(() => void trips.cleanup(Date.now()).catch(() => console.error("Trip retention cleanup failed")), TRIP_CONFIG.cleanupMs).unref();
}
// Luna's agents (Decision, NGO, Logistics; the Food Agent hands them each checked listing) under /agents.
await mountMatching(app);
// Background work runs on the server from Postgres, with or without anyone signed in.
let sweeping = false;
const sweep = () => {
  if (sweeping) return;
  sweeping = true;
  void sweepListings().then(r => { if (r.checked || r.handed) console.log(`Background: re-ran ${r.checked} food check(s), handed ${r.handed} listing(s) to the agents`); },
    e => console.error("listing sweep failed", e)).finally(() => { sweeping = false; });
};
sweep();
setInterval(sweep, 30_000).unref();
// Railway needs 0.0.0.0; start-luna.sh sets HOST=127.0.0.1 so the phone reaches the API only through the HTTPS website.
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () => console.log(`Luna API on :${port} (${storeKind} store)`));
