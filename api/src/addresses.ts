/**
 * Saved pickup addresses for donors, and a small geocoding proxy for the pin picker.
 *
 * Addresses live in their own table (profile fields are short strings and are replaced
 * wholesale on save). Geocoding goes through OpenStreetMap Nominatim from the server, so
 * the browser needs no key, results are cached, and Nominatim's 1 request/second rule holds.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import postgres from "postgres";
import { sessionFrom } from "./auth.ts";
import { store, type Session } from "./store.ts";

export interface SavedAddress {
  id: string;
  /** Short name the donor recognises: "Kitchen", "Home", "Banquet hall". */
  label: string;
  address: string;
  /** Instructions for the delivery partner. */
  notes: string;
  lat: number;
  lng: number;
  isDefault: boolean;
}

const MAX_ADDRESSES = 10;

interface AddressRepo {
  init(): Promise<void>;
  get(phone: string): Promise<SavedAddress[] | null>;
  put(phone: string, list: SavedAddress[]): Promise<void>;
}
function memoryRepo(): AddressRepo {
  const data = new Map<string, SavedAddress[]>();
  return {
    async init() {},
    async get(phone) { return structuredClone(data.get(phone) ?? null); },
    async put(phone, list) { data.set(phone, structuredClone(list)); },
  };
}
function postgresRepo(url: string): AddressRepo {
  const sql = postgres(url, { max: 2, idle_timeout: 20 });
  return {
    async init() { await sql`create table if not exists donor_addresses (phone text primary key, body jsonb not null)`; },
    async get(phone) { const [r] = await sql`select body from donor_addresses where phone = ${phone}`; return r?.body ?? null; },
    async put(phone, list) {
      const body = sql.json(JSON.parse(JSON.stringify(list)));
      await sql`insert into donor_addresses (phone, body) values (${phone}, ${body}) on conflict (phone) do update set body = excluded.body`;
    },
  };
}
export const addressRepo = process.env.DATABASE_URL ? postgresRepo(process.env.DATABASE_URL) : memoryRepo();

/** Bengaluru pilot area (with margin). */
const inPilot = (lat: number, lng: number) => lat >= 12.6 && lat <= 13.35 && lng >= 77.25 && lng <= 77.95;

export function validAddresses(v: unknown): v is SavedAddress[] {
  if (!Array.isArray(v) || v.length > MAX_ADDRESSES) return false;
  const ids = new Set<string>();
  for (const a of v) {
    if (!a || typeof a !== "object") return false;
    const x = a as SavedAddress;
    if (typeof x.id !== "string" || !/^adr_[a-z0-9]{6,24}$/.test(x.id) || ids.has(x.id)) return false;
    ids.add(x.id);
    if (typeof x.label !== "string" || !x.label.trim() || x.label.length > 40) return false;
    if (typeof x.address !== "string" || !x.address.trim() || x.address.length > 200) return false;
    if (typeof x.notes !== "string" || x.notes.length > 200) return false;
    if (!Number.isFinite(x.lat) || !Number.isFinite(x.lng) || !inPilot(x.lat, x.lng)) return false;
    if (typeof x.isDefault !== "boolean") return false;
  }
  return v.length === 0 || v.filter(a => (a as SavedAddress).isDefault).length === 1;
}

/** The donor's list; on first use, seeds a default from the sign-up profile if it had a pin. */
async function listFor(s: Session): Promise<SavedAddress[]> {
  const saved = await addressRepo.get(s.phone);
  if (saved) return saved;
  const f = (await store.getProfile("donor", s.phone))?.fields ?? {};
  const lat = Number(f.lat), lng = Number(f.lng);
  if (!f.address?.trim() || !Number.isFinite(lat) || !Number.isFinite(lng) || !inPilot(lat, lng)) return [];
  const seeded = [{ id: `adr_${randomBytes(6).toString("hex")}`, label: f.kind === "Household" ? "Home" : "Kitchen", address: f.address.slice(0, 200),
    notes: (f.notes ?? "").slice(0, 200), lat, lng, isDefault: true }];
  await addressRepo.put(s.phone, seeded); // keep the id stable from now on
  return seeded;
}

