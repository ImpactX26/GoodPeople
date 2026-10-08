"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getSession, type Session } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import DonorShell from "@/components/donor/DonorShell";
import s from "./impact.module.css";

/** Restaurant-only pages: signed-out visitors go to sign-in, other roles to their own home. */
export default function DonorOnly({ title, children }: { title: string; children: (session: Session) => ReactNode }) {
  const hydrated = useHydrated(), router = useRouter(), session = hydrated ? getSession() : null;
  const role = session?.role;
  useEffect(() => {
    if (!hydrated) return;
    if (!role) router.replace("/login"); else if (role !== "donor" && role !== "admin") router.replace(`/${role}`);
  }, [hydrated, role, router]);
  if (!session || (role !== "donor" && role !== "admin")) return <DonorShell title={title}><p className={s.note}>Loading…</p></DonorShell>;
  return <>{children(session)}</>;
}
