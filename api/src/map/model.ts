/**
 * Food Heat Map model.
 *
 * Everything here is SAMPLE data, generated deterministically from the
 * scenarios in the SRS, until real listings and deliveries flow in.
 */

export const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export const SLOT_COUNT = 8;
/** 3-hour windows: 00–03 … 21–24 */
export const SLOT_LABELS = ["00–03", "03–06", "06–09", "09–12", "12–15", "15–18", "18–21", "21–24"];
export const WINDOWS = DAYS.length * SLOT_COUNT;

/** Gap rule: an area is a gap spot when (need − received) / need ≥ 0.5 and need ≥ 40 meals. */
export const GAP_RATIO = 0.5;
export const GAP_MIN_NEED = 40;

export type DonorKind = "restaurant" | "caterer" | "hotel" | "household";

export interface Ngo {
  name: string;
  type: "NGO" | "Shelter" | "Orphanage" | "Old-age home" | "Community fridge";
  mealsPerDay: number;
  fridge: boolean;
}

export interface Donor {
  name: string;
  kind: DonorKind;
}

export interface Area {
  id: string;
  name: string;
  lng: number;
  lat: number;
  /** Meals of surplus per day by donor kind, before time-of-day weighting. */
  surplus: Record<DonorKind, number>;
  ngos: Ngo[];
  /** Estimated meals needed per day where no NGO exists (from population). */
  estimatedNeed?: number;
  /** How well food actually reaches this area (routes, volunteers). 0–1. */
  reach: number;
  donors: Donor[];
}

const s = (restaurant: number, caterer: number, hotel: number, household: number) => ({
  restaurant,
  caterer,
  hotel,
  household,
});

