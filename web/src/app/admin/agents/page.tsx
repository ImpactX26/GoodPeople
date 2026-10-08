import type { Metadata } from "next";
import AgentsRoute from "./AgentsRoute";

export const metadata: Metadata = {
  title: "Agents at work · Luna",
  description: "Luna's four agents passing each listing along, one row of printers per listing, live. For Luna admins.",
};

export default function AgentsPage() {
  return <AgentsRoute />;
}
