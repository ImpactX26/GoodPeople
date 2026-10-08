"use client";

import type { ReactNode } from "react";
import PortalShell, { Loading, useRoleAccount, type PortalTab } from "@/components/portal/PortalShell";

export { Loading };

const TABS: PortalTab[] = [
  { id: "list", href: "/ngo/list", label: "NGO listings", line: "List yourself, see every NGO" },
  { id: "offers", href: "/ngo/offers", label: "Food offers", line: "Accept, get OTP + ETA" },
];

export const useNgoAccount = () => useRoleAccount("ngo");

export default function NgoShell(props: { tab: "list" | "offers"; title: string; lede: string; children: ReactNode }) {
  return <PortalShell role="ngo" brand="LUNA · NGO PORTAL" tabs={TABS} {...props} />;
}
