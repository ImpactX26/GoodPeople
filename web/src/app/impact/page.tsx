"use client";

import DonorOnly from "@/components/impact/DonorOnly";
import ImpactHome from "@/components/impact/ImpactHome";

export default function ImpactPage() {
  return <DonorOnly title="Your impact">{(s) => <ImpactHome session={s} />}</DonorOnly>;
}
