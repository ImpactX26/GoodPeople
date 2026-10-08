"use client";

import { getSession } from "@/lib/luna/auth";
import { useHydrated } from "@/lib/luna/useHydrated";
import Leaderboard from "@/components/impact/Leaderboard";

/** Public: anyone can open and share it. Signed-in restaurants get a way back to their impact page. */
export default function LeaderboardPage() {
  const hydrated = useHydrated(), role = hydrated ? getSession()?.role : undefined;
  return <Leaderboard back={role === "donor" ? { label: "Your impact", href: "/impact" } : role ? { label: "Home", href: `/${role}` } : undefined} />;
}
