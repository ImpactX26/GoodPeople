import postgres from "postgres";
import type { FoodListing } from "./types.ts";

export interface ListingRepository {
  init(): Promise<void>;
  get(id: string): Promise<FoodListing | null>;
  list(): Promise<FoodListing[]>;
  create(value: FoodListing): Promise<boolean>;
  save(value: FoodListing, expected: number): Promise<boolean>;
}
export function memoryListings(): ListingRepository {
  const data = new Map<string, FoodListing>();
  return {
    async init() {},
    async get(id) { return structuredClone(data.get(id) ?? null); },
    async list() { return structuredClone([...data.values()].sort((a, b) => b.createdAt - a.createdAt)); },
    async create(value) { if (data.has(value.id)) return false; data.set(value.id, structuredClone(value)); return true; },
    async save(value, expected) { if (data.get(value.id)?.version !== expected) return false; data.set(value.id, structuredClone(value)); return true; },
  };
}
function postgresListings(url: string): ListingRepository {
  const sql = postgres(url, { max: 3, idle_timeout: 20 });
  return {
    async init() { await sql`create table if not exists food_listing_docs (id text primary key, version int not null, body jsonb not null)`; },
    async get(id) { const [r] = await sql`select body from food_listing_docs where id = ${id}`; return r?.body ?? null; },
    async list() { return (await sql`select body from food_listing_docs order by (body->>'createdAt')::bigint desc`).map(r => r.body); },
    async create(value) { return (await sql`insert into food_listing_docs (id, version, body) values (${value.id}, ${value.version}, ${sql.json(JSON.parse(JSON.stringify(value)))}) on conflict do nothing returning id`).length > 0; },
    async save(value, expected) { return (await sql`update food_listing_docs set version=${value.version}, body=${sql.json(JSON.parse(JSON.stringify(value)))} where id=${value.id} and version=${expected} returning id`).length > 0; },
  };
}
export const listings = process.env.DATABASE_URL ? postgresListings(process.env.DATABASE_URL) : memoryListings();
