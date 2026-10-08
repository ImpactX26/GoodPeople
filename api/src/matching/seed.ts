/**
 * SAMPLE recipients and delivery partners, built from the heat map's
 * AREAS. map/model.ts only knows each NGO's name, type, meals per day and
 * fridge, so the rest (serving times, diet rules, capacity, a location near the
 * area centre) is filled in here per type. Nothing is added to AREAS itself,
 * because that would change the heat map's numbers.
 */
import { AREAS, type Ngo } from "../map/model.ts";
import type { LatLng, Partner, Recipient, RecipientKind, Travel } from "./types.ts";

const KIND_FROM_TYPE: Record<Ngo["type"], RecipientKind> = {
  NGO: "ngo",
  Shelter: "shelter",
  Orphanage: "orphanage",
  "Old-age home": "old_age_home",
  "Community fridge": "community_fridge",
};

/** Profile values from the sign-up form ("Old-age home") → recipient kinds. */
export const kindFromLabel = (label: string | undefined): RecipientKind | undefined =>
  label ? KIND_FROM_TYPE[label as Ngo["type"]] : undefined;

/** Sign-up profiles store the area's display name ("HSR Layout"); matching uses ids ("hsr"). */
export function areaIdFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const n = name.trim().toLowerCase();
  return AREAS.find((a) => a.id === n || a.name.toLowerCase() === n)?.id;
}

export const areaById = (id: string) => AREAS.find((a) => a.id === id);

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A fixed point within ~1.2 km of the area centre, so recipients in one area aren't 0 km apart. */
function near(c: LatLng, key: string): LatLng {
  const h = hash(key);
  const ang = ((h % 360) * Math.PI) / 180;
  const km = 0.3 + ((h >>> 9) % 900) / 1000;
  return { lat: c.lat + (km * Math.sin(ang)) / 110.57, lng: c.lng + (km * Math.cos(ang)) / (111.32 * Math.cos((c.lat * Math.PI) / 180)) };
}

const ALL_DIETS: Recipient["acceptsDiet"] = ["veg", "jain", "egg", "nonveg"];

const BY_KIND: Record<RecipientKind, Omit<Recipient, "id" | "name" | "areaId" | "lat" | "lng" | "kind" | "fridge" | "capacityPerDelivery">> = {
  ngo: { vulnerable: false, servingTimes: ["13:00", "20:00"], servesWithinMin: 30, acceptsDiet: ALL_DIETS, halalOnly: false, avoidAllergens: [], acceptRadiusKm: 6, active: true },
  shelter: { vulnerable: false, servingTimes: [], servesWithinMin: 20, acceptsDiet: ALL_DIETS, halalOnly: false, avoidAllergens: [], acceptRadiusKm: 6, active: true },
  orphanage: { vulnerable: true, servingTimes: ["13:00", "19:30"], servesWithinMin: 30, acceptsDiet: ["veg", "jain", "egg"], halalOnly: false, avoidAllergens: ["nuts"], acceptRadiusKm: 8, active: true },
  old_age_home: { vulnerable: true, servingTimes: ["12:30", "19:30"], servesWithinMin: 30, acceptsDiet: ["veg", "jain"], halalOnly: false, avoidAllergens: [], acceptRadiusKm: 6, active: true },
  community_fridge: { vulnerable: false, servingTimes: [], servesWithinMin: 0, acceptsDiet: ALL_DIETS, halalOnly: false, avoidAllergens: [], acceptRadiusKm: 5, active: true },
  animal_shelter: { vulnerable: false, servingTimes: [], servesWithinMin: 60, acceptsDiet: ALL_DIETS, halalOnly: false, avoidAllergens: [], acceptRadiusKm: 20, active: true },
  compost: { vulnerable: false, servingTimes: [], servesWithinMin: 60, acceptsDiet: ALL_DIETS, halalOnly: false, avoidAllergens: [], acceptRadiusKm: 25, active: true },
};

/** Per-NGO tweaks so the SRS scenarios show up in the demo. */
const OVERRIDES: Record<string, Partial<Recipient>> = {
  // SRS example 2: a Jayanagar NGO that serves dinner at 8 pm.
  "Hope Shelter": { servingTimes: ["20:00"] },
  // SRS example 3: a veg-only NGO.
  "Annapoorna Trust": { acceptsDiet: ["veg", "jain"] },
  "Russell Market Relief": { halalOnly: true },
};

export function seedRecipients(): Recipient[] {
  const out: Recipient[] = [];
  for (const a of AREAS) {
    a.ngos.forEach((n, i) => {
      const kind = KIND_FROM_TYPE[n.type];
      out.push({
        id: `r-${a.id}-${i + 1}`,
        name: n.name,
        areaId: a.id,
        ...near(a, n.name),
        kind,
        fridge: n.fridge,
        capacityPerDelivery: kind === "community_fridge" ? 40 : Math.round(n.mealsPerDay * 0.5),
        ...BY_KIND[kind],
        ...OVERRIDES[n.name],
      });
    });
  }
  // Grade D needs somewhere to go that isn't people.
  const extra: [string, string, RecipientKind][] = [
    ["r-hebbal-animals", "Sample Animal Shelter, Hebbal", "animal_shelter"],
    ["r-bellandur-compost", "Sample Compost Unit, Bellandur", "compost"],
  ];
  for (const [id, name, kind] of extra) {
    const a = areaById(id.split("-")[1])!;
    out.push({ id, name, areaId: a.id, ...near(a, name), kind, fridge: false, capacityPerDelivery: 500, ...BY_KIND[kind] });
  }
  return out;
}

/**
 * One independent partner per area, plus one of their own riders for each NGO
 * and shelter. All online, so the demo has someone to ask.
 */
export function seedPartners(recipients: Recipient[] = seedRecipients()): Partner[] {
  const independents: Partner[] = AREAS.map((a, i) => ({
    id: `p-${a.id}`,
    name: `Sample partner, ${a.name}`,
    areaId: a.id,
    ...near(a, `partner-${a.id}`),
    travel: (i % 5 === 4 ? "bicycle" : "two_wheeler") as Travel,
    online: true,
  }));
  const own: Partner[] = recipients
    .filter((r) => r.kind === "ngo" || r.kind === "shelter")
    .map((r) => ({
      id: `p-${r.id}`,
      name: `${r.name} rider`,
      areaId: r.areaId,
      ...near(r, `rider-${r.id}`),
      travel: "two_wheeler" as Travel,
      online: true,
      ngoId: r.id,
    }));
  return [...independents, ...own];
}
