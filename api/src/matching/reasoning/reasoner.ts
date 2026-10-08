/**
 * The reasoning layer on top of the agents' rules. The rules act first, in milliseconds, inside the agents'
 * one-at-a-time queue. This looks at what they did from outside that queue, so a slow or missing model never
 * holds anyone up, and it can act only through three guarded tools. An action goes back through the same
 * queue as a button tap, after checks the model can't talk its way past.
 *
 *   hand-off ─▶ wait 1.5 s for the burst to settle ─▶ facts ─▶ LLM (Gemini, then Groq) ─▶ guardrails ─▶ act
 *   every 30 s: the watcher's rules look for silence or drift ─▶ LLM (Groq first) only when they find some
 */
import { foodOf, safeUntilOf, usable, type Runtime } from "../runtime.ts";
import { assembleMeals, pairingIsAChoice, roleOf, rulePairs, type Pairing } from "../engine/bundles.ts";
import type { AgentName, DecisionKind, Item, Listing, Share } from "../types.ts";
import * as msg from "../whatsapp/templates.ts";
import { foodFacts, namesOf, ngoFacts, partnerFacts, ruleLog, shareFacts } from "./facts.ts";
import type { Llm } from "./llm.ts";
import { systemPrompt, userPrompt, type Tool } from "./prompts.ts";
import { trace } from "./trace.ts";
import type { ActionRecord, Point, Thought, TraceEvent, Verdict } from "./types.ts";

const MIN = 60_000;
const LIVE = new Set<Share["status"]>(["offering", "finding_partner", "assigned", "picked_up"]);
const ON_TRIP = new Set<Share["status"]>(["assigned", "picked_up"]);
/** Logistics events that mean something went off plan. */
const PROBLEMS = new Set(["unplaced", "behind_schedule", "unsafe_delay", "redirect_failed", "redirected", "stuck", "partner_exhausted"]);
/** Decisions that mean trouble, whichever agent noticed it. */
const TROUBLE = new Set<DecisionKind>(["delayed", "reassigned", "redirected", "escalated"]);
const VERDICTS: Verdict[] = ["agree", "concern", "would_change"];

interface Job {
  key: string;
  agent: AgentName;
  point: Point;
  listingId: string;
  shareId?: string;
  /** What set it off, when the facts alone don't say (a delay, something the watcher saw). */
  note?: string;
  /** The last few of those, when a burst of them merged into one look. */
  notes?: string[];
  queuedAt?: number;
}

interface Context {
  about: string;
  facts: Record<string, unknown>;
  tools: Tool[];
}

type Outcome = { ok: boolean; note: string };

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

export interface ReasonerOptions {
  rt: Runtime;
  llm: Llm;
  now?: () => number;
  /** How long a burst of hand-offs for one case settles before the model looks. */
  debounceMs?: number;
  watchMs?: number;
}