export const AREAS: Area[] = [
  {
    id: "koramangala", name: "Koramangala", lng: 77.6245, lat: 12.9352, surplus: s(620, 90, 140, 60), reach: 0.95,
    ngos: [{ name: "Annapoorna Trust", type: "NGO", mealsPerDay: 220, fridge: true }],
    donors: [{ name: "Third Wave Canteen", kind: "restaurant" }, { name: "Forum Food Court", kind: "restaurant" }, { name: "Hotel Kora Residency", kind: "hotel" }],
  },
  {
    id: "jayanagar", name: "Jayanagar", lng: 77.5938, lat: 12.925, surplus: s(160, 60, 30, 90), reach: 0.8,
    ngos: [
      { name: "Hope Shelter", type: "Shelter", mealsPerDay: 180, fridge: false },
      { name: "Sri Sai Old-age Home", type: "Old-age home", mealsPerDay: 90, fridge: true },
    ],
    donors: [{ name: "4th Block Darshini", kind: "restaurant" }, { name: "Jayanagar Caterers", kind: "caterer" }, { name: "Rao household", kind: "household" }],
  },
  {
    id: "indiranagar", name: "Indiranagar", lng: 77.6412, lat: 12.9719, surplus: s(480, 60, 120, 40), reach: 0.9,
    ngos: [{ name: "Little Hands Home", type: "Orphanage", mealsPerDay: 140, fridge: true }],
    donors: [{ name: "100ft Road Kitchen", kind: "restaurant" }, { name: "Cafe Mocha (sample)", kind: "restaurant" }, { name: "The Indira Hotel", kind: "hotel" }],
  },
  {
    id: "hsr", name: "HSR Layout", lng: 77.6389, lat: 12.9116, surplus: s(360, 70, 40, 70), reach: 0.85,
    ngos: [
      { name: "FeedForward HSR", type: "NGO", mealsPerDay: 300, fridge: true },
      { name: "Sector 2 Night Shelter", type: "Shelter", mealsPerDay: 60, fridge: false },
    ],
    donors: [{ name: "27th Main Bistro", kind: "restaurant" }, { name: "HSR Cloud Kitchens", kind: "restaurant" }, { name: "Agara household", kind: "household" }],
  },
  {
    id: "rajajinagar", name: "Rajajinagar", lng: 77.552, lat: 12.991, surplus: s(150, 420, 40, 60), reach: 0.8,
    ngos: [{ name: "Navodaya Seva", type: "NGO", mealsPerDay: 160, fridge: false }],
    donors: [{ name: "Shubha Kalyana Mantapa", kind: "caterer" }, { name: "Vijaya Wedding Caterers", kind: "caterer" }, { name: "1st Block Mess", kind: "restaurant" }],
  },
  {
    id: "malleshwaram", name: "Malleshwaram", lng: 77.5709, lat: 13.0035, surplus: s(210, 120, 30, 80), reach: 0.9,
    ngos: [{ name: "Malleshwaram Community Fridge", type: "Community fridge", mealsPerDay: 70, fridge: true }],
    donors: [{ name: "Sampige Road Tiffins", kind: "restaurant" }, { name: "8th Cross Sweets", kind: "restaurant" }, { name: "Iyer household", kind: "household" }],
  },
  {
    id: "btm", name: "BTM Layout", lng: 77.6101, lat: 12.9166, surplus: s(260, 40, 20, 90), reach: 0.75,
    ngos: [{ name: "BTM Youth Kitchen", type: "NGO", mealsPerDay: 200, fridge: false }],
    donors: [{ name: "Udupi Grand BTM", kind: "restaurant" }, { name: "Stage 2 Biryani House", kind: "restaurant" }],
  },
  {
    id: "jpnagar", name: "JP Nagar", lng: 77.5857, lat: 12.9063, surplus: s(200, 90, 20, 100), reach: 0.8,
    ngos: [{ name: "Nandini Children's Home", type: "Orphanage", mealsPerDay: 120, fridge: true }],
    donors: [{ name: "Phase 6 Meals", kind: "restaurant" }, { name: "JP Nagar Caterers", kind: "caterer" }],
  },
  {
    id: "basavanagudi", name: "Basavanagudi", lng: 77.5738, lat: 12.9422, surplus: s(190, 110, 20, 70), reach: 0.85,
    ngos: [{ name: "Gandhi Bazaar Anna Dana", type: "NGO", mealsPerDay: 130, fridge: false }],
    donors: [{ name: "DVG Road Tiffin Room", kind: "restaurant" }, { name: "Bull Temple Caterers", kind: "caterer" }],
  },
  {
    id: "whitefield", name: "Whitefield", lng: 77.75, lat: 12.9698, surplus: s(420, 80, 260, 60), reach: 0.7,
    ngos: [{ name: "ITPL Night Shelter", type: "Shelter", mealsPerDay: 150, fridge: false }],
    donors: [{ name: "Tech Park Cafeteria", kind: "hotel" }, { name: "Whitefield Grand", kind: "hotel" }, { name: "Phoenix Food Hall", kind: "restaurant" }],
  },
  {
    id: "marathahalli", name: "Marathahalli", lng: 77.7011, lat: 12.9569, surplus: s(300, 60, 60, 80), reach: 0.7,
    ngos: [{ name: "Outer Ring Relief", type: "NGO", mealsPerDay: 240, fridge: false }],
    donors: [{ name: "ORR Andhra Meals", kind: "restaurant" }, { name: "Kundalahalli Bakery", kind: "restaurant" }],
  },
  {
    id: "hebbal", name: "Hebbal", lng: 77.597, lat: 13.0358, surplus: s(180, 140, 120, 50), reach: 0.75,
    ngos: [{ name: "Hebbal Lake Shelter", type: "Shelter", mealsPerDay: 110, fridge: false }],
    donors: [{ name: "Esteem Mall Food Court", kind: "restaurant" }, { name: "Hebbal Convention Hall", kind: "caterer" }],
  },
  {
    id: "yelahanka", name: "Yelahanka", lng: 77.5963, lat: 13.1007, surplus: s(90, 70, 20, 60), reach: 0.3,
    ngos: [], estimatedNeed: 170,
    donors: [{ name: "New Town Darshini", kind: "restaurant" }, { name: "Yelahanka Choultry", kind: "caterer" }],
  },
  {
    id: "ecity", name: "Electronic City", lng: 77.6602, lat: 12.8452, surplus: s(240, 50, 180, 30), reach: 0.3,
    ngos: [], estimatedNeed: 240,
    donors: [{ name: "Phase 1 Food Court", kind: "restaurant" }, { name: "Phase 2 Tech Park Canteen", kind: "hotel" }],
  },
  {
    id: "banashankari", name: "Banashankari", lng: 77.5468, lat: 12.9255, surplus: s(170, 80, 20, 90), reach: 0.8,
    ngos: [{ name: "BSK Vriddhashrama", type: "Old-age home", mealsPerDay: 80, fridge: true }],
    donors: [{ name: "Temple Road Mess", kind: "restaurant" }, { name: "2nd Stage Caterers", kind: "caterer" }],
  },
  {
    id: "shivajinagar", name: "Shivajinagar", lng: 77.6057, lat: 12.9857, surplus: s(340, 60, 80, 50), reach: 0.85,
    ngos: [{ name: "Russell Market Relief", type: "NGO", mealsPerDay: 260, fridge: false }],
    donors: [{ name: "Commercial Street Eats", kind: "restaurant" }, { name: "Mosque Road Kitchens", kind: "restaurant" }],
  },
  {
    id: "bellandur", name: "Bellandur", lng: 77.6784, lat: 12.9304, surplus: s(260, 40, 160, 40), reach: 0.6,
    ngos: [{ name: "Lakeside Community Fridge", type: "Community fridge", mealsPerDay: 60, fridge: true }],
    donors: [{ name: "Ecospace Cafeteria", kind: "hotel" }, { name: "Bellandur Biryani Co.", kind: "restaurant" }],
  },
  {
    id: "yeshwanthpur", name: "Yeshwanthpur", lng: 77.5409, lat: 13.0285, surplus: s(150, 100, 60, 60), reach: 0.7,
    ngos: [{ name: "Railway Colony Shelter", type: "Shelter", mealsPerDay: 170, fridge: false }],
    donors: [{ name: "APMC Yard Canteen", kind: "restaurant" }, { name: "Orion Food Court", kind: "restaurant" }],
  },
  {
    id: "nagarabhavi", name: "Nagarabhavi", lng: 77.5098, lat: 12.9606, surplus: s(170, 90, 20, 80), reach: 0.6,
    ngos: [{ name: "Nagarabhavi Seva Trust", type: "NGO", mealsPerDay: 120, fridge: false }],
    donors: [{ name: "Ring Road Darshini", kind: "restaurant" }, { name: "2nd Stage Kalyana Mantapa", kind: "caterer" }],
  },
  {
    id: "rrnagar", name: "Rajarajeshwari Nagar", lng: 77.5195, lat: 12.9274, surplus: s(180, 160, 30, 90), reach: 0.55,
    ngos: [{ name: "RR Nagar Vriddhashrama", type: "Old-age home", mealsPerDay: 70, fridge: true }],
    donors: [{ name: "Ideal Homes Tiffin Centre", kind: "restaurant" }, { name: "Arch Road Convention Hall", kind: "caterer" }],
  },
];

