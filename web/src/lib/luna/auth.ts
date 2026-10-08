/**
 * Sign-in against the Luna API (dev phone OTP).
 *
 * The session token and the signed-in profile are cached in localStorage so
 * screens can read them synchronously; the API is the source of truth.
 */
import { api } from "./api";
import type { Role } from "./roles";

export const OTP_LENGTH = 6;
export const RESEND_AFTER_S = 30;

export interface Profile {
  role: Role;
  phone: string;
  fields: Record<string, string>;
  createdAt: number;
}

export interface Session {
  role: Role;
  phone: string;
  signedInAt: number;
  token: string;
}

export type VerifyResult =
  | { ok: true; isNew: boolean }
  | { ok: false; reason: "mismatch"; attemptsLeft: number }
  | { ok: false; reason: "locked" | "expired" | "no-code" };

const KEY = {
  session: "luna.session",
  profile: "luna.profile",
  /** Token of a verified number that hasn't finished sign-up yet. */
  pending: "luna.pendingSession",
};

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked (private mode): this page view still works.
  }
}

/** Indian mobile numbers: 10 digits, starting 6–9. */
export function isValidPhone(digits: string) {
  return /^[6-9]\d{9}$/.test(digits);
}

export function formatPhone(digits: string) {
  return `+91 ${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/** Sends a code. In dev the API returns it as `devCode` so the screen can show it. */
export async function requestOtp(role: Role, phone: string) {
  return api<{ expiresAt: number; devCode?: string }>("/auth/otp", {
    method: "POST",
    body: JSON.stringify({ role, phone }),
  });
}

export async function verifyOtp(role: Role, phone: string, code: string): Promise<VerifyResult> {
  const res = await api<
    | { ok: true; isNew: boolean; token: string; signedInAt: number; profile: Profile | null }
    | Exclude<VerifyResult, { ok: true }>
  >("/auth/verify", { method: "POST", body: JSON.stringify({ role, phone, code }) });
  if (!res.ok) return res;

  const session: Session = { role, phone, signedInAt: res.signedInAt, token: res.token };
  if (res.isNew) {
    write(KEY.pending, session);
  } else {
    write(KEY.session, session);
    write(KEY.profile, res.profile);
  }
  return { ok: true, isNew: res.isNew };
}

export async function completeProfile(role: Role, phone: string, fields: Record<string, string>) {
  const pending = read<Session>(KEY.pending);
  if (!pending || pending.role !== role || pending.phone !== phone) throw new Error("Sign-in expired. Start again.");
  const profile = await api<Profile>("/me/profile", {
    method: "PUT",
    token: pending.token,
    body: JSON.stringify({ fields }),
  });
  write(KEY.pending, null);
  write(KEY.session, pending);
  write(KEY.profile, profile);
}

export function getSession(): Session | null {
  try { const demo = sessionStorage.getItem("luna.appDemo.session"); if (demo) return JSON.parse(demo) as Session; } catch {}
  const s = read<Session>(KEY.session);
  return s?.token ? s : null;
}

export function getProfile(role: Role, phone: string): Profile | null {
  try { const raw = sessionStorage.getItem("luna.appDemo.profile"); const demo = raw ? JSON.parse(raw) as Profile : null; if (demo?.role === role && demo.phone === phone) return demo; } catch {}
  const p = read<Profile>(KEY.profile);
  return p && p.role === role && p.phone === phone ? p : null;
}

export function signOut() {
  const s = getSession();
  if (sessionStorage.getItem("luna.appDemo.session")) {
    sessionStorage.removeItem("luna.appDemo.session"); sessionStorage.removeItem("luna.appDemo.profile");
    if (s) void api("/auth/logout", { method: "POST", token: s.token }).catch(() => {});
    return;
  }
  write(KEY.session, null);
  write(KEY.profile, null);
  write(KEY.pending, null);
  if (s) void api("/auth/logout", { method: "POST", token: s.token }).catch(() => {});
}
/** Each walkthrough tab uses a normal API session without replacing the user's regular login. */
export function setWalkthroughAccount(session: Session, profile: Profile) {
  sessionStorage.setItem("luna.appDemo.session", JSON.stringify(session));
  sessionStorage.setItem("luna.appDemo.profile", JSON.stringify(profile));
}

/** Saves edited profile fields (the server replaces all fields, so send the whole set) and refreshes the cache. */
export async function updateProfile(session: Session, fields: Record<string, string>) {
  const profile = await api<Profile>("/me/profile", { method: "PUT", token: session.token, body: JSON.stringify({ fields }) });
  try {
    if (sessionStorage.getItem("luna.appDemo.profile")) sessionStorage.setItem("luna.appDemo.profile", JSON.stringify(profile));
    else write(KEY.profile, profile);
  } catch { write(KEY.profile, profile); }
  return profile;
}
