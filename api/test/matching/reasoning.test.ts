/**
 * The reasoning layer: the model chain falls back to Groq, every hand-off between agents is traced in
 * order, the model's actions only get through the guardrails when they keep to what the rules approved,
 * and the watcher only asks the model about silence or drift.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { config } from "../../src/matching/config.ts";
import { createLuna, type NewListing } from "../../src/matching/luna.ts";
import { createLlm, parseJson, type Llm } from "../../src/matching/reasoning/llm.ts";
import { createReasoner } from "../../src/matching/reasoning/reasoner.ts";
import { trace } from "../../src/matching/reasoning/trace.ts";
import type { TraceEvent } from "../../src/matching/reasoning/types.ts";
import { memoryMatchingStore, type MatchingStore } from "../../src/matching/store.ts";
import { at, east, KORAMANGALA, listing, partner, recipient } from "./fixtures.ts";

const NGO1 = "9000000001";
const NGO2 = "9000000002";
const NGO3 = "9000000003";
const RIDER = "9000000009";

function newListing(now = at(12)): NewListing {
  const { id: _id, status: _s, createdAt: _c, unplacedServings: _u, ...rest } = listing({ createdAt: now });
  return rest;
}

async function setup(opts: { riderOnline?: boolean } = {}) {
  const store = memoryMatchingStore();
  await store.put("recipient", recipient({ id: "r1", name: "Hope Shelter", phone: NGO1, ...east(KORAMANGALA, 1) }));
  await store.put("recipient", recipient({ id: "r2", name: "Udaya Kitchen", phone: NGO2, ...east(KORAMANGALA, 2) }));
  await store.put("recipient", recipient({ id: "r3", name: "Seva Trust", phone: NGO3, ...east(KORAMANGALA, 3) }));
  await store.put("partner", partner({ id: "p1", name: "Ravi", phone: RIDER, online: opts.riderOnline ?? true, ...east(KORAMANGALA, 1) }));
  return { store, luna: createLuna({ store }) };
}

/** A stand-in model: records what it was asked and answers with whatever `reply` returns. */
function fakeLlm(reply: (purpose: string, user: string) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const asked: { purpose: string; system: string; user: string }[] = [];
  const llm = {
    enabled: true,
    async ask(purpose: "reason" | "watch", system: string, user: string) {
      asked.push({ purpose, system, user });
      return { ok: true as const, json: await reply(purpose, user), model: "fake:model", ms: 1 };
    },
    status: () => ({ enabled: true, cap: 0, callsToday: asked.length, providers: [] }),
  } as unknown as Llm;
  return { llm, asked };
}

const agree = { verdict: "agree", headline: "Looks right", reasoning: ["The closest NGO serves on arrival."], confidence: 0.8, actions: [] };

let stop: (() => void) | undefined;
beforeEach(() => {
  config.reviewFirstListing = false;
  config.simulateUnclaimed = false;
});
afterEach(() => stop?.());

