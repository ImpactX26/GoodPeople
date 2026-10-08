import type { Metadata } from "next";
import Bags from "@/components/impact/Bags";

export const metadata: Metadata = { title: "Surprise bags · Luna" };

/** Public: anyone can reserve a bag. */
export default function BagsPage() {
  return <Bags />;
}
