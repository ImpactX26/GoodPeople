import { TRIP_CONFIG as C } from "./config.ts";
import { distance, validPoint } from "./geo.ts";
import { hashCode, newCode, revealCode } from "./codes.ts";
import type { Session } from "../store.ts";
import type { DeliveryTrip, PickupCheck, RedirectInput, TripInput, TripPoint, TripView } from "./types.ts";

export const pickupStage = (t: DeliveryTrip) => ["assigned", "to_pickup", "at_pickup"].includes(t.status);
export function event(t: DeliveryTrip, type: string, reason: string, now: number, once = false) {
  if (once && t.events.some(e => e.type === type)) return;
  const seq = (t.events.at(-1)?.seq ?? 0) + 1;
  t.events.push({ eventId: `evt_${t.id}_${seq}`, seq, type, at: now, reason });
  t.events = t.events.slice(-C.maxEvents);
}
export function createTrip(input: TripInput, id: string, now: number, sample = false, shareAccepted = true): DeliveryTrip {
  const pickup = newCode(), drop = newCode(revealCode(pickup.seal));
  const t: DeliveryTrip = { ...input, id, sample, version: 1, routeRevision: 1, routeChangedAt: now, heldFrom: null, shareAcceptedAt: shareAccepted ? now : null, requestStatus: input.partnerPhone && shareAccepted ? "pending" : "finding_partner", status: "assigned", createdAt: now,
    acceptedAt: null, pickedUpAt: null, closedAt: null, location: null, eta: null, distanceM: 0,
    stationarySince: null, stationaryAnchor: null, events: [], codes: { pickup, drop }, pickupCheck: null, receipts: {} };
  if (shareAccepted) event(t, "share.accepted", `${input.drop.name} accepted the restaurant listing. Finding a delivery partner.`, now);
  return t;
}
export function canView(t: DeliveryTrip, s: Session) {
  return s.role === "admin" || s.role === "donor" && s.phone === t.donorPhone || s.role === "ngo" && s.phone === t.ngoPhone || s.role === "volunteer" && !!t.shareAcceptedAt && (t.requestStatus === "pending" && !!t.candidatePhones?.includes(s.phone) || s.phone === t.partnerPhone && t.requestStatus !== "finding_partner");
}
export function locationVisible(t: DeliveryTrip, s: Session, now: number) {
  if (!canView(t, s) || t.requestStatus !== "accepted" || t.closedAt) return false;
  return s.role !== "donor" || !t.pickedUpAt || now <= t.pickedUpAt + C.donorTrackAfterPickupMs;
}
/** Projection is the only way private trip records leave the API, including over SSE. */
export function present(t: DeliveryTrip, s: Session, now: number): TripView {
  if (!canView(t, s)) throw new Error("Delivery not found.");
  const visible = locationVisible(t, s, now);
  const addresses = !!t.shareAcceptedAt && (s.role !== "volunteer" || t.requestStatus === "accepted") && (!t.closedAt || now <= t.closedAt + C.contactAfterCloseMs);
  const v: TripView = {
    id: t.id, listingId: t.listingId, sample: t.sample, version: t.version, routeRevision: t.routeRevision ?? 1, requestStatus: t.requestStatus,
    status: t.status, shareAcceptedAt: t.shareAcceptedAt, partnerName: t.partnerName, vehicle: t.vehicle,
    pickup: addresses ? t.pickup : null, drop: addresses ? t.drop : null, pickupArea: t.pickup.area, dropArea: t.drop.area,
    food: t.food, servings: t.servings, grade: t.grade, unsure: t.unsure, safeUntil: t.safeUntil,
    collectBy: t.collectBy, containers: t.containers, partnerBringsContainers: t.partnerBringsContainers,
    requestDeadline: t.requestDeadline, location: visible ? t.location : null, locationVisible: visible,
    eta: t.eta, pickedUpAt: t.pickedUpAt, closedAt: t.closedAt, events: t.events,
    route: null, routeError: null, receipt: t.receipt ?? null,
  };
  if (t.requestStatus === "accepted" && !t.closedAt) {
    if (s.role === "donor" && ["at_pickup", "held"].includes(t.status) && !t.pickedUpAt)
      v.code = { kind: "pickup", value: revealCode(t.codes.pickup.seal) };
    if (s.role === "ngo" && ["at_drop", "held"].includes(t.status) && t.pickedUpAt)
      v.code = { kind: "drop", value: revealCode(t.codes.drop.seal) };
    if (s.role === "volunteer") v.offlineCodes = {
      pickup: { salt: t.codes.pickup.salt, hash: t.codes.pickup.hash }, drop: { salt: t.codes.drop.salt, hash: t.codes.drop.hash },
    };
  }
  return v;
}
export function assertPartner(t: DeliveryTrip, s: Session) {
  if (s.role !== "volunteer" || s.phone !== t.partnerPhone) throw new Error("Only the assigned delivery partner can do this.");
}
export function assertCandidate(t: DeliveryTrip, s: Session) {
  if (s.role !== "volunteer" || t.requestStatus !== "pending" || !(t.partnerPhone === s.phone || t.candidatePhones?.includes(s.phone))) throw new Error("This pickup is no longer available to you.");
}
export function assertActive(t: DeliveryTrip, now: number) {
  if (t.requestStatus !== "accepted" || t.closedAt) throw new Error("This delivery is not active.");
  if (t.safeUntil <= now) throw new Error("This food has passed its safe-until time. Stop and contact the Luna team.");
  if (t.status === "held") throw new Error("This delivery needs a Luna team review before continuing.");
}
export function accept(t: DeliveryTrip, hasContainers: boolean, now: number) {
  if (!t.shareAcceptedAt || !t.partnerPhone) throw new Error("The NGO must accept this share and a partner must be selected first.");
  if (t.requestStatus !== "pending") throw new Error("This request has already been answered.");
  if (now > t.requestDeadline || now >= t.collectBy || now >= t.safeUntil) throw new Error("This pickup request has expired.");
  if (t.partnerBringsContainers && !hasContainers) throw new Error("Confirm you have the containers before accepting.");
  t.requestStatus = "accepted"; t.acceptedAt = now;
  const pickup = newCode(); t.codes = { pickup, drop: newCode(revealCode(pickup.seal)) };
  t.candidatePhones = [];
  event(t, "partner.assigned", `${t.partnerName} is collecting the food. The next step is pickup.`, now);
  t.status = "to_pickup";
}

