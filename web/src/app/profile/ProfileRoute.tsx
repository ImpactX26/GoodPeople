"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import DonorProfileRoute from "@/components/donor/DonorProfile";
import NgoProfile from "@/components/ngo/NgoProfile";
import DonorShell from "@/components/donor/DonorShell";
import d from "@/components/donor/donor.module.css";

/** One /profile for every role that has one: donors get addresses, NGOs their default listing. */
export default function ProfileRoute() {
  const hydrated = useHydrated(), router = useRouter(), session = hydrated ? getSession() : null;
  const role = session?.role;
  useEffect(() => {
    if (!hydrated) return;
    if (!role) router.replace("/login"); else if (role !== "donor" && role !== "ngo") router.replace(`/${role}`);
  }, [hydrated, role, router]);
  if (role === "ngo" && session) return <NgoProfile session={session} />;
  if (role === "donor" || !hydrated) return <DonorProfileRoute />;
  return <DonorShell title="Your profile"><p className={d.loading}>Loading…</p></DonorShell>;
}
