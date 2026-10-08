"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getSession, type Session } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import { usePartnerRequests } from "@/lib/luna/usePartnerRequests";
import s from "./notifications.module.css";

const Alerts = createContext<ReturnType<typeof usePartnerRequests>>({ requests: [], notice: "", connected: false, leg: null, withdrawn: [] });
export const usePickupNotifications = () => useContext(Alerts);

/** A single subscription follows the volunteer across every page in the app. */
export default function PartnerNotifications({ children }: { children: ReactNode }) {
  const hydrated = useHydrated();
  usePathname();
  const session = hydrated ? getSession() : null;
  return session?.role === "volunteer" ? <VolunteerAlerts key={session.phone} session={session}>{children}</VolunteerAlerts> : children;
}
function VolunteerAlerts({ session, children }: { session: Session; children: ReactNode }) {
  const data = usePartnerRequests(session), [dismissed, setDismissed] = useState("");
  return <Alerts.Provider value={data}>{children}
    {data.notice && data.notice !== dismissed && <aside className={s.toast} role="status" aria-label="Pickup notification">
      <strong>Luna · pickup update</strong><p>{data.notice}</p><div>
        {data.requests[0] && <Link href={`/deliveries?id=${data.requests[0].id}`}>View pickup →</Link>}
        <button onClick={() => setDismissed(data.notice)}>Dismiss</button>
      </div>
    </aside>}
  </Alerts.Provider>;
}
