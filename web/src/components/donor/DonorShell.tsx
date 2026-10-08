"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import LunaMark from "@/components/brand/LunaMark";
import s from "./donor.module.css";

/** Donor screens: the printer bar on top, the work below. */
export default function DonorShell({ title, back, right, children }: {
  title: string; back?: { label: string; href?: string; onClick?: () => void }; right?: ReactNode; children: ReactNode;
}) {
  return (
    <div className={s.shell}>
      <header className={s.bar}>
        {back && (back.href
          ? <Link href={back.href} className={s.barBack}><ArrowLeft size={18} aria-hidden /><span>{back.label}</span></Link>
          : <button type="button" onClick={back.onClick} className={s.barBack}><ArrowLeft size={18} aria-hidden /><span>{back.label}</span></button>)}
        <span className={s.barBrand}><LunaMark size={22} title={null} className={s.barMark} /><b>LUNA</b></span>
        <h1 className={s.barTitle}>{title}</h1>
        <span className={s.barRight}>{right}</span>
      </header>
      <main className={s.main}>{children}</main>
    </div>
  );
}
