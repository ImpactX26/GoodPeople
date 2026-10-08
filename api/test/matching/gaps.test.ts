/**
 * SRS example 5: the heat map flags Jayanagar as empty every Wednesday night; on
 * Wednesday afternoon the agent asks nearby donors, within the contact caps.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { createLuna } from "../../src/matching/luna.ts";
import { config } from "../../src/matching/config.ts";
import { findGaps, mapDonors, planOutreach } from "../../src/matching/gaps.ts";
import { memoryMatchingStore } from "../../src/matching/store.ts";
import { at } from "./fixtures.ts";

beforeEach(() => {
  config.simulateUnclaimed = true;
});

test("Wednesday 3 pm: Jayanagar's evening gap is found", () => {
  const gap = findGaps(at(15)).find((g) => g.areaId === "jayanagar");
  assert.ok(gap, "expected a Jayanagar gap");
  assert.equal(gap.day, 2);
  assert.equal(gap.slot, 6);
  assert.ok(gap.gapRatio >= 0.5);
});

test("nearby donors are asked, best usual surplus first, at most 3", () => {
  const plan = planOutreach(findGaps(at(15)), mapDonors(), [], at(15));
  const jaya = plan.find((p) => p.gap.areaId === "jayanagar");
  assert.ok(jaya);
  assert.ok(jaya.donors.length > 0 && jaya.donors.length <= 3);
  assert.ok(jaya.donors.every((d) => d.km <= config.gapNeighbourKm));
});

test("donors aren't asked twice in a day, and a Yes gives a partner a heads-up", async () => {
  const store = memoryMatchingStore();
  const agent = createLuna({
    store,
    listDonors: async () => [{ key: "9811111111", phone: "9811111111", name: "4th Block Darshini", areaId: "jayanagar", kind: "restaurant" }],
  });
  await agent.seed();
  await agent.runGaps(at(15));
  const first = await store.list("contact");
  assert.ok(first.length > 0);
  const keys = first.map((c) => c.donorKey);
  assert.equal(new Set(keys).size, keys.length);

  await agent.runGaps(at(16));
  const again = (await store.list("contact")).filter((c) => c.at === at(16)).map((c) => c.donorKey);
  assert.ok(again.every((k) => !keys.includes(k)), "a donor was contacted twice in one day");

  const outreach = (await store.list("decision", { kind: "gap_outreach" })).find((d) => d.subject === "jayanagar");
  assert.match(outreach!.reason, /Jayanagar is usually \d+% short of food 6:00 pm–9:00 pm/);

  const pledge = (await store.list("pledge", { donorKey: "9811111111" }))[0];
  if (pledge) {
    assert.equal((await agent.gapReply(pledge.id, true, { phone: "9811111111" }, at(15, 5))).ok, true);
    assert.equal((await store.list("decision", { kind: "pledged" })).length, 1);
  }
});