export function createReasoner({ rt, llm, now = Date.now, debounceMs = 1500, watchMs = 30_000 }: ReasonerOptions) {
  const { store } = rt;
  const pending = new Map<string, { job: Job; timer: NodeJS.Timeout }>();
  const queue: Job[] = [];
  const running = new Set<string>();
  const again = new Map<string, Job>();
  let active = 0;
  const MAX_ACTIVE = 2;
  /** Guardrail memory: last flag per case, last nudge per share, cases already told "nobody can take it". */
  const flagged = new Map<string, number>();
  const nudged = new Map<string, number>();
  const noneSeen = new Set<string>();
  /** Watcher memory: where each partner was last seen and since when; what was already noticed. */
  const seenAt = new Map<string, { key: string; since: number }>();
  const noticed = new Map<string, number>();

  /* ---------- scheduling ---------- */

  function schedule(job: Omit<Job, "key">) {
    const key = [job.listingId, job.agent, job.point, job.shareId ?? ""].join(":");
    const prev = pending.get(key);
    if (prev) clearTimeout(prev.timer);
    const notes = [...new Set([...(prev?.job.notes ?? []), ...(job.note ? [job.note] : [])])].slice(-3);
    const merged: Job = { ...job, key, notes, note: notes.join(" Then: ") || undefined };
    const timer = setTimeout(() => {
      pending.delete(key);
      enqueue(merged);
    }, debounceMs);
    timer.unref?.();
    pending.set(key, { job: merged, timer });
  }

  function enqueue(job: Job) {
    if (running.has(job.key)) return void again.set(job.key, job);
    queue.push({ ...job, queuedAt: now() });
    pump();
  }

  function pump() {
    while (active < MAX_ACTIVE && queue.length) {
      const job = queue.shift()!;
      if (now() - (job.queuedAt ?? now()) > 2 * MIN) continue; // stale: the case has moved on
      active++;
      running.add(job.key);
      void run(job)
        .catch((err) => console.error("luna reasoning", err))
        .finally(() => {
          active--;
          running.delete(job.key);
          const next = again.get(job.key);
          if (next) {
            again.delete(job.key);
            queue.push({ ...next, queuedAt: now() });
          }
          pump();
        });
    }
  }

  /** Which agent's reasoning looks at a hand-off, and at what. */
  function onEvent(e: TraceEvent) {
    // The Decision Agent also handles trouble it sees itself (a partner running late, a reassignment), not
    // only what Logistics reports; a burst of these merges into one look. Never its own flags.
    if (e.type === "decision" && e.listingId && !e.byReasoning && TROUBLE.has(e.kind))
      return schedule({ listingId: e.listingId, shareId: e.shareId, agent: "decision", point: "problem", note: e.reason });
    if (e.type !== "handoff" || !e.listingId) return;
    const base = { listingId: e.listingId, shareId: e.shareId };
    if (e.from === "food") return schedule({ ...base, agent: "food", point: "intake" });
    if (e.from === "ngo" && e.to === "decision" && e.event === "planned") return schedule({ ...base, agent: "ngo", point: "plan" });
    // A first "nobody can take it" is a problem worth a look; the re-tries every 90 s after it are not.
    if (e.from === "ngo" && e.event === "none" && !noneSeen.has(e.listingId)) {
      noneSeen.add(e.listingId);
      return schedule({ ...base, agent: "decision", point: "problem", note: e.task });
    }
    if (e.from !== "logistics" || !e.event) return;
    if (e.event === "ngo_passed") return schedule({ listingId: e.listingId, agent: "ngo", point: "plan" });
    if (e.event === "partner_assigned") return schedule({ ...base, agent: "logistics", point: "partner" });
    if (PROBLEMS.has(e.event)) return schedule({ ...base, agent: "decision", point: "problem", note: e.task });
    if (e.event === "delivered") return schedule({ listingId: e.listingId, agent: "decision", point: "debrief" });
  }

  /* ---------- one look ---------- */

  async function run(job: Job) {
    const ctx = await contextFor(job);
    if (!ctx) return;
    const t: Thought = { id: rt.id("t"), at: now(), agent: job.agent, point: job.point, listingId: job.listingId, shareId: job.shareId, about: ctx.about, status: "thinking" };
    trace.thought(t);
    const a = await llm.ask(job.point === "watch" ? "watch" : "reason", systemPrompt(job.agent), userPrompt(job.point, ctx.facts, ctx.tools));
    let done: Thought;
    if (!a.ok) {
      const skipped = /budget|No reasoning model/.test(a.error);
      done = { ...t, status: skipped ? "skipped" : "failed", error: a.error, ms: a.ms, doneAt: now() };
    } else {
      const j = a.json;
      const verdict = VERDICTS.includes(j.verdict as Verdict) ? (j.verdict as Verdict) : "agree";
      const reasoning = (Array.isArray(j.reasoning) ? j.reasoning : []).map((r) => text(r, 320)).filter((r): r is string => !!r).slice(0, 4);
      const confidence = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : undefined;
      const answered: Thought = {
        ...t,
        verdict,
        headline: text(j.headline, 140),
        reasoning,
        alternative: text(j.alternative, 320),
        confidence,
        model: a.model,
        ms: a.ms,
        tokens: a.tokens,
      };
      const actions = await act(answered, Array.isArray(j.actions) ? j.actions : [], new Set(ctx.tools));
      done = { ...answered, actions, status: "done", doneAt: now() };
    }
    await store.put("thought", done);
    trace.thought(done);
  }

  async function contextFor(job: Job): Promise<Context | null> {
    const l = await store.get("listing", job.listingId);
    if (!l) return null;
    const t = now();
    const names = await namesOf(store);
    const shares = await store.list("share", { listingId: l.id });
    const share = job.shareId ? shares.find((s) => s.id === job.shareId) : undefined;
    const food = foodFacts(l, t);
    const servings = l.items.reduce((n, i) => n + i.servings, 0);

    switch (job.point) {
      case "intake":
        return { about: `Food Passport for ${l.donorName}: ${servings} servings, ${l.items.length} item${l.items.length > 1 ? "s" : ""}`, facts: { food }, tools: ["flag_for_admin"] };

      case "plan": {
        const open = shares.filter((s) => s.status === "offering" || s.status === "finding_partner");
        if (!open.length) return null;
        const ngoIds = new Set(open.flatMap((s) => [s.ngoId, ...s.candidates.map((c) => c.ngoId)]).filter((x): x is string => !!x));
        const arrive = new Map(open.flatMap((s) => s.candidates.map((c) => [c.ngoId, c.arriveBy] as const)));
        const ngos = [];
        for (const id of ngoIds) {
          const r = await store.get("recipient", id);
          if (r) ngos.push(await ngoFacts(store, r, l, t, arrive.get(id)));
        }
        const { filteredOut, log } = await ruleLog(store, l.id);
        const first = open.map((s) => names.get(s.ngoId ?? "") ?? "an NGO").join(", ");
        const backups = open.some((s) => s.candidates.filter((c) => c.ngoId !== s.ngoId && !s.triedNgoIds.includes(c.ngoId)).length > 1);
        return {
          about: `${open.length} share${open.length > 1 ? "s" : ""}: offered to ${first} first`,
          facts: { food, shares: open.map((s) => shareFacts(s, l, names, t)), ngos, filteredOut, ruleLog: log },
          tools: backups ? ["reorder_backups", "flag_for_admin"] : ["flag_for_admin"],
        };
      }

      case "partner": {
        if (!share?.partnerId) return null;
        const p = await store.get("partner", share.partnerId);
        const ngo = share.ngoId ? await store.get("recipient", share.ngoId) : null;
        if (!p || !ngo) return null;
        // Only partners the rules could have asked: independents, this NGO's riders, other NGOs' riders who help others.
        const others = usable(await store.list("partner"))
          .filter((x) => x.online && x.id !== p.id && !x.activeShareId && !x.manual && (!x.ngoId || x.ngoId === ngo.id || x.helpsOthers))
          .map((x) => partnerFacts(x, l, names))
          .sort((a, b) => a.kmFromPickup - b.kmFromPickup)
          .slice(0, 3);
        return {
          about: `${p.name} to collect for ${ngo.name}`,
          facts: { food, share: shareFacts(share, l, names, t), ngo: await ngoFacts(store, ngo, l, t, share.promisedArrival), partner: partnerFacts(p, l, names), otherPartnersOnline: others, ruleLog: (await ruleLog(store, l.id, 8)).log },
          tools: ["flag_for_admin"],
        };
      }

      case "problem":
      case "watch": {
        const p = share?.partnerId ? await store.get("partner", share.partnerId) : null;
        const ngo = share?.ngoId ? await store.get("recipient", share.ngoId) : null;
        const tools: Tool[] = ["flag_for_admin"];
        if (share && p && ON_TRIP.has(share.status)) tools.push("nudge_partner");
        return {
          about: job.note ?? "Something went off plan",
          facts: {
            whatHappened: job.note,
            food,
            share: share ? shareFacts(share, l, names, t) : undefined,
            ngo: ngo ? await ngoFacts(store, ngo, l, t, share?.promisedArrival) : undefined,
            partner: p ? partnerFacts(p, l, names) : undefined,
            otherShares: shares.filter((s) => s.id !== share?.id).map((s) => shareFacts(s, l, names, t)),
            ruleLog: (await ruleLog(store, l.id)).log,
          },
          tools,
        };
      }

      case "meals":
        return null; // asked before the case opens: pairMeals

      case "debrief": {
        if (l.status !== "closed") return null; // another share is still on its way
        if ((await store.list("thought", { listingId: l.id, point: "debrief" })).length) return null;
        const delivered = shares.filter((s) => s.status === "delivered");
        return {
          about: `Case closed for ${l.donorName}: ${delivered.reduce((n, s) => n + s.lines.reduce((m, ln) => m + ln.servings, 0), 0)} servings delivered`,
          facts: { food, shares: shares.map((s) => ({ ...shareFacts(s, l, names, t), feedback: s.feedback })), unplacedServings: l.unplacedServings, ruleLog: (await ruleLog(store, l.id, 24)).log },
          tools: [],
        };
      }
    }
  }

  /* ---------- guarded actions ---------- */

  async function act(t: Thought, raw: unknown[], allowed: Set<Tool>): Promise<ActionRecord[]> {
    const out: ActionRecord[] = [];
    for (const r of raw.slice(0, 3)) {
      const { tool: rawTool, ...args } = (r && typeof r === "object" ? r : {}) as Record<string, unknown>;
      const tool = String(rawTool ?? "");
      if (!allowed.has(tool as Tool)) {
        out.push({ tool, args, status: "blocked", note: "Not one of the tools allowed at this step." });
        continue;
      }
      const res = await rt.serial(() => TOOLS[tool as Tool](t, args));
      out.push({ tool, args, status: res.ok ? "done" : "blocked", note: res.note });
    }
    return out;
  }

  const blocked = (note: string): Outcome => ({ ok: false, note });
  const done = (note: string): Outcome => ({ ok: true, note });

  const TOOLS: Record<Tool, (t: Thought, args: Record<string, unknown>) => Promise<Outcome>> = {
    /** Only before the case opens (pairMeals); once food is offered, its meals are fixed. */
    async pair_meals() {
      return blocked("Meals are paired before the case opens; this food is already on offer.");
    },

    /** Only NGOs the rules already approved as backups for this share can move; the offer already out stays. */
    async reorder_backups(t, args) {
      const s = await store.get("share", String(args.shareId ?? ""));
      if (!s || s.listingId !== t.listingId) return blocked("That share isn't part of this case.");
      if (s.status !== "offering" && s.status !== "finding_partner") return blocked("This share has already moved past choosing an NGO.");
      const fixed = s.candidates.filter((c) => c.ngoId === s.ngoId || s.triedNgoIds.includes(c.ngoId));
      const untried = s.candidates.filter((c) => !fixed.includes(c));
      const order = [...new Set(Array.isArray(args.order) ? args.order.map(String) : [])];
      const names = await namesOf(store);
      const stranger = order.find((id) => !untried.some((c) => c.ngoId === id));
      if (stranger) return blocked(`${names.get(stranger) ?? stranger} isn't one of the backups the rules approved for this food, so it can't be moved up.`);
      const moved = [...order.map((id) => untried.find((c) => c.ngoId === id)!), ...untried.filter((c) => !order.includes(c.ngoId))];
      if (moved.every((c, i) => c.ngoId === untried[i].ngoId)) return done("The backups were already in that order.");
      await store.put("share", { ...s, candidates: [...fixed, ...moved] });
      return done(`If ${names.get(s.ngoId ?? "") ?? "the current NGO"} passes, the food goes next to ${moved.map((c) => names.get(c.ngoId) ?? c.ngoId).join(", then ")}.`);
    },

    async flag_for_admin(t, args) {
      const reason = text(args.reason, 240);
      if (!reason) return blocked("A flag needs a reason.");
      if (now() - (flagged.get(t.listingId!) ?? 0) < 10 * MIN) return blocked("This case was flagged a few minutes ago; one flag at a time.");
      flagged.set(t.listingId!, now());
      await rt.decide(t.agent, now(), "escalated", t.listingId!, `Reasoning flagged this for a person: ${reason}`, t.listingId, { thoughtId: t.id });
      return done("Flagged for the Luna team.");
    },

    async nudge_partner(t, args) {
      const s = await store.get("share", String(args.shareId ?? t.shareId ?? ""));
      if (!s || s.listingId !== t.listingId) return blocked("That share isn't part of this case.");
      if (!ON_TRIP.has(s.status) || !s.partnerId) return blocked("Nobody is on a trip for this share right now.");
      const words = text(args.text, 200);
      if (!words) return blocked("A nudge needs a message.");
      if (now() - (nudged.get(s.id) ?? 0) < 10 * MIN) return blocked("This partner was nudged a few minutes ago.");
      const p = await store.get("partner", s.partnerId);
      if (!p) return blocked("The partner isn't on record any more.");
      nudged.set(s.id, now());
      await rt.send(now(), p.phone, `partner:${p.id}`, msg.text(words), s.listingId);
      return done(`Sent ${p.name}: "${words}"`);
    },
  };

  /* ---------- meal pairing, before the case opens ---------- */

  /**
   * The Food Agent's reasoning on which staple goes with which side (spec §7.5). It runs when the listing is
   * handed over, outside the agents' queue, within `budgetMs`; when there's no real choice, no model, or no
   * answer in time, the rules' pairing goes ahead. Its advice is checked like any action: pairs must name this
   * listing's staples and sides, and the rules do every count. `finish` records the thought once the case has an id.
   */
  async function pairMeals(donorName: string, items: Item[], budgetMs = 3500, listingKey?: string) {
    if (!llm.enabled || !pairingIsAChoice(items)) return null;
    const byId = new Map(items.map((i) => [i.id, i]));
    const staples = items.filter((i) => roleOf(i) === "staple");
    const sides = items.filter((i) => roleOf(i) === "side");
    const label = (i: Item) => i.name ?? "food";
    const describe = (order: Pairing[], skip: Pairing[] = []) => {
      const plan = assembleMeals(items, order, skip);
      const made = plan.bundles.map((b) => `${b.servings} × ${label(byId.get(b.staple)!)} with ${label(byId.get(b.side)!).toLowerCase()}`).join(", ");
      return { plan, line: `${made || "no meals"}: ${plan.meals} meals${plan.addons ? `, ${plan.addons} servings left as add-ons` : ""}` };
    };
    const rules = rulePairs(items);
    const ruled = describe(rules);
    const t: Thought = {
      id: rt.id("t"),
      at: now(),
      agent: "food",
      point: "meals",
      listingId: listingKey,
      about: `Pairing ${staples.map(label).join(", ")} with ${sides.map(label).join(", ")} for ${donorName}`,
      status: "thinking",
    };
    trace.thought(t);
    const food = (i: Item) => ({ id: i.id, name: label(i), servings: i.servings, diet: i.diet, allergens: i.allergens });
    const facts = { restaurant: donorName, staples: staples.map(food), sides: sides.map(food), rulesPairing: ruled.line };
    const late = new Promise<"late">((r) => setTimeout(() => r("late"), budgetMs).unref?.());
    const a = await Promise.race([llm.ask("reason", systemPrompt("food"), userPrompt("meals", facts, ["pair_meals"])), late]);

    let done: Thought;
    let advice: { order: Pairing[]; skip: Pairing[] } | null = null;
    if (a === "late") done = { ...t, status: "skipped", error: `No answer within ${budgetMs / 1000} s, so the rules' pairing went ahead: ${ruled.line}.`, doneAt: now() };
    else if (!a.ok) done = { ...t, status: /budget|No reasoning model/.test(a.error) ? "skipped" : "failed", error: a.error, ms: a.ms, doneAt: now() };
    else {
      const j = a.json;
      const asPair = (x: unknown): Pairing | null => {
        const [s, d] = Array.isArray(x) ? x : x && typeof x === "object" ? [(x as Record<string, unknown>).staple, (x as Record<string, unknown>).side] : [];
        return typeof s === "string" && typeof d === "string" && roleOf(byId.get(s) ?? ({} as Item)) === "staple" && byId.has(s) && byId.has(d) && roleOf(byId.get(d)!) === "side" ? [s, d] : null;
      };
      const tool = (Array.isArray(j.actions) ? j.actions : []).find((x) => (x as Record<string, unknown>)?.tool === "pair_meals") as Record<string, unknown> | undefined;
      const rawPairs = Array.isArray(tool?.pairs) ? tool.pairs : [];
      const rawSkip = Array.isArray(tool?.skip) ? tool.skip : [];
      const pairs = rawPairs.map(asPair).filter((p): p is Pairing => !!p);
      const skip = rawSkip.map(asPair).filter((p): p is Pairing => !!p);
      const actions: ActionRecord[] = [];
      if (tool) {
        const strays = rawPairs.length + rawSkip.length - pairs.length - skip.length;
        if (!pairs.length && !skip.length && strays)
          actions.push({ tool: "pair_meals", args: { pairs: rawPairs, skip: rawSkip }, status: "blocked", note: "Only this listing's own staples and sides can be paired, so the rules' pairing stands." });
        else {
          advice = { order: pairs, skip };
          const chosen = describe([...pairs, ...rules], skip);
          const changed = chosen.line !== ruled.line;
          actions.push({
            tool: "pair_meals",
            args: { pairs, skip },
            status: "done",
            note: `${chosen.line}.${changed ? ` The rules alone would have made ${ruled.line}.` : ""}${strays ? ` ${strays} suggested pair${strays > 1 ? "s" : ""} named food that isn't a staple or side here and ${strays > 1 ? "were" : "was"} ignored.` : ""}`,
          });
        }
      }
      done = {
        ...t,
        status: "done",
        verdict: VERDICTS.includes(j.verdict as Verdict) ? (j.verdict as Verdict) : "agree",
        headline: text(j.headline, 140),
        reasoning: (Array.isArray(j.reasoning) ? j.reasoning : []).map((r) => text(r, 320)).filter((r): r is string => !!r).slice(0, 4),
        alternative: text(j.alternative, 320),
        confidence: typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : undefined,
        actions,
        model: a.model,
        ms: a.ms,
        tokens: a.tokens,
        doneAt: now(),
      };
    }
    return {
      advice,
      async finish(listingId?: string) {
        const final = { ...done, listingId };
        await store.put("thought", final);
        trace.thought(final);
      },
    };
  }

  /* ---------- the 30-second watcher ---------- */

  /** Cheap rules for silence and drift; the model is only asked about what they find. */
  function drift(l: Listing, s: Share, names: Map<string, string>, t: number): [string, string][] {
    const out: [string, string][] = [];
    const food = foodOf(l, s.lines);
    const partner = names.get(s.partnerId ?? "") ?? "The partner";
    const ngo = names.get(s.ngoId ?? "") ?? "The NGO";
    if (ON_TRIP.has(s.status)) {
      if (s.lastPos) {
        const key = `${s.lastPos.lat.toFixed(4)},${s.lastPos.lng.toFixed(4)}`;
        const seen = seenAt.get(s.id);
        if (!seen || seen.key !== key) seenAt.set(s.id, { key, since: t });
        else if (t - seen.since >= 4 * MIN) out.push(["stalled", `${partner} hasn't moved for ${Math.round((t - seen.since) / MIN)} min while carrying ${food} for ${ngo}.`]);
      } else if (s.assignedAt && t - s.assignedAt >= 6 * MIN) out.push(["no_signal", `${partner} accepted ${food} ${Math.round((t - s.assignedAt) / MIN)} min ago and hasn't shared a location since.`]);
    }
    if (s.status === "finding_partner" && s.waitingForPartnerSince && t - s.waitingForPartnerSince >= 4 * MIN)
      out.push(["no_partner", `${ngo} accepted ${food} ${Math.round((t - s.waitingForPartnerSince) / MIN)} min ago and no delivery partner is free yet.`]);
    const left = safeUntilOf(l, s.lines) - t;
    if (s.status !== "picked_up" && left > 0 && left < 30 * MIN) out.push(["running_out", `${food} is safe for only ${Math.round(left / MIN)} more min and hasn't been picked up.`]);
    return out;
  }

  async function watch() {
    const t = now();
    const live = (await store.list("listing")).filter((l) => l.status === "matching" || l.status === "matched" || l.status === "partially_matched");
    const names = live.length ? await namesOf(store) : new Map<string, string>();
    const seen: string[] = [];
    let shares = 0;
    for (const l of live)
      for (const s of await store.list("share", { listingId: l.id })) {
        if (!LIVE.has(s.status)) continue;
        shares++;
        for (const [kind, what] of drift(l, s, names, t)) {
          const key = `${s.id}:${kind}`;
          if (t - (noticed.get(key) ?? 0) < 10 * MIN) continue;
          noticed.set(key, t);
          seen.push(what);
          schedule({ agent: "decision", point: "watch", listingId: l.id, shareId: s.id, note: what });
        }
      }
    for (const [k, at] of noticed) if (t - at > 60 * MIN) noticed.delete(k);
    trace.pulse({ at: t, live: live.length, shares, noticed: seen });
  }

  return {
    start() {
      const off = trace.on(onEvent);
      const timer = setInterval(() => void watch().catch((err) => console.error("luna watcher", err)), watchMs);
      timer.unref();
      return () => {
        off();
        clearInterval(timer);
        for (const p of pending.values()) clearTimeout(p.timer);
      };
    },
    pairMeals,
    /** For tests: run the watcher once now. */
    watch,
    /** Resolves once nothing is waiting, queued or thinking. */
    async settled() {
      while (pending.size || queue.length || active) await new Promise((r) => setTimeout(r, 10));
    },
    status() {
      return { ...llm.status(), watchEveryMs: watchMs, thinking: active, queued: queue.length + pending.size };
    },
  };
}

export type Reasoner = ReturnType<typeof createReasoner>;
