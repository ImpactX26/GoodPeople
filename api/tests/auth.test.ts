import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, auth, me, sessionFrom } from "../src/auth.ts";

const post = (path: string, body: unknown) =>
  auth.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("only the admin number can sign in as admin, with an OTP", async () => {
  const other = await post("/otp", { role: "admin", phone: "9700000009" });
  assert.equal(other.status, 403);
  assert.equal((await post("/verify", { role: "admin", phone: "9700000009", code: "123456" })).status, 403);

  assert.equal((await post("/otp", { role: "admin", phone: ADMIN.phone })).status, 200);
  const wrong = await (await post("/verify", { role: "admin", phone: ADMIN.phone, code: "000000" })).json();
  assert.equal(wrong.reason, "mismatch");
  const v = await (await post("/verify", { role: "admin", phone: ADMIN.phone, code: process.env.DEV_OTP ?? "123456" })).json();
  assert.equal(v.ok, true);
  assert.equal(v.isNew, false, "the admin skips the sign-up form");
  assert.equal(v.profile.fields.name, "Vrunda.C");

  const res = await me.request("/", { headers: { Authorization: `Bearer ${v.token}` } });
  assert.equal((await res.json()).session.role, "admin");
});

test("other roles still sign in with any number", async () => {
  assert.equal((await post("/otp", { role: "donor", phone: "9700000009" })).status, 200);
});

test("an admin session for another number is refused", async () => {
  const { store } = await import("../src/store.ts");
  await store.putSession({ token: "old-admin", role: "admin", phone: "9700000009", signedInAt: Date.now() });
  assert.equal(await sessionFrom("Bearer old-admin"), null);
});
