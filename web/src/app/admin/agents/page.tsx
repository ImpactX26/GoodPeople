import type { Metadata } from "next";
import { Suspense } from "react";
import AgentsRoute from "./AgentsRoute";

export const metadata: Metadata = {
  title: "Agents · Luna",
  description: "Luna's four agents at work on every listing, live: the board and the call sheet. For Luna admins.",
};

export default function AgentsPage() {
  return (
    <Suspense>
      <AgentsRoute />
    </Suspense>
  );
}
