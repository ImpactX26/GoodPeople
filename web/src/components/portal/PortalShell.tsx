"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import LunaMark from "@/components/brand/LunaMark";
import { getProfile, getSession, type Profile, type Session } from "@/lib/luna/auth";
import type { Role } from "@/lib/luna/roles";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "./portal.module.css";

export interface PortalTab {
  id: string;
  href: string;
  label: string;
  line: string;
}

export interface Account {
  session: Session;
  profile: Profile | null;
}

/** The signed-in account for `role`, or null while loading / redirecting elsewhere. */
export function useRoleAccount(role: Role): Account | null {
  const router = useRouter();
  const hydrated = useHydrated();
  const session = hydrated ? getSession() : null;
  const signedInAs = session?.role;

  useEffect(() => {
    if (!hydrated) return;
    if (!signedInAs) router.replace("/login");
    else if (signedInAs !== role) router.replace(`/${signedInAs}`);
  }, [hydrated, signedInAs, role, router]);

  return useMemo(
    () => (session && signedInAs === role ? { session, profile: getProfile(session.role, session.phone) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hydrated, signedInAs, role],
  );
}

/** A wide paper sheet with a back link, the role's tabs, and a page title. */
export default function PortalShell({
  role,
  brand,
  tabs,
  tab,
  title,
  lede,
  children,
}: {
  role: Role;
  brand: string;
  tabs: PortalTab[];
  tab: string;
  title: string;
  lede: string;
  children: ReactNode;
}) {
  return (
    <main className={s.page}>
      <div className={s.printer} aria-hidden="true" />
      <div className={s.sheetShadow}>
        <section className={s.sheet} aria-labelledby="portal-title">
          <header className={s.top}>
            <Link href={`/${role}`} className={s.back}>
              <ArrowLeft size={16} aria-hidden="true" />
              <span>Home</span>
            </Link>
            <span className={s.brand}>
              <LunaMark size={22} title={null} />
              <span>{brand}</span>
            </span>
          </header>
          {tabs.length > 1 && (
            <nav className={s.tabs} aria-label={brand} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
              {tabs.map((t) => (
                <Link key={t.id} href={t.href} className={s.tab} aria-current={t.id === tab ? "page" : undefined}>
                  <span className={s.tabLabel}>{t.label}</span>
                  <span className={s.tabLine}>{t.line}</span>
                </Link>
              ))}
            </nav>
          )}
          <hr className={s.ruleSolid} />
          <h1 id="portal-title" className={s.title}>
            {title}
          </h1>
          {lede && <p className={s.lede}>{lede}</p>}
          {children}
        </section>
      </div>
    </main>
  );
}

export function Loading() {
  return (
    <main className={s.page}>
      <div className={s.printer} aria-hidden="true" data-busy="true" />
      <span className="visually-hidden">Loading</span>
    </main>
  );
}
