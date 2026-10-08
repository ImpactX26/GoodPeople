export interface LatLng { lat: number; lng: number }
export interface TripPoint extends LatLng {
  at: number;
  accuracyM: number;
  speedMps: number | null;
  heading: number | null;
}
export type Vehicle = "foot" | "bicycle" | "two_wheeler" | "car";
export type LegStatus = "assigned" | "to_pickup" | "at_pickup" | "picked_up" | "to_drop" | "at_drop" | "delivered" | "held" | "failed_at_pickup";
export interface Stop extends LatLng { name: string; address: string; area: string; notes: string }
export interface TripEvent { eventId: string; seq: number; type: string; at: number; reason: string }
export interface RouteStep { instruction: string; maneuver: string; distanceM: number; path: LatLng[] }
export interface TripRoute {
  provider: "google" | "osrm-demo";
  preview?: boolean;
  recordedAt?: number;
  computedAt: number;
  target: "pickup" | "drop";
  path: LatLng[];
  distanceM: number;
  durationS: number;
  steps: RouteStep[];
  warnings: string[];
}
export interface PickupCheck {
  servings: number;
  photo: string;
  smellsNormal: boolean;
  noSpoilage: boolean;
  temperatureOkay: boolean;
  packagingOkay: boolean;
}
export interface DeliveryReceipt { servings: number; problem: string; at: number }
export interface NgoOfferCandidate { phone: string; drop: Stop; partnerPhones?: string[] }
export interface NgoOffer {
  sentAt: number;
  deadline: number;
  remindedAt: number | null;
  readyFrom: number;
  status: "pending" | "accepted" | "exhausted";
  remaining: NgoOfferCandidate[];
  partnerPhones: string[];
  history: { phone: string; name: string; deadline: number; at: number; reason: "TIMEOUT" }[];
}
export interface TripInput {
  listingId: string;
  shareId: string;
  donorPhone: string;
  ngoPhone: string;
  partnerPhone: string | null;
  partnerName: string;
  vehicle: Vehicle;
  pickup: Stop;
  drop: Stop;
  food: string;
  servings: number;
  grade: "A" | "B" | "C";
  unsure: boolean;
  safeUntil: number;
  collectBy: number;
  maxTransitMin: number | null;
  containers: string;
  partnerBringsContainers: boolean;
  requestDeadline: number;
}
/** Private persistence contract. Never return this object directly. */
export interface DeliveryTrip extends TripInput {
  id: string;
  sample: boolean;
  version: number;
  routeRevision: number;
  routeChangedAt: number;
  heldFrom: Exclude<LegStatus, "held"> | null;
  shareAcceptedAt: number | null;
  requestStatus: "finding_partner" | "pending" | "accepted" | "declined";
  status: LegStatus;
  createdAt: number;
  acceptedAt: number | null;
  pickedUpAt: number | null;
  closedAt: number | null;
  location: TripPoint | null;
  eta: number | null;
  distanceM: number;
  stationarySince: number | null;
  stationaryAnchor: LatLng | null;
  events: TripEvent[];
  codes: Record<"pickup" | "drop", { seal: string; salt: string; hash: string; tries: number; lockedUntil: number }>;
  pickupCheck: PickupCheck | null;
  receipts: Record<string, { fingerprint: string; error: string | null }>;
  candidatePhones?: string[];
  receipt?: DeliveryReceipt | null;
  offer?: NgoOffer;
  offerHandoff?: { keyHash: string; fingerprint: string };
}
export interface TripView {
  id: string;
  listingId: string;
  sample: boolean;
  version: number;
  routeRevision: number;
  requestStatus: DeliveryTrip["requestStatus"];
  shareAcceptedAt: number | null;
  status: LegStatus;
  partnerName: string;
  vehicle: Vehicle;
  pickup: Stop | null;
  drop: Stop | null;
  pickupArea: string;
  dropArea: string;
  food: string;
  servings: number;
  grade: TripInput["grade"];
  unsure: boolean;
  safeUntil: number;
  collectBy: number;
  containers: string;
  partnerBringsContainers: boolean;
  requestDeadline: number;
  location: TripPoint | null;
  locationVisible: boolean;
  eta: number | null;
  pickedUpAt: number | null;
  closedAt: number | null;
  events: TripEvent[];
  code?: { kind: "pickup" | "drop"; value: string };
  offlineCodes?: Record<"pickup" | "drop", { salt: string; hash: string }>;
  route: TripRoute | null;
  routeError: string | null;
  receipt?: DeliveryReceipt | null;
}

/** Supplied after the Decision Agent accepts a redirect offer and rechecks eligibility. */
export interface RedirectInput {
  shareId: string;
  ngoPhone: string;
  drop: Stop;
  etaDrop: number;
  serveAt: number;
  eligibilityCheckedAt: number;
  reason: string;
}
