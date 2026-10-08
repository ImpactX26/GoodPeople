"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import MapScreen from "@/components/map/MapScreen";
import { Counter } from "@/components/ticket/Ticket";
import { getProfile, getSession, signOut } from "@/lib/luna/auth";
import type { Role } from "@/lib/luna/roles";
import { useHydrated } from "@/lib/luna/useHydrated";
import DonorHome from "@/components/donor/DonorHome";
import NgoHome from "@/components/ngo/NgoHome";
import PartnerHome from "@/components/partner/PartnerHome";

/** Each role's home: donor (Snap first), NGO and delivery partner (shift cards), admin (the map). */
export default function RoleHome({ role }: { role: Role }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const session = hydrated ? getSession() : null;
  const allowed = session?.role === role;
  const state = useMemo(
    () => (session && allowed ? { session, profile: getProfile(session.role, session.phone) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hydrated, allowed],
  );

  const sessionRole = session?.role;
  useEffect(() => {
    if (!hydrated) return;
    if (!sessionRole) router.replace("/login");
    else if (!allowed) router.replace(`/${sessionRole}`);
  }, [hydrated, sessionRole, allowed, router]);

  if (!state) return <Counter busy><span className="visually-hidden">Loading</span></Counter>;
  if (role === "admin") return <MapScreen lens="admin" onSignOut={() => { signOut(); router.replace("/login"); }} />;
  const f = state.profile?.fields ?? {};
  if (role === "donor") return <DonorHome session={state.session} fields={f} />;
  if (role === "ngo") return <NgoHome session={state.session} fields={f} />;
  return <PartnerHome session={state.session} fields={f} />;
}