export function acceptShare(t: DeliveryTrip, now: number) {
  if (t.shareAcceptedAt || t.closedAt) throw new Error("This listing has already been accepted.");
  if (now >= t.collectBy || now >= t.safeUntil) throw new Error("This listing has expired.");
  t.shareAcceptedAt = now;
  if (t.offer) t.offer.status = "accepted";
  t.requestStatus = "finding_partner";
  event(t, "share.accepted", `${t.drop.name} accepted the restaurant listing. Finding a delivery partner.`, now);
}

export function assignPartner(t: DeliveryTrip, phone: string, name: string, vehicle: TripInput["vehicle"], now: number) {
  if (!t.shareAcceptedAt || t.closedAt || !["finding_partner", "declined"].includes(t.requestStatus)) throw new Error("This share is not waiting for a delivery partner.");
  if (now >= t.collectBy || now >= t.safeUntil) throw new Error("This pickup has expired.");
  t.partnerPhone = phone; t.partnerName = name; t.vehicle = vehicle;
  t.requestDeadline = Math.min(now + C.requestWindowMs, t.collectBy); t.requestStatus = "pending";
  event(t, "partner.requested", `A pickup request was sent to ${name}. Waiting for acceptance.`, now);
}
/** The Logistics Agent sends the same request to the entire eligible NGO wave automatically. */
export function requestPartners(t: DeliveryTrip, candidates: { phone: string; name: string }[], now: number) {
  if (!t.shareAcceptedAt || t.closedAt || !(["finding_partner", "declined"].includes(t.requestStatus) || t.requestStatus === "pending" && now >= t.requestDeadline)) throw new Error("This share is not searching for volunteers.");
  if (!candidates.length || candidates.length > C.partnerWaveSize || new Set(candidates.map(p => p.phone)).size !== candidates.length) throw new Error("Choose a wave of up to three distinct eligible volunteers.");
  if (now >= t.collectBy || now >= t.safeUntil) throw new Error("This pickup has expired.");
  t.partnerPhone = null; t.partnerName = "Waiting for a volunteer"; t.candidatePhones = candidates.map(p => p.phone);
  t.requestDeadline = Math.min(now + (t.safeUntil - now < 2 * 60 * 60_000 ? 2 * 60_000 : C.requestWindowMs), t.collectBy); t.requestStatus = "pending";
  event(t, "partner.requested", `Pickup notifications sent automatically to ${candidates.map(p => p.name).join(", ")}. The first to accept will collect the food.`, now);
}
export function arrive(t: DeliveryTrip, kind: "pickup" | "drop", now: number) {
  assertActive(t, now);
  const from = kind === "pickup" ? "to_pickup" : "to_drop", to = kind === "pickup" ? "at_pickup" : "at_drop";
  if (t.status === to) return;
  if (t.status !== from) throw new Error("Finish the previous delivery step first.");
  t.status = to;
  event(t, `partner.arrived_${kind}`, `${t.partnerName} has arrived. Ask for the ${kind} code.`, now, true);
}
export function verifyCode(t: DeliveryTrip, kind: "pickup" | "drop", code: string, point: TripPoint | null, now: number): string | null {
  if (t.requestStatus !== "accepted" || t.closedAt) throw new Error("This delivery is not active.");
  const c = t.codes[kind];
  if (t.status === "held" || c.lockedUntil > now) throw new Error("Code entry is locked. Contact the Luna team for a review.");
  if (t.status !== (kind === "pickup" ? "at_pickup" : "at_drop")) throw new Error("Mark your arrival before entering the code.");
  assertActive(t, now);
  if (point && (!validPoint(point) || now - point.at > C.staleMs || point.at > now + C.futureToleranceMs || point.accuracyM > C.maxAccuracyM))
    throw new Error("Wait for a fresh, accurate location before entering the code.");
  if (point && distance(point, t[kind]) > C.codeGeofenceM) throw new Error("Enter the code within 300 metres of the handover point.");
  if (!/^\d{4}$/.test(code)) throw new Error("Enter the 4-digit handover code.");
  if (hashCode(c.salt, code) !== c.hash) {
    c.tries++;
    event(t, kind === "pickup" ? "pickup.code_failed" : "delivery.code_failed", "The handover code did not match.", now);
    if (c.tries >= C.codeTries) {
      c.lockedUntil = now + C.codeLockMs; t.heldFrom = t.status; t.status = "held";
      event(t, "escalation.opened", "Three incorrect codes. This delivery is held for a Luna team review.", now);
    }
    return c.tries >= C.codeTries ? "Code locked. Contact the Luna team." : `Incorrect code. ${C.codeTries - c.tries} tries left.`;
  }
  if (!point) event(t, "handover.no_gps", "The code was verified without GPS and needs a review.", now);
  if (kind === "pickup") { t.status = "picked_up"; t.pickedUpAt = now; t.eta = null; }
  else { t.status = "delivered"; t.closedAt = now; t.eta = now; }
  event(t, kind === "pickup" ? "pickup.verified" : "delivery.verified",
    kind === "pickup" ? "Pickup confirmed. Complete the food check before heading to the NGO." : `Delivered to ${t.drop.name}. ${t.servings} servings. Thank you!`, now);
  return null;
}
export function pickupCheck(t: DeliveryTrip, check: PickupCheck, now: number) {
  assertActive(t, now);
  if (t.status !== "picked_up") throw new Error("Verify the pickup code first.");
  if (!Number.isInteger(check.servings) || check.servings < 0 || check.servings > t.servings) throw new Error("Enter the servings actually received, up to the listed amount.");
  if (typeof check.photo !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(check.photo) || check.photo.length > C.maxPhotoBytes)
    throw new Error("Add a pickup photo under 500 KB.");
  if ([check.smellsNormal, check.noSpoilage, check.temperatureOkay, check.packagingOkay].some(v => typeof v !== "boolean")) throw new Error("Complete the food checklist.");
  t.pickupCheck = check;
  if (!check.servings || !check.smellsNormal || !check.noSpoilage || !check.temperatureOkay || !check.packagingOkay) {
    t.status = "failed_at_pickup"; t.closedAt = now;
    event(t, "pickup.item_rejected", "Do not take this food: it failed the pickup check. The Luna team needs to review it.", now);
    event(t, "escalation.opened", "Food failed the pickup check. The delivery has stopped.", now);
  } else {
    if (check.servings < t.servings) event(t, "pickup.short", `Collected ${check.servings} servings instead of ${t.servings}.`, now);
    t.servings = check.servings; t.status = "to_drop"; t.stationarySince = now; t.stationaryAnchor = t.location;
    event(t, "pickup.check_completed", "Food check complete. Head to the NGO for the drop.", now);
  }
}
/** Returns only accepted raw points. Delayed buffers do not move the live marker backwards. */
export function ingest(t: DeliveryTrip, points: TripPoint[], now: number) {
  if (t.requestStatus !== "accepted" || t.closedAt) return [];
  const accepted: TripPoint[] = [];
  for (const p of [...points].sort((a, b) => a.at - b.at)) {
    if (!validPoint(p) || p.at > now + C.futureToleranceMs || p.at < (t.acceptedAt ?? now) || p.accuracyM > C.maxAccuracyM) continue;
    const last = t.location;
    if (last && p.at <= last.at) continue;
    const d = last ? distance(last, p) : 0, dt = last ? p.at - last.at : 0;
    if (!t.sample && (p.speedMps !== null && p.speedMps > C.maxSpeedMps || last && (dt <= C.jumpWindowMs && d > C.maxJumpM || dt > 0 && d / (dt / 1000) > C.maxSpeedMps))) {
      event(t, "location.flagged", "An unusual location jump was ignored and needs a review.", now, true); continue;
    }
    t.distanceM += d; t.location = p; accepted.push(p);
    if (!t.stationaryAnchor || distance(t.stationaryAnchor, p) > C.stationaryRadiusM) { t.stationaryAnchor = p; t.stationarySince = p.at; }
    if (now - p.at > C.staleMs) continue;
    if (t.safeUntil <= now && t.status !== "held") {
      t.heldFrom = t.status; t.status = "held"; event(t, "escalation.opened", "The food has passed its safe-until time. Stop and contact the Luna team.", now, true); break;
    }
    if (t.status === "to_drop" && t.stationarySince && p.at - t.stationarySince >= C.stationaryMs)
      event(t, "partner.stationary", "The delivery partner has not moved for 10 minutes. Check whether help is needed.", now, true);
    if (["to_pickup", "to_drop"].includes(t.status) && p.at >= (t.routeChangedAt ?? t.createdAt)) {
      const kind = pickupStage(t) ? "pickup" : "drop";
      if (distance(p, t[kind]) <= C.arrivalM && p.accuracyM <= C.arrivalM) arrive(t, kind, now);
    }
  }
  return accepted;
}

