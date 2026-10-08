"use client";

import MapScreen, { type Lens } from "@/components/map/MapScreen";
import { getProfile, getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";

/** Signed-in donors and NGOs get their own lens and area; everyone else sees the public map. */
export default function MapRoute() {
  const hydrated = useHydrated();
  if (!hydrated) return <MapScreen lens="public" />;

  const session = getSession();
  const lens: Lens = session?.role === "donor" || session?.role === "ngo" ? session.role : "public";
  const area = session ? getProfile(session.role, session.phone)?.fields.area : undefined;
  const homeAreaName = lens !== "public" && area ? area : null;

  return (
    <MapScreen
      key={lens}
      lens={lens}
      homeAreaName={homeAreaName}
      backHref={session ? `/${session.role}` : undefined}
    />
  );
}
