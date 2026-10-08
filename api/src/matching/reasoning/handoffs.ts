/**
 * Hand-offs between the agents, for the trace. The agents call each other directly (luna.ts wires them);
 * these wrappers only report each call and what came back, so the agents themselves don't change.
 */
import type { LogisticsAgent, LogisticsEvent } from "../logistics-agent.ts";
import type { NgoAgent } from "../ngo-agent.ts";
import { servingsOf } from "../runtime.ts";
import type { MatchingStore } from "../store.ts";
import { trace } from "./trace.ts";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function tracedNgoAgent(ngo: NgoAgent): NgoAgent {
  return {
    ...ngo,
    async planShares(l, items, now, opts) {
      const asked = items.reduce((n, i) => n + i.servings, 0);
      trace.handoff({ at: now, from: "decision", to: "ngo", task: `Find NGOs for ${asked} servings`, listingId: l.id });
      const plan = await ngo.planShares(l, items, now, opts);
      const placed = plan.shares.reduce((n, s) => n + servingsOf(s.lines), 0);
      const left = servingsOf(plan.unallocated);
      trace.handoff({
        at: now,
        from: "ngo",
        to: "decision",
        event: plan.shares.length ? "planned" : "none",
        task: plan.shares.length
          ? `${plural(plan.shares.length, "share")}, ${placed} servings placed${left ? `; ${left} have nowhere safe to go` : ""}`
          : `No NGO can safely take ${asked} servings right now`,
        listingId: l.id,
      });
      return plan;
    },
    async findRedirect(l, lines, origin, exclude, now) {
      trace.handoff({ at: now, from: "decision", to: "ngo", task: "Find a closer NGO from where the partner is", listingId: l.id });
      const best = await ngo.findRedirect(l, lines, origin, exclude, now);
      trace.handoff({ at: now, from: "ngo", to: "decision", event: "redirect_option", task: best ? "Found a closer NGO that can take it" : "No closer NGO can take it", listingId: l.id });
      return best;
    },
  };
}

/** Only the Decision Agent's view of Logistics is wrapped: the start of each share. */
export function tracedLogisticsAgent(logistics: LogisticsAgent, store: MatchingStore): LogisticsAgent {
  return {
    ...logistics,
    async startShare(l, plan, now) {
      const first = plan.candidates[0] ? await store.get("recipient", plan.candidates[0].ngoId) : null;
      trace.handoff({ at: now, from: "decision", to: "logistics", task: `Run ${servingsOf(plan.lines)} servings, ${first?.name ?? "the first NGO"} first`, listingId: l.id });
      return logistics.startShare(l, plan, now);
    },
  };
}

function describe(e: LogisticsEvent): string | null {
  switch (e.type) {
    case "offered": return `Offered to ${e.ngo.name}, ${e.minutes} min to reply`;
    case "ngo_accepted": return `${e.ngo.name} accepted`;
    case "ngo_passed": return `${e.ngo.name} ${e.how === "declined" ? "declined" : "didn't reply in time"}`;
    case "partner_asked": return `Asked ${e.partner.name} to collect`;
    case "partner_waiting": return `No partner free yet for ${e.ngo.name}`;
    case "partner_exhausted": return `No partner could collect for ${e.ngo.name}`;
    case "partner_assigned": return `${e.partner.name} is collecting for ${e.ngo.name}`;
    case "picked_up": return `${e.partner.name} picked it up`;
    case "delivered": return `Delivered to ${e.ngo.name}`;
    case "unplaced": return "Every NGO lined up passed";
    case "late_reported": return `${e.partner.name} says they're running about ${e.minutes} min late`;
    case "behind_schedule": return `Running behind for ${e.ngo.name}`;
    case "unsafe_delay": return "This delay would make the food unsafe by serving time";
    case "redirect_failed": return "Couldn't redirect to a closer NGO";
    case "redirected": return `Redirected from ${e.from.name} to ${e.to.name}`;
    case "stuck": return `Stuck: ${e.reason}`;
    case "eta": return null; // a routine position update every minute: not a hand-off worth drawing
    default: return (e as { type: string }).type.replace(/_/g, " ");
  }
}

/** Logistics reporting to the Decision Agent. */
export function traceLogisticsEvent(e: LogisticsEvent, now: number) {
  const task = describe(e);
  if (task) trace.handoff({ at: now, from: "logistics", to: "decision", event: e.type, task, listingId: e.share.listingId, shareId: e.share.id });
}
