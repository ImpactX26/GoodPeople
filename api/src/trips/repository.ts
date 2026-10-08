import postgres from "postgres";
import type { DeliveryTrip, TripPoint } from "./types.ts";
import { TRIP_CONFIG as C } from "./config.ts";

export interface TripRepository {
  init(): Promise<void>;
  get(id: string): Promise<DeliveryTrip | null>;
  list(): Promise<DeliveryTrip[]>;
  create(trip: DeliveryTrip): Promise<boolean>;
  save(trip: DeliveryTrip, expectedVersion: number, points?: TripPoint[]): Promise<boolean>;
  cleanup(now: number): Promise<void>;
}
const activePartner = (t: DeliveryTrip) => t.requestStatus === "accepted" && !t.closedAt ? t.partnerPhone : null;
export function memoryTrips(): TripRepository {
  const trips = new Map<string, DeliveryTrip>();
  return {
    async init() {},
    async get(id) { return structuredClone(trips.get(id) ?? null); },
    async list() { return structuredClone([...trips.values()]); },
    async create(t) { if (trips.has(t.id)) return false; trips.set(t.id, structuredClone(t)); return true; },
    async save(t, version) {
      if (trips.get(t.id)?.version !== version) return false;
      if (activePartner(t) && [...trips.values()].some(other => other.id !== t.id && activePartner(other) === activePartner(t))) {
        throw new Error("You're already on a pickup.");
      }
      trips.set(t.id, structuredClone(t)); return true;
    },
    async cleanup(now) {
      for (const t of trips.values()) {
        if (t.closedAt && now - t.closedAt > C.locationRetentionMs) { t.location = null; t.stationaryAnchor = null; }
        if (t.closedAt && now - t.closedAt > C.photoRetentionMs && t.pickupCheck) t.pickupCheck.photo = "";
      }
    },
  };
}
export function postgresTrips(url: string): TripRepository {
  const sql = postgres(url, { max: 5, idle_timeout: 20 });
  return {
    async init() {
      await sql`create table if not exists delivery_trip_docs (
        id text primary key, version int not null, active_partner text,
        body jsonb not null, updated_at timestamptz not null default now())`;
      await sql`create unique index if not exists one_active_trip_per_partner on delivery_trip_docs(active_partner) where active_partner is not null`;
      await sql`create table if not exists trip_points (
        leg_id text not null references delivery_trip_docs(id), at timestamptz not null,
        lat double precision not null, lng double precision not null, accuracy_m double precision not null,
        primary key (leg_id, at))`;
    },
    async get(id) { const [r] = await sql`select body from delivery_trip_docs where id = ${id}`; return r?.body ?? null; },
    async list() { return (await sql`select body from delivery_trip_docs order by updated_at desc`).map(r => r.body); },
    async create(t) {
      const rows = await sql`insert into delivery_trip_docs (id, version, active_partner, body)
        values (${t.id}, ${t.version}, ${activePartner(t)}, ${sql.json(JSON.parse(JSON.stringify(t)))})
        on conflict (id) do nothing returning id`;
      return rows.length > 0;
    },
    async save(t, version, points = []) {
      try {
        return await sql.begin(async tx => {
          const rows = await tx`update delivery_trip_docs set version = ${t.version}, active_partner = ${activePartner(t)},
            body = ${tx.json(JSON.parse(JSON.stringify(t)))}, updated_at = now() where id = ${t.id} and version = ${version} returning id`;
          if (!rows.length) return false;
          for (const p of points) await tx`insert into trip_points (leg_id, at, lat, lng, accuracy_m)
            values (${t.id}, ${new Date(p.at)}, ${p.lat}, ${p.lng}, ${p.accuracyM}) on conflict do nothing`;
          return true;
        });
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new Error("You're already on a pickup.");
        throw e;
      }
    },
    async cleanup(now) {
      await sql`delete from trip_points p using delivery_trip_docs d where p.leg_id = d.id
        and (d.body->>'closedAt')::bigint < ${now - C.locationRetentionMs}`;
      await sql`update delivery_trip_docs set body = jsonb_set(jsonb_set(body, '{location}', 'null'), '{stationaryAnchor}', 'null')
        where (body->>'closedAt')::bigint < ${now - C.locationRetentionMs} and body->'location' <> 'null'`;
      await sql`update delivery_trip_docs set body = jsonb_set(body, '{pickupCheck,photo}', '""')
        where (body->>'closedAt')::bigint < ${now - C.photoRetentionMs} and body->'pickupCheck' <> 'null'`;
    },
  };
}
export const trips = process.env.DATABASE_URL ? postgresTrips(process.env.DATABASE_URL) : memoryTrips();