describe("the model chain", () => {
  const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 42 } }), { status: 200 });

  test("Gemini rate-limited: Groq answers, and Gemini sits out its cool-down on the next call", async () => {
    const hosts: string[] = [];
    const llm = createLlm({
      env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "q" },
      fetch: (async (url: string) => {
        hosts.push(new URL(url).host);
        return url.includes("googleapis") ? new Response("slow down", { status: 429, headers: { "retry-after": "30" } }) : ok('{"verdict":"agree"}');
      }) as typeof fetch,
    });
    const first = await llm.ask("reason", "s", "u");
    assert.ok(first.ok);
    assert.equal(first.ok && first.model, "groq:openai/gpt-oss-120b");
    await llm.ask("reason", "s", "u");
    assert.deepEqual(hosts, ["generativelanguage.googleapis.com", "api.groq.com", "api.groq.com"]);
  });

  test("the watcher asks Groq first; a daily cap stops calls instead of spending more", async () => {
    const hosts: string[] = [];
    const llm = createLlm({
      env: { GEMINI_API_KEY: "g", GROQ_API_KEY: "q", LUNA_REASONING_DAILY_CAP: "1" },
      fetch: (async (url: string) => (hosts.push(new URL(url).host), ok("```json\n{\"verdict\":\"concern\"}\n```"))) as typeof fetch,
    });
    const a = await llm.ask("watch", "s", "u");
    assert.ok(a.ok && a.json.verdict === "concern");
    assert.deepEqual(hosts, ["api.groq.com"]);
    const b = await llm.ask("watch", "s", "u");
    assert.ok(!b.ok && /budget/.test(b.error));
  });

  test("no key: reasoning is off and says why", async () => {
    const llm = createLlm({ env: {} });
    assert.equal(llm.enabled, false);
    const a = await llm.ask("reason", "s", "u");
    assert.ok(!a.ok && /No reasoning model/.test(a.error));
  });

  test("JSON is found inside fences or prose", () => {
    assert.deepEqual(parseJson('Sure! ```json {"a":1} ```'), { a: 1 });
    assert.equal(parseJson("no json here"), null);
  });
});

describe("the trace", () => {
  test("a listing's hand-offs run Food → Decision → NGO → Decision → Logistics → Decision, and codes are hidden", async () => {
    const { luna } = await setup();
    const seen: TraceEvent[] = [];
    stop = trace.on((e) => seen.push(e));
    const l = await luna.submitListing(newListing(), at(12));
    const mine = seen.filter((e) => e.listingId === l.id).sort((a, b) => a.seq - b.seq);
    const hops = mine.filter((e) => e.type === "handoff").map((e) => e.type === "handoff" && `${e.from}→${e.to}`);
    assert.deepEqual(hops, ["food→decision", "decision→ngo", "ngo→decision", "decision→logistics", "logistics→decision"]);
    const offer = mine.find((e) => e.type === "message" && e.to === "ngo");
    assert.ok(offer, "the NGO's offer is traced as a message to the NGO");
    for (const e of seen) if (e.type === "message") assert.doesNotMatch(e.text, /code\b[^0-9\n]{0,24}\d{4}\b/i);
  });
});