const AREA_BY_ID = new Map(AREAS.map((a) => [a.id, a]));

/* ---------- Time-of-day and day-of-week patterns ---------- */

const SURPLUS_SLOT: Record<DonorKind, number[]> = {
  restaurant: [0.03, 0, 0.02, 0.06, 0.12, 0.08, 0.25, 0.44],
  caterer: [0, 0, 0.02, 0.1, 0.3, 0.28, 0.2, 0.1],
  hotel: [0.05, 0.02, 0.2, 0.22, 0.12, 0.08, 0.16, 0.15],
  household: [0, 0, 0.05, 0.22, 0.3, 0.1, 0.23, 0.1],
};
const SURPLUS_DAY: Record<DonorKind, number[]> = {
  restaurant: [0.85, 0.85, 0.9, 0.95, 1.15, 1.3, 1.2],
  caterer: [0.5, 0.45, 0.5, 0.6, 0.9, 1.8, 2.4],
  hotel: [1.1, 1.1, 1.05, 1.05, 1, 0.85, 0.8],
  household: [0.9, 0.9, 0.9, 0.9, 1, 1.2, 1.3],
};
const NEED_SLOT = [0, 0, 0.06, 0.14, 0.3, 0.1, 0.3, 0.1];

/* ---------- Deterministic noise ---------- */

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function noise(key: string, lo: number, hi: number) {
  const x = Math.sin(hash(key)) * 10000;
  return lo + (x - Math.floor(x)) * (hi - lo);
}

