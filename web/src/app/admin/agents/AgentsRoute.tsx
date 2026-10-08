"use client";

import Link from "next/link";
import AgentsBoard from "@/components/agents-board/AgentsBoard";
import { Counter, Masthead, Ticket } from "@/components/ticket/Ticket";
import { getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "@/components/console/console.module.css";

/** The agents board is for admins; anyone else gets the sign-in ticket's way in. */
export default function AgentsRoute() {
  const hydrated = useHydrated();
  if (!hydrated) return <Counter busy><span className="visually-hidden">Loading</span></Counter>;
  if (getSession()?.role === "admin") return <AgentsBoard />;
  return (
    <Counter>
      <Ticket label="Agents at work">
        <Masthead tagline="Agents at work" />
        <p className={s.gateNote}>This is where the Luna team shows the four agents passing each listing along, live. Sign in with an admin account to open it.</p>
        <Link href="/login" className={s.gateLink}>Sign in</Link>
      </Ticket>
    </Counter>
  );
}