describe("the reasoning acts only within the rules", () => {
  test("it can move a backup NGO up; the offer already sent stays, and the next offer follows its order", async () => {
    const { store, luna } = await setup();
    const { llm, asked } = fakeLlm(async (_p, user) => {
      if (!user.includes("decided where this food goes")) return agree;
      const [s] = await store.list("share");
      return { verdict: "would_change", headline: "Seva serves sooner", reasoning: ["Seva Trust serves on arrival."], confidence: 0.8, actions: [{ tool: "reorder_backups", shareId: s.id, order: ["r3"] }] };
    });
    const reasoner = createReasoner({ rt: luna.runtime, llm, debounceMs: 5 });
    stop = reasoner.start();
    const l = await luna.submitListing(newListing(), at(12));
    await reasoner.settled();

    const [s] = await store.list("share", { listingId: l.id });
    assert.equal(s.ngoId, "r1", "the first offer is untouched");
    assert.deepEqual(s.candidates.map((c) => c.ngoId), ["r1", "r3", "r2"]);
    const plan = (await store.list("thought", { listingId: l.id })).find((t) => t.point === "plan")!;
    assert.equal(plan.verdict, "would_change");
    assert.equal(plan.actions?.[0].status, "done");
    assert.ok(asked.some((a) => a.system.includes("NGO Agent")), "the NGO Agent's reasoning was asked");

    await luna.ngoReply(s.id, false, { phone: NGO1 }, at(12, 1));
    assert.equal((await store.get("share", s.id))!.ngoId, "r3", "Hope Shelter passed, so Seva Trust is offered next");
  });

  test("an NGO the rules didn't approve as a backup can't be moved up", async () => {
    const { store, luna } = await setup();
    await store.put("recipient", recipient({ id: "r9", name: "Jain Ashram", phone: "9000000099", acceptsDiet: ["jain"], ...east(KORAMANGALA, 1) }));
    const { llm } = fakeLlm(async (_p, user) => {
      if (!user.includes("decided where this food goes")) return agree;
      const [s] = await store.list("share");
      return { ...agree, verdict: "would_change", actions: [{ tool: "reorder_backups", shareId: s.id, order: ["r9"] }, { tool: "nudge_partner", shareId: s.id, text: "Hi" }] };
    });
    const reasoner = createReasoner({ rt: luna.runtime, llm, debounceMs: 5 });
    stop = reasoner.start();
    const l = await luna.submitListing(newListing(), at(12));
    await reasoner.settled();

    const [s] = await store.list("share", { listingId: l.id });
    assert.ok(!s.candidates.some((c) => c.ngoId === "r9"), "the rules filtered out the Jain-only kitchen: this food isn't Jain");
    assert.deepEqual(s.candidates.map((c) => c.ngoId), ["r1", "r2", "r3"], "the backups keep the rules' order");
    const plan = (await store.list("thought", { listingId: l.id })).find((t) => t.point === "plan")!;
    assert.deepEqual(plan.actions?.map((a) => a.status), ["blocked", "blocked"]);
    assert.match(plan.actions![0].note, /isn't one of the backups/);
    assert.match(plan.actions![1].note, /Not one of the tools allowed/);
  });

  test("a model that fails leaves the agents running as they would without it", async () => {
    const { store, luna } = await setup();
    const llm = { enabled: true, ask: async () => ({ ok: false as const, error: "groq: 503", ms: 3 }), status: () => ({}) } as unknown as Llm;
    const reasoner = createReasoner({ rt: luna.runtime, llm, debounceMs: 5 });
    stop = reasoner.start();
    const l = await luna.submitListing(newListing(), at(12));
    await reasoner.settled();
    const [s] = await store.list("share", { listingId: l.id });
    assert.equal(s.status, "offering");
    const thoughts = await store.list("thought", { listingId: l.id });
    assert.ok(thoughts.length >= 2 && thoughts.every((t) => t.status === "failed"));
  });
});

describe("the watcher", () => {
  test("an accepted share with no partner for 5 minutes gets a look, and the model can flag it", async () => {
    const { store, luna } = await setup({ riderOnline: false });
    let clock = at(12);
    const { llm, asked } = fakeLlm((purpose) =>
      purpose === "watch" ? { verdict: "concern", headline: "No rider yet", reasoning: ["Nobody is online near the restaurant."], confidence: 0.9, actions: [{ tool: "flag_for_admin", reason: "No delivery partner online near Sample Hotel." }] } : agree,
    );
    const reasoner = createReasoner({ rt: luna.runtime, llm, debounceMs: 5, now: () => clock });
    stop = reasoner.start();
    const l = await luna.submitListing(newListing(), at(12));
    const [s] = await store.list("share", { listingId: l.id });
    await luna.ngoReply(s.id, true, { phone: NGO1 }, at(12, 1));
    await reasoner.settled();

    const before = asked.filter((a) => a.purpose === "watch").length;
    clock = at(12, 3);
    await reasoner.watch();
    await reasoner.settled();
    assert.equal(asked.filter((a) => a.purpose === "watch").length, before, "2 minutes of waiting is not worth a call");

    clock = at(12, 6);
    await reasoner.watch();
    await reasoner.settled();
    const watch = asked.filter((a) => a.purpose === "watch");
    assert.equal(watch.length, before + 1);
    assert.match(watch.at(-1)!.user, /no delivery partner is free yet/);
    const flags = (await store.list("decision", { listingId: l.id, kind: "escalated" })).filter((d) => d.reason.startsWith("Reasoning flagged"));
    assert.equal(flags.length, 1);

    clock = at(12, 7);
    await reasoner.watch();
    await reasoner.settled();
    assert.equal(asked.filter((a) => a.purpose === "watch").length, before + 1, "the same drift isn't asked about twice in 10 minutes");
  });
});
