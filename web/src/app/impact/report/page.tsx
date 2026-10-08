"use client";

import DonorOnly from "@/components/impact/DonorOnly";
import Report from "@/components/impact/Report";

export default function ReportPage() {
  return <DonorOnly title="CSR / ESG report">{(s) => <Report session={s} />}</DonorOnly>;
}
