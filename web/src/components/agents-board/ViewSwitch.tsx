"use client";

import { useRouter } from "next/navigation";

/** The agents page has two views of the same live feed: the board (one row per listing) and the call sheet. */
export type AgentsView = "board" | "sheet";

const VIEWS: [AgentsView, string][] = [
  ["board", "Agents at work"],
  ["sheet", "Call sheet"],
];

/** Tabs on the printer bar; switching keeps the feed (lib/luna/console.ts) and everything it has received. */
export default function ViewSwitch({ view, groupClass, itemClass }: { view: AgentsView; groupClass: string; itemClass: string }) {
  const router = useRouter();
  return (
    <div className={groupClass} role="radiogroup" aria-label="View">
      {VIEWS.map(([v, label]) => (
        <button key={v} type="button" role="radio" aria-checked={view === v} className={itemClass} onClick={() => router.replace(v === "sheet" ? "/admin/agents?view=sheet" : "/admin/agents", { scroll: false })}>
          {label}
        </button>
      ))}
    </div>
  );
}
