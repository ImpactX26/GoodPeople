import { randomBytes } from "node:crypto";
import { ADMIN } from "../auth.ts";
import { store, type Profile, type Role, type Session } from "../store.ts";

export const localScenarioEnabled = () => !process.env.DATABASE_URL && process.env.ENABLE_TRIP_DEMO === "1";
export interface Scenario { id: string; sessions: Record<Role, Session>; profiles: Record<Role, Profile>; volunteers: { session: Session; profile: Profile }[]; ngos: { session: Session; profile: Profile }[] }
const scenarios = new Map<string, Scenario>();
const byDonor = new Map<string, Scenario>();
export const currentScenario = () => localScenarioEnabled() ? [...scenarios.values()].at(-1) : undefined;
export const scenarioFor = (phone: string) => localScenarioEnabled() ? byDonor.get(phone) : undefined;

export async function provisionScenario(key: string): Promise<Scenario> {
  const old = scenarios.get(key); if (old) return old;
  const now = Date.now(), id = `scn_${randomBytes(8).toString("hex")}`;
  const sessions = {} as Record<Role, Session>, profiles = {} as Record<Role, Profile>;
  const fields: Record<Role, Record<string, string>> = {
    donor: { name: "Ravi Kumar", org: "Annapurna Kitchen", kind: "Restaurant", area: "Koramangala", address: "80 Feet Road, Koramangala, Bengaluru", lat: "12.9352", lng: "77.6245", notes: "Use the kitchen entrance. Ask for Ravi.", fssai: "DEMO-LICENCE", verification: "Demo approved", containers: "donor_packs" },
    ngo: { name: "Meera Rao", org: "Udaya Community Kitchen", kind: "NGO", area: "Indiranagar", address: "100 Feet Road, Indiranagar, Bengaluru", lat: "12.9719", lng: "77.6412", notes: "Meera receives deliveries at the main entrance.", registration: "DEMO-TRUST-ID", verification: "Demo approved", receivingHours: "Open for this walkthrough", beneficiaries: "Adults", standingNeed: "40", capacity: "40", diets: "veg", avoidAllergens: "", servesWithinMin: "15", fridge: "Yes" },
    volunteer: { name: "Arjun Patel", org: "Udaya Community Kitchen volunteer", kind: "Delivery partner", area: "Koramangala", travel: "Two-wheeler", verification: "Demo approved", online: "true", insulatedBag: "Yes", capacity: "20" },
    admin: { name: ADMIN.name, org: "Luna", kind: "Reviewer", area: "Bengaluru" },
  };
  for (const role of ["donor", "ngo", "volunteer", "admin"] as const) {
    // Luna has one admin, so the walkthrough signs in as that number (local only).
    const phone = role === "admin" ? ADMIN.phone : `9${(BigInt(`0x${randomBytes(6).toString("hex")}`) % 1000000000n).toString().padStart(9, "0")}`;
    profiles[role] = { role, phone, fields: { ...fields[role], scenarioId: id, sample: "true" }, createdAt: now };
    sessions[role] = { role, phone, token: randomBytes(32).toString("hex"), signedInAt: now };
    await store.putProfile(profiles[role]); await store.putSession(sessions[role]);
  }
  const fallbackPhone = `9${(BigInt(`0x${randomBytes(6).toString("hex")}`) % 1000000000n).toString().padStart(9, "0")}`;
  const fallbackProfile: Profile = { ...profiles.ngo, phone: fallbackPhone, fields: { ...profiles.ngo.fields, name: "Ananya Shah", org: "Seva Neighborhood Kitchen", notes: "Ask for Ananya at the receiving desk." } };
  const fallbackSession: Session = { role: "ngo", phone: fallbackPhone, token: randomBytes(32).toString("hex"), signedInAt: now };
  await store.putProfile(fallbackProfile); await store.putSession(fallbackSession);
  const ngos = [{ session: sessions.ngo, profile: profiles.ngo }, { session: fallbackSession, profile: fallbackProfile }];
  const volunteers = [{ session: sessions.volunteer, profile: profiles.volunteer }];
  for (const name of ["Kavya Shetty", "Nikhil Rao"]) {
    const phone = `9${(BigInt(`0x${randomBytes(6).toString("hex")}`) % 1000000000n).toString().padStart(9, "0")}`;
    const profile: Profile = { role: "volunteer", phone, fields: { ...profiles.volunteer.fields, name }, createdAt: now };
    const session: Session = { role: "volunteer", phone, token: randomBytes(32).toString("hex"), signedInAt: now };
    await store.putProfile(profile); await store.putSession(session); volunteers.push({ profile, session });
  }
  for (const volunteer of volunteers) {
    volunteer.profile.fields.affiliatedNgo = sessions.ngo.phone;
    volunteer.profile.fields.affiliatedNgos = ngos.map(n => n.session.phone).join(",");
    volunteer.profile.fields.nightTasks = "true";
    await store.putProfile(volunteer.profile);
  }
  const result = { id, sessions, profiles, volunteers, ngos }; scenarios.set(key, result); byDonor.set(sessions.donor.phone, result);
  return result;
}
