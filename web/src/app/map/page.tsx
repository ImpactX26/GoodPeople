import type { Metadata } from "next";
import MapRoute from "./MapRoute";

export const metadata: Metadata = {
  title: "Food map · Luna",
  description: "Where surplus food is created and where hunger goes unmet across Bengaluru. Sample data.",
};

export default function MapPage() {
  return <MapRoute />;
}