type Env = { Variables: { session: Session } };
export const addresses = new Hono<Env>();
// Scoped paths only: this app is mounted at "/", so a "*" middleware would guard every route.
const signedIn = async (c: import("hono").Context<Env>, next: () => Promise<void>) => {
  const s = await sessionFrom(c.req.header("Authorization"));
  if (!s) return c.json({ error: "Sign in first." }, 401);
  c.set("session", s); c.header("Cache-Control", "no-store"); return next();
};
addresses.use("/me/addresses", signedIn);
addresses.use("/geo/*", signedIn);
addresses.get("/me/addresses", async c => {
  const s = c.get("session");
  if (s.role !== "donor") return c.json({ error: "Only donors save pickup addresses." }, 403);
  return c.json({ addresses: await listFor(s), max: MAX_ADDRESSES });
});
addresses.put("/me/addresses", async c => {
  const s = c.get("session");
  if (s.role !== "donor") return c.json({ error: "Only donors save pickup addresses." }, 403);
  const body = await c.req.json().catch(() => null);
  const list = body?.addresses;
  if (!validAddresses(list)) {
    return c.json({ error: `Each address needs a name, the address and a pin inside Bengaluru. Up to ${MAX_ADDRESSES}, one marked default.` }, 400);
  }
  const clean = list.map(a => ({ ...a, label: a.label.trim(), address: a.address.trim(), notes: a.notes.trim() }));
  await addressRepo.put(s.phone, clean);
  return c.json({ addresses: clean, max: MAX_ADDRESSES });
});

/* ---------- geocoding proxy (OpenStreetMap Nominatim) ---------- */

const NOMINATIM = process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org";
const UA = "LunaFoodRescue/0.1 (Bengaluru pilot; surplus food to NGOs)";
const cache = new Map<string, unknown>();
let nextSlot = 0;

async function nominatim(path: string): Promise<unknown> {
  if (cache.has(path)) return cache.get(path);
  // Nominatim policy: at most one request per second from this server.
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + 1100;
  if (wait) await new Promise(r => setTimeout(r, wait));
  const res = await fetch(`${NOMINATIM}${path}`, { headers: { "User-Agent": UA, "Accept-Language": "en-IN,en" }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`geocoder ${res.status}`);
  const data = await res.json();
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(path, data);
  return data;
}

interface NominatimPlace { display_name: string; lat: string; lon: string; address?: Record<string, string> }
/** "#12, 3rd Cross, Koramangala, Bengaluru 560034" style, dropping state/country noise. */
function shortAddress(p: NominatimPlace) {
  const a = p.address ?? {};
  // city_district is the municipal corporation ("Bengaluru South City Corporation"): noise for a pickup address
  const parts = [a.house_number, a.road, a.neighbourhood ?? a.quarter, a.suburb, a.city ?? a.town ?? "Bengaluru", a.postcode]
    .filter((x, i, all): x is string => !!x && all.indexOf(x) === i);
  return (parts.length >= 3 ? parts.join(", ") : p.display_name).slice(0, 200);
}

addresses.get("/geo/reverse", async c => {
  const lat = Number(c.req.query("lat")), lng = Number(c.req.query("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return c.json({ error: "lat and lng are required." }, 400);
  if (!inPilot(lat, lng)) return c.json({ error: "Luna works in Bengaluru for now. Move the pin inside the city." }, 422);
  try {
    const p = await nominatim(`/reverse?format=jsonv2&addressdetails=1&zoom=18&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`) as NominatimPlace;
    return c.json({ address: shortAddress(p), area: p.address?.suburb ?? p.address?.neighbourhood ?? null });
  } catch {
    return c.json({ error: "Couldn't look up this spot. Type the address instead." }, 503);
  }
});
addresses.get("/geo/search", async c => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 3 || q.length > 120) return c.json({ results: [] });
  try {
    const list = await nominatim(`/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=in&viewbox=77.25,13.35,77.95,12.6&bounded=1&q=${encodeURIComponent(q)}`) as NominatimPlace[];
    return c.json({ results: list.map(p => ({ address: shortAddress(p), lat: Number(p.lat), lng: Number(p.lon) })).filter(r => inPilot(r.lat, r.lng)) });
  } catch {
    return c.json({ error: "Search isn't available right now. Move the pin on the map instead." }, 503);
  }
});
