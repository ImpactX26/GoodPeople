import type { Metadata } from "next";
import ListDashboard from "./ListDashboard";

export const metadata: Metadata = { title: "NGO listings · Luna" };

export default function Page() {
  return <ListDashboard />;
}
