/**
 * Persistence. Uses Postgres when DATABASE_URL is set (Railway), otherwise an
 * in-memory store so the API runs locally with no setup.
 */
import postgres from "postgres";

export type Role = "donor" | "ngo" | "volunteer" | "admin";

export interface Profile {
  role: Role;
  phone: string;
  fields: Record<string, string>;
  createdAt: number;
}

export interface Otp {
  role: Role;
  phone: string;
  code: string;
  expiresAt: number;
  attemptsLeft: number;
}

export interface Session {
  token: string;
  role: Role;
  phone: string;
  signedInAt: number;
}

export interface Store {
  init(): Promise<void>;
  putOtp(o: Otp): Promise<void>;
  getOtp(role: Role, phone: string): Promise<Otp | null>;
  setOtpAttempts(role: Role, phone: string, attemptsLeft: number): Promise<void>;
  deleteOtp(role: Role, phone: string): Promise<void>;
  getProfile(role: Role, phone: string): Promise<Profile | null>;
  putProfile(p: Profile): Promise<void>;
  listProfiles(role: Role): Promise<Profile[]>;
  putSession(s: Session): Promise<void>;
  getSession(token: string): Promise<Session | null>;
  deleteSession(token: string): Promise<void>;
}

function memoryStore(): Store {
  const otps = new Map<string, Otp>();
  const profiles = new Map<string, Profile>();
  const sessions = new Map<string, Session>();
  const k = (role: Role, phone: string) => `${role}:${phone}`;
  return {
    async init() {},
    async putOtp(o) {
      otps.set(k(o.role, o.phone), o);
    },
    async getOtp(role, phone) {
      return otps.get(k(role, phone)) ?? null;
    },
    async setOtpAttempts(role, phone, n) {
      const o = otps.get(k(role, phone));
      if (o) o.attemptsLeft = n;
    },
    async deleteOtp(role, phone) {
      otps.delete(k(role, phone));
    },
    async getProfile(role, phone) {
      return profiles.get(k(role, phone)) ?? null;
    },
    async putProfile(p) {
      profiles.set(k(p.role, p.phone), p);
    },
    async listProfiles(role) {
      return [...profiles.values()].filter((p) => p.role === role);
    },
    async putSession(s) {
      sessions.set(s.token, s);
    },
    async getSession(token) {
      return sessions.get(token) ?? null;
    },
    async deleteSession(token) {
      sessions.delete(token);
    },
  };
}

function postgresStore(url: string): Store {
  const sql = postgres(url, { max: 5, idle_timeout: 20 });
  const ms = (d: Date | string) => new Date(d).getTime();
  return {
    async init() {
      await sql`
        create table if not exists otps (
          role text not null, phone text not null, code text not null,
          expires_at timestamptz not null, attempts_left int not null,
          primary key (role, phone))`;
      await sql`
        create table if not exists profiles (
          role text not null, phone text not null, fields jsonb not null,
          created_at timestamptz not null default now(),
          primary key (role, phone))`;
      await sql`
        create table if not exists sessions (
          token text primary key, role text not null, phone text not null,
          signed_in_at timestamptz not null default now())`;
    },
    async putOtp(o) {
      await sql`
        insert into otps (role, phone, code, expires_at, attempts_left)
        values (${o.role}, ${o.phone}, ${o.code}, ${new Date(o.expiresAt)}, ${o.attemptsLeft})
        on conflict (role, phone) do update
          set code = excluded.code, expires_at = excluded.expires_at, attempts_left = excluded.attempts_left`;
    },
    async getOtp(role, phone) {
      const [r] = await sql`select * from otps where role = ${role} and phone = ${phone}`;
      return r ? { role, phone, code: r.code, expiresAt: ms(r.expires_at), attemptsLeft: r.attempts_left } : null;
    },
    async setOtpAttempts(role, phone, n) {
      await sql`update otps set attempts_left = ${n} where role = ${role} and phone = ${phone}`;
    },
    async deleteOtp(role, phone) {
      await sql`delete from otps where role = ${role} and phone = ${phone}`;
    },
    async getProfile(role, phone) {
      const [r] = await sql`select * from profiles where role = ${role} and phone = ${phone}`;
      return r ? { role, phone, fields: r.fields, createdAt: ms(r.created_at) } : null;
    },
    async putProfile(p) {
      await sql`
        insert into profiles (role, phone, fields, created_at)
        values (${p.role}, ${p.phone}, ${sql.json(p.fields)}, ${new Date(p.createdAt)})
        on conflict (role, phone) do update set fields = excluded.fields`;
    },
    async listProfiles(role) {
      const rows = await sql`select * from profiles where role = ${role}`;
      return rows.map((r) => ({ role, phone: r.phone, fields: r.fields, createdAt: ms(r.created_at) }));
    },
    async putSession(s) {
      await sql`insert into sessions (token, role, phone, signed_in_at)
                values (${s.token}, ${s.role}, ${s.phone}, ${new Date(s.signedInAt)})`;
    },
    async getSession(token) {
      const [r] = await sql`select * from sessions where token = ${token}`;
      return r ? { token, role: r.role, phone: r.phone, signedInAt: ms(r.signed_in_at) } : null;
    },
    async deleteSession(token) {
      await sql`delete from sessions where token = ${token}`;
    },
  };
}

export const store: Store = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : memoryStore();
export const storeKind = process.env.DATABASE_URL ? "postgres" : "memory";
