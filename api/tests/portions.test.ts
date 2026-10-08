import assert from "node:assert/strict";
import { test } from "node:test";
import { containersFor, farFrom, findDish, servingsFor } from "../src/listings/portions.ts";

test("spec §7.10 conversion examples", () => {
  assert.equal(servingsFor("Veg biryani", "cooked_meal", { mode: "bulk", amount: 3, unit: "kg" }).servings, 5);
  assert.equal(servingsFor("Idli", "cooked_meal", { mode: "bulk", amount: 80, unit: "pcs" }).servings, 20);
  assert.equal(servingsFor("Chapati", "cooked_meal", { mode: "bulk", amount: 60, unit: "pcs" }).servings, 20);
  assert.equal(servingsFor("Dal", "cooked_meal", { mode: "bulk", amount: 3, unit: "L" }).servings, 20);
  const pay = servingsFor("Payasam", "dairy", { mode: "bulk", amount: 4, unit: "L" });
  assert.equal(pay.servings, 33); assert.equal(pay.role, "extra");
  assert.equal(servingsFor("Meal boxes", "cooked_meal", { mode: "per_person_pack", count: 25 }).servings, 25);
  assert.equal(servingsFor("Pulao", "cooked_meal", { mode: "shared_pack", count: 4, feedsEach: 6 }).servings, 24);
  const ghee = servingsFor("Ghee Rice Special", "cooked_meal", { mode: "bulk", amount: 5, unit: "kg" });
  assert.equal(ghee.servings, 10); assert.equal(ghee.estimate, true);
});

test("names match by alias and near spelling", () => {
  assert.equal(findDish("biriyani").dish?.id, "veg_biryani");
  assert.equal(findDish("chitranna").dish?.id, "lemon_rice");
  assert.equal(findDish("bisi bele bhath").dish?.id, "bisi_bele_bath");
  assert.equal(findDish("Chiken biryani").dish?.id, "chicken_biryani");
  assert.equal(findDish("hotel special chicken biryani").dish?.id, "chicken_biryani");
});

test("donor overrides far from the table are flagged; containers follow §9.5", () => {
  assert.equal(farFrom(15, 10), true); assert.equal(farFrom(12, 10), false);
  const biryani = servingsFor("Veg biryani", "cooked_meal", { mode: "bulk", amount: 6, unit: "kg" });   // 7.5 L
  assert.deepEqual(containersFor([biryani], true), ["2 × 5 L food box"]);
  assert.deepEqual(containersFor([{ servings: 20, litres: null, container: "bag" }], false), ["2 × carry bags"]);
});
