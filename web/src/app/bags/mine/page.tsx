"use client";

import DonorOnly from "@/components/impact/DonorOnly";
import MyBags from "@/components/impact/MyBags";

export default function MyBagsPage() {
  return <DonorOnly title="Surprise bags">{(s) => <MyBags session={s} />}</DonorOnly>;
}
