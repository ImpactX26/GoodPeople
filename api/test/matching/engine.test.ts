import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { allocate } from "../../src/matching/engine/allocate.ts";
import { checkRecipient, serveTimeFor } from "../../src/matching/engine/rules.ts";
import { effectiveGrade, isUnsure } from "../../src/matching/engine/safety.ts";
import { fmtTime, istClock, nextClockTime } from "../../src/matching/time.ts";
import { at, item, listing, MIN, recipient, WED_NOON } from "./fixtures.ts";

const leg = (arrival = WED_NOON + 20 * MIN, serveTime = arrival) => ({ arrival, serveTime, dropKm: 2 });

describe("Bengaluru clock", () => {
  test("uses India time regardless of server zone", () => {
    assert.deepEqual(istClock(WED_NOON), { day: 2, minutes: 720, hour: 12 });
    assert.equal(fmtTime(at(20, 5)), "8:05 pm");
  });
  test("next serving time rolls to tomorrow when today's has passed", () => {
    assert.equal(nextClockTime(at(19), ["13:00", "20:00"]), at(20));
    assert.equal(nextClockTime(at(21), ["13:00", "20:00"]), at(13) + 86_400_000);
  });
});

describe("safety", () => {
  test("the stricter of grade and safe time wins", () => {
    assert.equal(effectiveGrade(item({ grade: "A", safeTime: 60 })), "C");
    assert.equal(effectiveGrade(item({ grade: "C", safeTime: 420 })), "C");
    assert.equal(effectiveGrade(item({ grade: "B", safeTime: 0 })), "D");
  });
  test("unsure below 60 % confidence", () => {
    assert.equal(isUnsure(item({ confidence: 59 })), true);
    assert.equal(isUnsure(item({ confidence: 60 })), false);
  });
});

describe("Step 1 rules", () => {
  const l = listing();
  const code = (res: ReturnType<typeof checkRecipient>) => (res.ok ? "OK" : res.code);

  test("Grade D never goes to people, and people food never goes to compost", () => {
    assert.equal(code(checkRecipient(item({ grade: "D" }), l, recipient({ id: "r" }), leg())), "GRADE_D_PEOPLE");
    assert.equal(code(checkRecipient(item({ grade: "D" }), l, recipient({ id: "c", kind: "compost" }), leg())), "OK");
    assert.equal(code(checkRecipient(item(), l, recipient({ id: "c", kind: "animal_shelter" }), leg())), "PEOPLE_FOOD_ONLY");
  });
  test("vulnerable groups only get Grade A", () => {
    const kids = recipient({ id: "k", kind: "orphanage", vulnerable: true });
    assert.equal(code(checkRecipient(item({ grade: "B", safeTime: 240 }), l, kids, leg())), "VULNERABLE_NEEDS_A");
    assert.equal(code(checkRecipient(item(), l, kids, leg())), "OK");
  });
  test("fridge food only where there's a fridge", () => {
    assert.equal(code(checkRecipient(item(), listing({ storage: "fridge" }), recipient({ id: "r" }), leg())), "NEEDS_FRIDGE");
    assert.equal(code(checkRecipient(item(), listing({ storage: "hot" }), recipient({ id: "r" }), leg())), "OK");
  });
  test("diet, halal and allergens", () => {
    const vegOnly = recipient({ id: "v", acceptsDiet: ["veg", "jain"] });
    assert.equal(code(checkRecipient(item({ diet: "nonveg" }), l, vegOnly, leg())), "DIET");
    assert.equal(code(checkRecipient(item({ diet: "unknown" }), l, vegOnly, leg())), "DIET");
    const halal = recipient({ id: "h", halalOnly: true });
    assert.equal(code(checkRecipient(item({ diet: "nonveg" }), l, halal, leg())), "DIET");
    assert.equal(code(checkRecipient(item({ diet: "nonveg", halal: true }), l, halal, leg())), "OK");
    const nuts = recipient({ id: "n", avoidAllergens: ["nuts"] });
    assert.equal(code(checkRecipient(item({ allergens: ["nuts"] }), l, nuts, leg())), "DIET");
  });
  test("food must be safe until it is served, not just until it arrives", () => {
    const r = recipient({ id: "r", servingTimes: ["20:00"] });
    const arrival = at(18);
    const res = checkRecipient(item({ safeTime: 90, grade: "C" }), listing({ createdAt: at(17, 45) }), r, leg(arrival, serveTimeFor(r, arrival)));
    assert.equal(code(res), "EXPIRES_BEFORE_SERVING");
  });
  test("Grade C only where it's served within an hour of arriving", () => {
    const r = recipient({ id: "r", servingTimes: ["14:00"] });
    const arrival = at(12, 30);
    assert.equal(code(checkRecipient(item({ grade: "C", safeTime: 170 }), l, r, leg(arrival, serveTimeFor(r, arrival)))), "GRADE_C_SLOW");
  });
});

describe("allocate", () => {
  test("splits by capacity and reports leftovers", () => {
    const r1 = recipient({ id: "r1" });
    const r2 = recipient({ id: "r2" });
    const s = (r: typeof r1) => ({ recipient: r, leg: leg(), score: 1, factors: {} as never });
    const out = allocate([item({ servings: 150 })], new Map([["i1", [s(r1), s(r2)]]]), new Map([["r1", 80], ["r2", 40]]));
    assert.deepEqual(
      out.offers.map((o) => [o.recipientId, o.lines[0].servings]),
      [["r1", 80], ["r2", 40]],
    );
    assert.deepEqual(out.unallocated, [{ itemId: "i1", servings: 30 }]);
  });
});