export function redirect(t: DeliveryTrip, input: RedirectInput, now: number) {
  assertActive(t, now);
  if (t.status !== "to_drop") throw new Error("Only a delivery on its way to the NGO can be redirected.");
  if (!t.pickedUpAt || input.ngoPhone === t.ngoPhone) throw new Error("Choose a new NGO for this redirect.");
  if (!Number.isFinite(input.etaDrop) || !Number.isFinite(input.serveAt) || input.etaDrop < now || input.serveAt < input.etaDrop || input.serveAt > t.safeUntil)
    throw new Error("The new NGO must be able to serve this food before its safe-until time.");
  if (t.maxTransitMin && input.etaDrop - t.pickedUpAt > t.maxTransitMin * 60_000)
    throw new Error("The new route exceeds the food's transit limit.");
  if (t.grade === "C" && input.serveAt - input.etaDrop > C.gradeCServeMs)
    throw new Error("Grade C food must be served within 60 minutes of arrival.");
  if (!Number.isFinite(input.eligibilityCheckedAt) || input.eligibilityCheckedAt > now + C.futureToleranceMs || now - input.eligibilityCheckedAt > C.eligibilityFreshMs)
    throw new Error("Recheck the new NGO's eligibility before redirecting this delivery.");
  if (!input.reason?.trim() || input.reason.length > C.maxReasonLength) throw new Error("A short reason is required for the redirect.");
  const oldName = t.drop.name;
  t.shareId = input.shareId; t.ngoPhone = input.ngoPhone; t.drop = input.drop;
  const oldCode = revealCode(t.codes.drop.seal);
  t.codes.drop = newCode(oldCode);
  t.routeRevision = (t.routeRevision ?? 1) + 1; t.routeChangedAt = now; t.eta = null;
  t.stationarySince = now; t.stationaryAnchor = t.location;
  event(t, "share.redirected", `Going to ${input.drop.name} instead of ${oldName}: ${input.reason.trim()}`, now);
}

export function resumeHeld(t: DeliveryTrip, reason: string, now: number) {
  if (t.status !== "held" || !t.heldFrom || t.closedAt) throw new Error("This delivery is not waiting for a code review.");
  if (!reason?.trim() || reason.length > C.maxReasonLength) throw new Error("Enter a short reason for resuming this delivery.");
  if (now >= t.safeUntil || t.pickedUpAt && t.maxTransitMin && now - t.pickedUpAt > t.maxTransitMin * 60_000)
    throw new Error("This food can no longer finish within its safety limits.");
  if (Object.values(t.codes).some(c => c.lockedUntil > now)) throw new Error("Wait until the 10-minute code lock has ended before resuming.");
  t.status = t.heldFrom; t.heldFrom = null;
  for (const code of Object.values(t.codes)) { code.tries = 0; code.lockedUntil = 0; }
  event(t, "escalation.resolved", `The Luna team resumed this delivery: ${reason.trim()}`, now);
}
