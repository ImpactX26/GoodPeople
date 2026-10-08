/**
 * Dev phone-OTP sign-in. No SMS is sent: the code is fixed (DEV_OTP) and, when
 * SHOW_DEV_OTP=1, returned to the client so the demo can display it.
 *
 * Luna has one admin account; no other number can sign in as admin.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { store, type Role, type Session } from "./store.ts";

const ROLES: Role[] = ["donor", "ngo", "volunteer", "admin"];
const DEV_OTP = process.env.DEV_OTP ?? "123456";
const SHOW_DEV_OTP = process.env.SHOW_DEV_OTP === "1";
const OTP_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

/** The only admin. ADMIN_PHONE overrides the number on a test server. */
export const ADMIN = { phone: process.env.ADMIN_PHONE ?? "8618147776", name: "Vrunda.C" };
const NOT_ADMIN = "This number isn’t Luna’s admin. Sign in with the admin number, or choose another role.";

const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as string[]).includes(r);
const isPhone = (p: unknown): p is string => typeof p === "string" && /^[6-9]\d{9}$/.test(p);

export async function sessionFrom(header: string | undefined): Promise<Session | null> {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  const s = token ? await store.getSession(token) : null;
  return s && s.role === "admin" && s.phone !== ADMIN.phone ? null : s;
}

async function newSession(role: Role, phone: string) {
  const s: Session = { token: randomBytes(32).toString("hex"), role, phone, signedInAt: Date.now() };
  await store.putSession(s);
  return s;
}

export const auth = new Hono();

auth.post("/otp", async (c) => {
  const { role, phone } = await c.req.json().catch(() => ({}));
  if (!isRole(role)) return c.json({ error: "Unknown role." }, 400);
  if (!isPhone(phone)) return c.json({ error: "Enter a 10-digit Indian mobile number." }, 400);
  if (role === "admin" && phone !== ADMIN.phone) return c.json({ error: NOT_ADMIN }, 403);
  const expiresAt = Date.now() + OTP_TTL_MS;
  await store.putOtp({ role, phone, code: DEV_OTP, expiresAt, attemptsLeft: MAX_ATTEMPTS });
  return c.json({ expiresAt, ...(SHOW_DEV_OTP ? { devCode: DEV_OTP } : {}) });
});

auth.post("/verify", async (c) => {
  const { role, phone, code } = await c.req.json().catch(() => ({}));
  if (!isRole(role) || !isPhone(phone) || typeof code !== "string") return c.json({ error: "Bad request." }, 400);
  if (role === "admin" && phone !== ADMIN.phone) return c.json({ error: NOT_ADMIN }, 403);

  const otp = await store.getOtp(role, phone);
  if (!otp) return c.json({ ok: false, reason: "no-code" });
  if (Date.now() > otp.expiresAt) return c.json({ ok: false, reason: "expired" });
  if (otp.attemptsLeft <= 0) return c.json({ ok: false, reason: "locked" });
  if (code !== otp.code) {
    const attemptsLeft = otp.attemptsLeft - 1;
    await store.setOtpAttempts(role, phone, attemptsLeft);
    return c.json(attemptsLeft > 0 ? { ok: false, reason: "mismatch", attemptsLeft } : { ok: false, reason: "locked" });
  }

  await store.deleteOtp(role, phone);
  let profile = await store.getProfile(role, phone);
  if (!profile && role === "admin") {
    // The admin is known: no sign-up form, straight in.
    profile = { role, phone, fields: { name: ADMIN.name, org: "Luna" }, createdAt: Date.now() };
    await store.putProfile(profile);
  }
  const session = await newSession(role, phone);
  return c.json({ ok: true, isNew: !profile, token: session.token, signedInAt: session.signedInAt, profile });
});

auth.post("/logout", async (c) => {
  const s = await sessionFrom(c.req.header("Authorization"));
  if (s) await store.deleteSession(s.token);
  return c.body(null, 204);
});

export const me = new Hono();

me.get("/", async (c) => {
  const s = await sessionFrom(c.req.header("Authorization"));
  if (!s) return c.json({ error: "Not signed in." }, 401);
  return c.json({ session: { role: s.role, phone: s.phone, signedInAt: s.signedInAt }, profile: await store.getProfile(s.role, s.phone) });
});

me.put("/profile", async (c) => {
  const s = await sessionFrom(c.req.header("Authorization"));
  if (!s) return c.json({ error: "Not signed in." }, 401);
  const { fields } = await c.req.json().catch(() => ({}));
  const ok =
    fields &&
    typeof fields === "object" &&
    Object.entries(fields).every(([k, v]) => typeof k === "string" && typeof v === "string" && v.length <= 200);
  if (!ok || !String(fields.name ?? "").trim()) return c.json({ error: "Name is required." }, 400);
  const existing = await store.getProfile(s.role, s.phone);
  const profile = { role: s.role, phone: s.phone, fields, createdAt: existing?.createdAt ?? Date.now() };
  await store.putProfile(profile);
  return c.json(profile);
});
