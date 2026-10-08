/**
 * Donor incentives (SRS §9), under /agents:
 *   GET  /impact/me?month=2026-10        a restaurant's month and all-time impact, Luna Partner badge, area rank
 *   GET  /impact/report?from=&to=        the CSR / ESG report: verified numbers and the donation log
 *   GET  /impact/leaderboard?month=      public: top zero-waste restaurants per area this month
 *   GET  /bags                           public: surprise bags on sale now
 *   POST /bags                           a restaurant puts bags on sale
 *   GET  /bags/mine                      its bags and who reserved them
 *   POST /bags/:id/reserve               public: reserve one (name + phone), get a pickup code
 *   POST /bags/:id/holds/:hid/collected  the restaurant checks the buyer's code at pickup
 *   POST /bags/:id/close                 the restaurant stops selling
 */
import { randomInt, randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { sessionFrom } from "../auth.ts";
import type { Luna } from "../matching/luna.ts";
import { areaById, areaIdFromName } from "../matching/seed.ts";
import { distanceKm } from "../matching/engine/geo.ts";
import type { MatchingStore } from "../matching/store.ts";
import { store as authStore, type Session } from "../store.ts";
import type { Bag, BagHold } from "./bags.ts";
import { CO2E_PER_KG, KG_PER_SERVING, impactOf, leaderboard, monthRange, partnerSince, thisMonth } from "./impact.ts";

const PHONE = /^[6-9]\d{9}$/;

export function impactRoutes(luna: Luna, store: MatchingStore, clock: () => number = Date.now) {
  const app = new Hono();
  const signedIn = async (c: Context, role: Session["role"]): Promise<Session | Response> => {
    const s = await sessionFrom(c.req.header("Authorization"));
    if (!s) return c.json({ error: "Not signed in." }, 401);
    if (s.role !== role && s.role !== "admin") return c.json({ error: `Only for ${role} accounts.` }, 403);
    return s;
  };
  const method = { kgPerServing: KG_PER_SERVING, co2ePerKg: CO2E_PER_KG, basis: "docs/IMPACT-BASIS.md" };

  /* ---------- impact ---------- */

  app.get("/impact/me", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const now = clock(), month = c.req.query("month") ?? thisMonth(now);
    const range = monthRange(month);
    if (!range) return c.json({ error: "Month is like 2026-10." }, 400);
    const [monthly, allTime, since, board] = await Promise.all([
      impactOf(store, s.phone, range.from, range.to),
      impactOf(store, s.phone, 0, now + 1),
      partnerSince(store, s.phone),
      leaderboard(store, month, 1000),
    ]);
    const profile = await authStore.getProfile("donor", s.phone);
    const name = profile?.fields.org || profile?.fields.name || "Your restaurant";
    // Where this restaurant stands in its area this month (delivered servings).
    let rank: { area: string; position: number; of: number } | null = null;
    for (const a of board?.areas ?? []) {
      const i = a.top.findIndex((r) => r.donor === name);
      if (i >= 0) rank = { area: a.area, position: i + 1, of: a.top.length };
    }
    return c.json({ name, area: profile?.fields.area ?? null, fssai: profile?.fields.fssai ?? null, month, monthly: { ...monthly, log: undefined }, allTime: { ...allTime, log: undefined }, partnerSince: since, rank, method });
  });

  app.get("/impact/report", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const now = clock();
    const from = Number(c.req.query("from") ?? Date.UTC(new Date(now).getUTCFullYear(), 0, 1));
    const to = Number(c.req.query("to") ?? now + 1);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return c.json({ error: "Give from and to as times." }, 400);
    const profile = await authStore.getProfile("donor", s.phone);
    return c.json({ name: profile?.fields.org || profile?.fields.name || "Your restaurant", area: profile?.fields.area ?? null, fssai: profile?.fields.fssai ?? null, generatedAt: now, partnerSince: await partnerSince(store, s.phone), ...(await impactOf(store, s.phone, from, to)), method });
  });

  app.get("/impact/leaderboard", async (c) => {
    const month = c.req.query("month") ?? thisMonth(clock());
    const board = await leaderboard(store, month);
    return board ? c.json({ ...board, method }) : c.json({ error: "Month is like 2026-10." }, 400);
  });

  /* ---------- surprise bags ---------- */

  const publicBag = (b: Bag) => {
    const { donorPhone: _p, ...rest } = b;
    return { ...rest, area: areaById(b.areaId)?.name ?? b.areaId };
  };

  app.get("/bags", async (c) => {
    const now = clock();
    const lat = Number(c.req.query("lat")), lng = Number(c.req.query("lng"));
    const near = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
    const open = (await store.list("bag", { status: "open" })).filter((b) => b.left > 0 && b.pickupUntil > now);
    const rows = open.map((b) => ({ ...publicBag(b), km: near ? Math.round(distanceKm(near, b) * 10) / 10 : null }));
    return c.json(rows.sort((a, b) => (a.km ?? 0) - (b.km ?? 0) || a.pickupUntil - b.pickupUntil));
  });

  app.post("/bags", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const now = clock();
    const title = typeof b.title === "string" ? b.title.trim().slice(0, 60) : "";
    const contents = typeof b.contents === "string" ? b.contents.trim().slice(0, 200) : "";
    const count = Number(b.count), price = Number(b.price), worth = Number(b.worth);
    const pickupFrom = Number(b.pickupFrom), pickupUntil = Number(b.pickupUntil);
    const diet = b.diet === "nonveg" || b.diet === "egg" ? b.diet : "veg";
    if (!title || !contents) return c.json({ error: "Give the bag a name and say what's usually inside." }, 400);
    if (!Number.isInteger(count) || count < 1 || count > 100) return c.json({ error: "Bags: 1 to 100." }, 400);
    if (!Number.isFinite(price) || price < 0 || price > 2000 || !Number.isFinite(worth) || worth <= price) return c.json({ error: "The price must be below what the food is worth." }, 400);
    if (!Number.isFinite(pickupFrom) || !Number.isFinite(pickupUntil) || pickupUntil <= Math.max(now, pickupFrom) || pickupUntil > now + 24 * 3_600_000) return c.json({ error: "Pick-up must end later today or tomorrow." }, 400);
    const profile = await authStore.getProfile("donor", s.phone);
    const f = profile?.fields ?? {};
    const lat = Number(f.lat), lng = Number(f.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !f.address) return c.json({ error: "Add your pickup address to your profile first." }, 400);
    const area = areaIdFromName(f.area) ?? "koramangala";
    const bag: Bag = { id: `bag_${randomUUID().slice(0, 8)}`, donorPhone: s.phone, donorName: f.org || f.name || "Restaurant", areaId: area, address: f.address, lat, lng, title, contents, diet, count, left: count, price: Math.round(price), worth: Math.round(worth), pickupFrom: Math.max(now, pickupFrom), pickupUntil, status: "open", createdAt: now };
    await store.insert("bag", bag);
    return c.json(publicBag(bag), 201);
  });

  app.get("/bags/mine", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const bags = (await store.list("bag", { donorPhone: s.phone })).sort((a, b) => b.createdAt - a.createdAt).slice(0, 30);
    const out = [];
    for (const b of bags) out.push({ ...publicBag(b), holds: (await store.list("bag_hold", { bagId: b.id })).sort((x, y) => x.createdAt - y.createdAt).map(({ phone, ...h }) => ({ ...h, phone })) });
    return c.json(out);
  });

  app.post("/bags/:id/reserve", async (c) => {
    const b = ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : "";
    const phone = typeof b.phone === "string" ? b.phone.replace(/\D/g, "").slice(-10) : "";
    if (!name || !PHONE.test(phone)) return c.json({ error: "Give your name and a 10-digit mobile number." }, 400);
    // One at a time, so two people can't take the last bag.
    const result = await luna.runtime.serial(async () => {
      const bag = await store.get("bag", c.req.param("id"));
      const now = clock();
      if (!bag || bag.status !== "open" || bag.pickupUntil <= now) return { error: "This bag isn't on sale any more.", status: 409 as const };
      const mine = (await store.list("bag_hold", { bagId: bag.id, phone })).find((h) => h.status === "reserved");
      if (mine) return { hold: mine, bag };
      if (bag.left < 1) return { error: "Sold out, sorry.", status: 409 as const };
      const hold: BagHold = { id: `bh_${randomUUID().slice(0, 8)}`, bagId: bag.id, name, phone, code: String(randomInt(1000, 10000)), status: "reserved", createdAt: now };
      await store.insert("bag_hold", hold);
      await store.put("bag", { ...bag, left: bag.left - 1 });
      return { hold, bag: { ...bag, left: bag.left - 1 } };
    });
    if ("error" in result) return c.json({ error: result.error }, result.status);
    return c.json({ code: result.hold.code, holdId: result.hold.id, bag: publicBag(result.bag) }, 201);
  });

  app.post("/bags/:id/holds/:hid/collected", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const { code } = ((await c.req.json().catch(() => ({}))) ?? {}) as { code?: unknown };
    const bag = await store.get("bag", c.req.param("id"));
    if (!bag || (bag.donorPhone !== s.phone && s.role !== "admin")) return c.json({ error: "Bag not found." }, 404);
    const hold = await store.get("bag_hold", c.req.param("hid"));
    if (!hold || hold.bagId !== bag.id) return c.json({ error: "Reservation not found." }, 404);
    if (hold.status !== "reserved") return c.json({ error: "Already collected." }, 409);
    if (String(code ?? "") !== hold.code) return c.json({ error: "That code doesn't match. Ask the buyer to show it again." }, 409);
    await store.put("bag_hold", { ...hold, status: "collected", collectedAt: clock() });
    return c.json({ ok: true });
  });

  app.post("/bags/:id/close", async (c) => {
    const s = await signedIn(c, "donor");
    if (s instanceof Response) return s;
    const bag = await store.get("bag", c.req.param("id"));
    if (!bag || (bag.donorPhone !== s.phone && s.role !== "admin")) return c.json({ error: "Bag not found." }, 404);
    await store.put("bag", { ...bag, status: "closed" });
    return c.json({ ok: true });
  });

  return app;
}
