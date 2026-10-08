#!/usr/bin/env node
/**
 * Proves Luna's background work runs on the server with nobody signed in.
 *
 *   node scripts/check-background.mjs --photo path/to/food.jpg     list test food, sign out, wait, read
 *   node scripts/check-background.mjs --watch lst_…                read one listing's agent log again
 *
 * A test donor ("TEST background check, please ignore") lists the food and signs out at once.
 * After 90 s with no session open, an admin signs in only to read what the server did meanwhile:
 * the Food Agent's photo check, the case, the NGO Agent's ranking and the Logistics Agent's offer.
 * Run --watch about 10 minutes later to see the offer expire on the server's own timer.
 *
 * Uses the dev sign-in code (SHOW_DEV_OTP / DEV_OTP on the API). API_URL overrides the Railway URL.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const API = (process.env.API_URL ?? "https://api-production-a32be.up.railway.app").replace(/\/$/, "");
const CODE = process.env.DEV_OTP ?? "123456";
const DONOR = "9700000001", ADMIN = "9700000009";
const args = process.argv.slice(2), arg = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const j = (r) => r.json(), wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t = (ms) => new Date(ms).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
const H = (tok) => ({ "Content-Type": "application/json", Authorization: `Bearer ${tok}` });

async function signIn(role, phone, fields) {
  await fetch(`${API}/auth/otp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, phone }) });
  const v = await fetch(`${API}/auth/verify`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role, phone, code: CODE }) }).then(j);
  if (!v.token) throw new Error(`Sign-in failed for ${role}: ${JSON.stringify(v)}`);
  if (fields) await fetch(`${API}/me/profile`, { method: "PUT", headers: H(v.token), body: JSON.stringify({ fields }) });
  return v.token;
}

async function show(id, since = 0) {
  const admin = await signIn("admin", ADMIN, { name: "Luna admin" });
  const readAt = Date.now();
  const l = await fetch(`${API}/listings/${id}`, { headers: H(admin) }).then(j);
  if (l.error) throw new Error(l.error);
  console.log(`${t(readAt)}  admin signed in to read ${id}\n`);
  console.log(`state: ${l.state} · ${l.progress}`);
  console.log(l.foodCheck ? `food check: done at ${t(l.foodCheck.at)} by ${l.foodCheck.models?.photo ?? "rules only"} · Grade ${l.foodCheck.grade} · tags ${l.foodCheck.tagsVerdict ?? "ok"}` : "food check: not done yet");
  for (const e of l.agentCase?.timeline ?? []) console.log(`  ${t(e.at)}  [${e.agent ?? "luna"}] ${e.reason}${since && e.at < since ? "  ✓ before anyone signed in" : ""}`);
  if (!l.agentCase) console.log("  (not handed to the agents yet)");
}

const watch = arg("--watch");
if (watch) {
  await show(watch);
} else {
  const photoPath = arg("--photo");
  if (!photoPath) { console.error("Give a food photo: node scripts/check-background.mjs --photo path/to/food.jpg"); process.exit(1); }
  const mime = { ".png": "image/png", ".webp": "image/webp" }[extname(photoPath).toLowerCase()] ?? "image/jpeg";
  const photo = `data:${mime};base64,${readFileSync(photoPath).toString("base64")}`;
  const donor = await signIn("donor", DONOR, { name: "Test", org: "TEST background check", kind: "Restaurant", area: "Indiranagar" });
  const now = Date.now();
  const body = {
    dish: "TEST background check – please ignore", diet: "nonveg", jain: false, halal: "unsure", contains: ["onion_garlic", "dairy"], spice: "medium",
    entryMode: "per_person_pack", count: 5, feedsEach: 1, photo, category: "cooked_meal", cookedAt: now - 20 * 60e3, storage: "hot",
    readyFrom: now, collectBy: now + 120 * 60e3, containers: "donor_packs", declarationAccepted: true,
    pickup: { name: "TEST background check", address: "100 Feet Road, Indiranagar", area: "Indiranagar", notes: "", lat: 12.9716, lng: 77.6411 },
    contactName: "Test", contactPhone: DONOR,
  };
  const res = await fetch(`${API}/listings`, { method: "POST", headers: { ...H(donor), "Idempotency-Key": `bg-${now}` }, body: JSON.stringify(body) });
  const { id, error } = await res.json();
  if (!id) throw new Error(error ?? `listing failed (${res.status})`);
  console.log(`${t(Date.now())}  test donor listed ${id}`);
  await fetch(`${API}/auth/logout`, { method: "POST", headers: H(donor) });
  const me = await fetch(`${API}/me`, { headers: H(donor) });
  console.log(`${t(Date.now())}  donor signed out (their token now gets HTTP ${me.status}); nobody is signed in from here`);
  console.log("            waiting 90 s…");
  await wait(90_000);
  await show(id, Date.now());
  console.log(`\nIn ~10 min, see the offer expire on the server's own timer:\n  node scripts/check-background.mjs --watch ${id}`);
}
