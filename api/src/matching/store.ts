/**
 * Matching persistence, separate from the auth Store. Every record is a JSON
 * document keyed by (kind, id): one Postgres table when DATABASE_URL is set,
 * in memory otherwise. State changes use compare-and-set on `status`, so two
 * events racing (an Accept tap and a timeout) can't both win.
 */
import postgres from "postgres";
import type {
  ContactLog,
  Decision,
  InboundSeen,
  Listing,
  OutboxMessage,
  Partner,
  Pledge,
  PriorityCredit,
  Recipient,
  Share,
} from "./types.ts";
import type { Thought } from "./reasoning/types.ts";

export interface Kinds {
  listing: Listing;
  recipient: Recipient;
  partner: Partner;
  share: Share;
  decision: Decision;
  outbox: OutboxMessage;
  credit: PriorityCredit;
  contact: ContactLog;
  pledge: Pledge;
  wa_in: InboundSeen;
  /** The reasoning layer's looks at what the rules did (reasoning/). */
  thought: Thought;
}
export type Kind = keyof Kinds;

type Where = Record<string, string | number | boolean>;

export interface MatchingStore {
  init(): Promise<void>;
  get<K extends Kind>(kind: K, id: string): Promise<Kinds[K] | null>;
  /** All documents of a kind whose top-level fields equal `where`. */
  list<K extends Kind>(kind: K, where?: Where): Promise<Kinds[K][]>;
  /** Insert if absent; false when the id already exists. */
  insert<K extends Kind>(kind: K, doc: Kinds[K]): Promise<boolean>;
  put<K extends Kind>(kind: K, doc: Kinds[K]): Promise<void>;
  /** Replace only if the stored status is still `expected`. */
  cas<K extends Kind>(kind: K, doc: Kinds[K] & { status: string }, expected: string): Promise<boolean>;
}

const matches = (doc: object, where?: Where) =>
  !where || Object.entries(where).every(([k, v]) => (doc as Record<string, unknown>)[k] === v);

export function memoryMatchingStore(): MatchingStore {
  const data = new Map<string, Map<string, unknown>>();
  const table = (k: Kind) => {
    let t = data.get(k);
    if (!t) data.set(k, (t = new Map()));
    return t;
  };
  // Copies keep callers from mutating stored state behind the store's back.
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    async init() {},
    async get(kind, id) {
      const v = table(kind).get(id);
      return v ? (copy(v) as never) : null;
    },
    async list(kind, where) {
      return [...table(kind).values()].filter((d) => matches(d as object, where)).map(copy) as never;
    },
    async insert(kind, doc) {
      if (table(kind).has(doc.id)) return false;
      table(kind).set(doc.id, copy(doc));
      return true;
    },
    async put(kind, doc) {
      table(kind).set(doc.id, copy(doc));
    },
    async cas(kind, doc, expected) {
      const cur = table(kind).get(doc.id) as { status?: string } | undefined;
      if (!cur || cur.status !== expected) return false;
      table(kind).set(doc.id, copy(doc));
      return true;
    },
  };
}

function postgresMatchingStore(url: string): MatchingStore {
  const sql = postgres(url, { max: 5, idle_timeout: 20 });
  // Drop undefined fields so the document is plain JSON.
  const json = (doc: object) => sql.json(JSON.parse(JSON.stringify(doc)));
  return {
    async init() {
      await sql`
        create table if not exists matching_docs (
          kind text not null, id text not null, data jsonb not null,
          updated_at timestamptz not null default now(),
          primary key (kind, id))`;
    },
    async get(kind, id) {
      const [r] = await sql`select data from matching_docs where kind = ${kind} and id = ${id}`;
      return r ? (r.data as never) : null;
    },
    async list(kind, where) {
      const rows = where
        ? await sql`select data from matching_docs where kind = ${kind} and data @> ${json(where)}`
        : await sql`select data from matching_docs where kind = ${kind}`;
      return rows.map((r) => r.data) as never;
    },
    async insert(kind, doc) {
      const rows = await sql`
        insert into matching_docs (kind, id, data) values (${kind}, ${doc.id}, ${json(doc)})
        on conflict (kind, id) do nothing returning id`;
      return rows.length > 0;
    },
    async put(kind, doc) {
      await sql`
        insert into matching_docs (kind, id, data) values (${kind}, ${doc.id}, ${json(doc)})
        on conflict (kind, id) do update set data = excluded.data, updated_at = now()`;
    },
    async cas(kind, doc, expected) {
      const rows = await sql`
        update matching_docs set data = ${json(doc)}, updated_at = now()
        where kind = ${kind} and id = ${doc.id} and data->>'status' = ${expected} returning id`;
      return rows.length > 0;
    },
  };
}

export const matchingStore: MatchingStore = process.env.DATABASE_URL
  ? postgresMatchingStore(process.env.DATABASE_URL)
  : memoryMatchingStore();