/* ---------- The model ---------- */

export interface WindowStats {
  surplus: number;
  need: number;
  received: number;
  short: number;
  gapRatio: number;
  isGap: boolean;
}

export function dailyNeed(a: Area) {
  return a.ngos.length ? a.ngos.reduce((n, g) => n + g.mealsPerDay, 0) : (a.estimatedNeed ?? 0);
}

export function computeWindow(a: Area, day: number, slot: number, weekOffset = 0): WindowStats {
  const k = `${a.id}:${day}:${slot}:${weekOffset}`;
  let surplus = 0;
  (Object.keys(a.surplus) as DonorKind[]).forEach((kind) => {
    surplus += a.surplus[kind] * SURPLUS_SLOT[kind][slot] * SURPLUS_DAY[kind][day];
  });
  surplus *= noise(`s${k}`, 0.85, 1.15);

  const need = dailyNeed(a) * NEED_SLOT[slot] * noise(`n${k}`, 0.9, 1.1);
  let fill =
    Math.min(1, 0.3 + (0.9 * surplus) / Math.max(need, 1)) *
    a.reach *
    noise(`r${k}`, 0.9, 1.06) *
    // weeks differ: volunteers, weather, events
    (weekOffset ? noise(`wk${a.id}:${weekOffset}`, 0.78, 1.22) : 1);

  // Scenario: Jayanagar goes short every Wednesday night.
  if (a.id === "jayanagar" && day === 2 && slot >= 6) fill *= 0.2;
  // Scenario: in HSR Layout one large NGO takes most of the food; the night shelter goes short at night.
  if (a.id === "hsr" && slot >= 6) fill *= 0.55;

  const received = Math.min(need, need * Math.max(0, Math.min(1, fill)));
  const short = Math.max(0, need - received);
  const gapRatio = need > 0 ? short / need : 0;
  return {
    surplus: Math.round(surplus),
    need: Math.round(need),
    received: Math.round(received),
    short: Math.round(short),
    gapRatio,
    isGap: gapRatio >= GAP_RATIO && need >= GAP_MIN_NEED,
  };
}

export interface AreaWeek {
  area: Area;
  surplus: number;
  need: number;
  received: number;
  short: number;
  /** The window with the most meals short. */
  worst: { day: number; slot: number; short: number };
  gapWindows: number;
}

export function computeWeek(a: Area, weekOffset = 0): AreaWeek {
  const out: AreaWeek = { area: a, surplus: 0, need: 0, received: 0, short: 0, worst: { day: 0, slot: 0, short: -1 }, gapWindows: 0 };
  for (let d = 0; d < 7; d++) {
    for (let sl = 0; sl < SLOT_COUNT; sl++) {
      const w = computeWindow(a, d, sl, weekOffset);
      out.surplus += w.surplus;
      out.need += w.need;
      out.received += w.received;
      out.short += w.short;
      if (w.isGap) out.gapWindows++;
      if (w.short > out.worst.short) out.worst = { day: d, slot: sl, short: w.short };
    }
  }
  return out;
}

/* ---------- Hex grid ---------- */

export interface Hex {
  id: number;
  areaId: string;
  /** 0–1: how central this hex is to its area; carries the area's intensity. */
  weight: number;
  ring: [number, number][];
}

