/**
 * Surprise bags (SRS §9): a bakery or café sells part of its end-of-day surplus at a discount through Luna,
 * a small return on food it would otherwise throw away. Anyone can reserve a bag; they pay the restaurant at
 * pickup and show a 4-digit code. No payments run through Luna.
 */
export interface Bag {
  id: string;
  donorPhone: string;
  donorName: string;
  areaId: string;
  address: string;
  lat: number;
  lng: number;
  /** "Bakery bag", "Café bag". */
  title: string;
  /** What's likely inside: it's a surprise, so a description, not a list. */
  contents: string;
  diet: "veg" | "egg" | "nonveg";
  count: number;
  left: number;
  /** Rupees, paid at pickup. */
  price: number;
  /** What it would normally cost, so buyers see the saving. */
  worth: number;
  pickupFrom: number;
  pickupUntil: number;
  status: "open" | "closed";
  createdAt: number;
}

export interface BagHold {
  id: string;
  bagId: string;
  name: string;
  phone: string;
  code: string;
  status: "reserved" | "collected" | "cancelled";
  createdAt: number;
  collectedAt?: number;
}
