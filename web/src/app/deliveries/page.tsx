import { Suspense } from "react";
import DeliveryHub from "@/components/trip/DeliveryHub";

export default function DeliveriesPage() {
  return <Suspense fallback={<p>Loading deliveries…</p>}><DeliveryHub /></Suspense>;
}