const LAT0 = 12.97;
const KM_LAT = 110.57;
const KM_LNG = 111.32 * Math.cos((LAT0 * Math.PI) / 180);
const HEX_R = 0.56; // km, centre to corner
const REACH_KM = 3.6;

let hexCache: Hex[] | null = null;

export function buildHexes(): Hex[] {
  if (hexCache) return hexCache;
  const hexes: Hex[] = [];
  const w = Math.sqrt(3) * HEX_R;
  const h = 1.5 * HEX_R;
  const lng0 = 77.5;
  const lat0 = 12.82;
  let id = 0;
  for (let row = 0; row < 60; row++) {
    for (let col = 0; col < 50; col++) {
      const xKm = col * w + (row % 2 ? w / 2 : 0);
      const yKm = row * h;
      const lng = lng0 + xKm / KM_LNG;
      const lat = lat0 + yKm / KM_LAT;
      let best: Area | null = null;
      let bestD = Infinity;
      for (const a of AREAS) {
        const d = Math.hypot((a.lng - lng) * KM_LNG, (a.lat - lat) * KM_LAT);
        if (d < bestD) {
          bestD = d;
          best = a;
        }
      }
      if (!best || bestD > REACH_KM) continue;
      const ring: [number, number][] = [];
      for (let i = 0; i < 6; i++) {
        const ang = ((60 * i - 30) * Math.PI) / 180;
        ring.push([lng + (HEX_R * Math.cos(ang)) / KM_LNG, lat + (HEX_R * Math.sin(ang)) / KM_LAT]);
      }
      ring.push(ring[0]);
      const weight = Math.exp(-((bestD / 2.3) ** 2)) * noise(`hex${id}`, 0.8, 1.1);
      hexes.push({ id: id++, areaId: best.id, weight: Math.min(1, weight), ring });
    }
  }
  hexCache = hexes;
  return hexes;
}

/* ---------- Queries served by the API ---------- */

export type Snapshot = Record<string, WindowStats>;

export interface AreaDetail {
  area: Area;
  week: AreaWeek;
  /** Share of need received, oldest week first. */
  trend: { label: string; pct: number }[];
  topDonors: (Donor & { mealsPerWeek: number })[];
}

/** Everything the map needs for one week: geometry, all 56 windows, the tape series and the rail. */
export function mapWeek() {
  const windows: Snapshot[] = [];
  for (let d = 0; d < 7; d++)
    for (let sl = 0; sl < SLOT_COUNT; sl++)
      windows.push(Object.fromEntries(AREAS.map((a) => [a.id, computeWindow(a, d, sl)])));
  const series = windows.map((w) => Object.values(w).reduce((n, x) => n + x.short, 0));
  const top = AREAS.map((a) => computeWeek(a))
    .filter((w) => w.short > 0)
    .sort((x, y) => y.short - x.short)
    .slice(0, 10)
    .map((w) => ({ areaId: w.area.id, name: w.area.name, short: w.short, worst: w.worst, gapWindows: w.gapWindows }));
  return { areas: AREAS, hexes: buildHexes(), windows, series, top };
}

export function areaDetail(id: string): AreaDetail | null {
  const area = AREA_BY_ID.get(id);
  if (!area) return null;
  const week = computeWeek(area);
  const trend = [3, 2, 1, 0].map((off) => {
    const w = computeWeek(area, off);
    return { label: off === 0 ? "This wk" : `${off} wk ago`, pct: w.need ? Math.round((w.received / w.need) * 100) : 100 };
  });
  const totalKind = (k: DonorKind) =>
    (area.surplus[k] * SURPLUS_DAY[k].reduce((n, x) => n + x, 0)) / area.donors.filter((d) => d.kind === k).length || 0;
  const topDonors = area.donors
    .map((d, i) => ({ ...d, mealsPerWeek: Math.round(totalKind(d.kind) * (i === 0 ? 0.6 : 0.4)) }))
    .sort((x, y) => y.mealsPerWeek - x.mealsPerWeek)
    .slice(0, 3);
  return { area, week, trend, topDonors };
}
