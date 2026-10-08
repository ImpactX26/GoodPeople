"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import DonorOnly from "@/components/impact/DonorOnly";
import Certificate from "@/components/impact/Certificate";

function CertificateRoute() {
  const month = useSearchParams().get("month") ?? undefined;
  return <DonorOnly title="Impact certificate">{(s) => <Certificate session={s} month={month} />}</DonorOnly>;
}

export default function CertificatePage() {
  return <Suspense><CertificateRoute /></Suspense>;
}
