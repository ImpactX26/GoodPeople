import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { parseListing } from "../../src/matching/routes.ts";
import { body } from "../../src/matching/whatsapp/client.ts";
import { fromWhatsApp, toWhatsApp } from "../../src/matching/whatsapp/phone.ts";
import { foodOffer } from "../../src/matching/whatsapp/templates.ts";
import { messagesOf, validSignature } from "../../src/matching/whatsapp/webhook.ts";
import { at } from "./fixtures.ts";

const session = { token: "t", role: "donor" as const, phone: "9800000001", signedInAt: 0 };
const profile = { role: "donor" as const, phone: "9800000001", fields: { name: "Ravi", org: "Meghana Mess", area: "HSR Layout" }, createdAt: 0 };
const checker = { servings: 30, grade: "B", confidence: 85, safeTime: 240 };

describe("parseListing", () => {
  test("fills safe defaults from the donor's profile", () => {
    const l = parseListing({ items: [checker] }, session, profile, at(12));
    assert.ok(!("error" in l));
    assert.equal(l.areaId, "hsr");
    assert.equal(l.donorName, "Meghana Mess");
    assert.equal(l.pickupAddress, "Meghana Mess, HSR Layout");
    assert.equal(l.storage, "room");
    assert.equal(l.items[0].diet, "unknown");
    assert.deepEqual(l.containers, []);
    assert.equal(l.collectBy - l.readyFrom, 3_600_000);
  });
  test("reads the Food Passport fields: name, quantity, packing, containers", () => {
    const l = parseListing(
      { items: [{ ...checker, name: "veg biryani", quantity: { amount: 6, unit: "kg" }, packing: "foil trays", tags: ["veg"] }, { ...checker, name: "payasam", quantity: 4, unit: "L" }], containers: ["2 insulated bags", "1 crate"] },
      session,
      profile,
      at(12),
    );
    assert.ok(!("error" in l));
    assert.deepEqual(l.items[0].quantity, { amount: 6, unit: "kg" });
    assert.deepEqual(l.items[1].quantity, { amount: 4, unit: "L" });
    assert.equal(l.items[0].packing, "foil trays");
    assert.deepEqual(l.containers, ["2 insulated bags", "1 crate"]);
  });
  test("safeTime is required", () => {
    const l = parseListing({ items: [{ ...checker, safeTime: undefined }] }, session, profile, at(12));
    assert.match((l as { error: string }).error, /safeTime/);
  });
  test("needs an area or a location", () => {
    const l = parseListing({ items: [checker] }, session, { ...profile, fields: { name: "x", area: "Somewhere else in Bengaluru" } }, at(12));
    assert.match((l as { error: string }).error, /area/);
  });
});

describe("WhatsApp edge", () => {
  test("phone formats", () => {
    assert.equal(toWhatsApp("9876543210"), "919876543210");
    assert.equal(fromWhatsApp("919876543210"), "9876543210");
  });
  test("plain mode sends reply buttons; template mode sends the approved template", () => {
    const m = foodOffer({ shareId: "o1", servings: 40, food: "veg rice", grade: "B", safeUntil: at(21), arriveBy: at(19, 40), minutes: 5 });
    const plain = body("9876543210", m, false) as { type: string; interactive: { action: { buttons: { reply: { id: string } }[] } } };
    assert.equal(plain.type, "interactive");
    assert.deepEqual(plain.interactive.action.buttons.map((b) => b.reply.id), ["share:o1:accept", "share:o1:decline"]);
    const tpl = body("9876543210", m, true) as { type: string; template: { name: string; components: { parameters: { text?: string; payload?: string }[] }[] } };
    assert.equal(tpl.type, "template");
    assert.equal(tpl.template.name, "luna_food_offer");
    assert.deepEqual(tpl.template.components[0].parameters.map((p) => p.text), ["40", "veg rice", "B", "9:00 pm", "7:40 pm", "5"]);
    assert.equal(tpl.template.components[1].parameters[0].payload, "share:o1:accept");
  });
  test("webhook signature and message parsing", () => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.1", from: "919876543210", type: "text", text: { body: "1234" } }] } }] }] });
    const sig = "sha256=" + createHmac("sha256", "secret").update(raw).digest("hex");
    assert.equal(validSignature(raw, sig, "secret"), true);
    assert.equal(validSignature(raw, sig, "other"), false);
    assert.equal(validSignature(raw, undefined, "secret"), false);
    assert.equal(messagesOf(JSON.parse(raw))[0].text?.body, "1234");
  });
});
