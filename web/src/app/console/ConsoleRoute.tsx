"use client";

import Link from "next/link";
import AgentConsole from "@/components/console/AgentConsole";
import { Counter, Masthead, Ticket } from "@/components/ticket/Ticket";
import { getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "@/components/console/console.module.css";

/** The agent console is for admins; anyone else gets the sign-in ticket's way in. */
export default function ConsoleRoute() {
  const hydrated = useHydrated();
  if (!hydrated) return <Counter busy><span className="visually-hidden">Loading</span></Counter>;
  if (getSession()?.role === "admin") return <AgentConsole />;
  return (
    <Counter>
      <Ticket label="Agent console">
        <Masthead tagline="Agents live" />
        <p className={s.gateNote}>This is where the Luna team watches the four agents hand food to each other and explain every call. Sign in with an admin account to open it.</p>
        <Link href="/login" className={s.gateLink}>Sign in</Link>
      </Ticket>
    </Counter>
  );
}
