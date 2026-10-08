"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import AgentsBoard from "@/components/agents-board/AgentsBoard";
import AgentConsole from "@/components/console/AgentConsole";
import { Counter, Masthead, Ticket } from "@/components/ticket/Ticket";
import { getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import s from "@/components/console/console.module.css";

/**
 * Everything the agents do, on one admin page with two views of the same live feed: the board (one row per
 * listing, ?view=board) and the call sheet (?view=sheet). Admins only; anyone else gets the way in.
 */
export default function AgentsRoute() {
  const hydrated = useHydrated();
  const view = useSearchParams().get("view") === "sheet" ? "sheet" : "board";
  if (!hydrated) return <Counter busy><span className="visually-hidden">Loading</span></Counter>;
  if (getSession()?.role === "admin") return view === "sheet" ? <AgentConsole view="sheet" /> : <AgentsBoard view="board" />;
  return (
    <Counter>
      <Ticket label="Agents">
        <Masthead tagline="Agents at work" />
        <p className={s.gateNote}>This is where the Luna team watches the four agents pass each listing along, live. Sign in with the admin account to open it.</p>
        <Link href="/login" className={s.gateLink}>Sign in</Link>
      </Ticket>
    </Counter>
  );
}
