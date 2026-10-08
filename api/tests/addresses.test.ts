import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { Hono } from "hono";
import { addresses, validAddresses, type SavedAddress } from "../src/addresses.ts";
import { store, type Role, type Session } from "../src/store.ts";

const app = new Hono().route("/", addresses);
async function account(role: Role, fields: Record<string, string> = {}): Promise<Session> {
  const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  const s: Session = { role, phone, token: randomBytes(16).toString("hex"), signedInAt: Date.now() };
  await store.putSession(s); await store.putProfile({ role, phone, fields: { name: "Ravi", ...fields }, createdAt: Date.now() });
  return s;
}
const call = (path: string, s?: Session, body?: unknown) => app.request(path, {
  method: body === undefined ? "GET" : "PUT",
  headers: { ...(s ? { Authorization: `Bearer ${s.token}` } : {}), "Content-Type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const kitchen: SavedAddress = { id: "adr_abc123", label: "Kitchen", address: "80 Feet Road, Koramangala", notes: "Side gate", lat: 12.9352, lng: 77.6245, isDefault: true };

test("addresses need a name, an address, a Bengaluru pin and exactly one default", () => {
  assert.ok(validAddresses([]));
  assert.ok(validAddresses([kitchen]));
  assert.ok(!validAddresses([{ ...kitchen, isDefault: false }]));
  assert.ok(!validAddresses([kitchen, { ...kitchen, id: "adr_def456" }]));            // two defaults
  assert.ok(!validAddresses([{ ...kitchen, lat: 19.07, lng: 72.87 }]));               // Mumbai
  assert.ok(!validAddresses([{ ...kitchen, label: " " }]));
  assert.ok(!validAddresses(Array.from({ length: 11 }, (_, i) => ({ ...kitchen, id: `adr_x${i}00000`, isDefault: i === 0 }))));
});
test("a donor's first list is seeded from the sign-up pin; saving replaces it", async () => {
  const s = await account("donor", { address: "80 Feet Road, Koramangala", lat: "12.9352", lng: "77.6245", notes: "Ask for Ravi" });
  const first = await (await call("/me/addresses", s)).json();
  assert.equal(first.addresses.length, 1); assert.equal(first.addresses[0].isDefault, true); assert.equal(first.addresses[0].notes, "Ask for Ravi");
  const home = { ...kitchen, id: "adr_home01", label: "Home", isDefault: false };
  const saved = await call("/me/addresses", s, { addresses: [kitchen, home] });
  assert.equal(saved.status, 200);
  assert.equal((await (await call("/me/addresses", s)).json()).addresses.length, 2);
});
test("only signed-in donors manage addresses; the geocoder checks its input", async () => {
  assert.equal((await call("/me/addresses")).status, 401);
  assert.equal((await call("/me/addresses", await account("ngo"))).status, 403);
  const d = await account("donor");
  assert.deepEqual((await (await call("/me/addresses", d)).json()).addresses, []);
  assert.equal((await call("/geo/reverse?lat=x&lng=1", d)).status, 400);
  assert.equal((await call("/geo/reverse?lat=19.07&lng=72.87", d)).status, 422);
  assert.deepEqual(await (await call("/geo/search?q=ab", d)).json(), { results: [] });
});
