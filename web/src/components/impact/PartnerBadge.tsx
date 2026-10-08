"use client";

import { useRef } from "react";
import { Download } from "lucide-react";
import s from "./impact.module.css";

const sinceLabel = (ms: number) => new Date(ms).toLocaleDateString("en-IN", { month: "short", year: "numeric" }).toUpperCase();

/**
 * The "Luna Partner" badge (SRS §9): a rubber-stamp roundel for the shop window and the restaurant's
 * Zomato / Swiggy listing, earned with its first donation that reached an NGO. Two inks; downloads as SVG
 * (any size) or PNG.
 */
export default function PartnerBadge({ name, since, meals }: { name: string; since: number; meals: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const file = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "restaurant";

  const source = () => {
    const el = svg.current!.cloneNode(true) as SVGSVGElement;
    el.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(el);
  };
  const save = (blob: Blob, ext: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `luna-partner-${file}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const svgFile = () => save(new Blob([source()], { type: "image/svg+xml" }), "svg");
  const pngFile = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 1200;
      const g = c.getContext("2d")!;
      g.fillStyle = "#fbfaf6";
      g.fillRect(0, 0, 1200, 1200);
      g.drawImage(img, 0, 0, 1200, 1200);
      c.toBlob((b) => b && save(b, "png"), "image/png");
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source())}`;
  };

  const ink = "#1b1b1b", paper = "#fbfaf6";
  return (
    <section className={s.badgeCard} aria-labelledby="badge-title">
      <h2 id="badge-title">Luna Partner badge</h2>
      <svg ref={svg} className={s.badge} viewBox="0 0 400 400" role="img" aria-label={`Luna Partner badge for ${name}, since ${sinceLabel(since)}`}>
        <defs>
          <path id="ring-top" d="M 70 200 A 130 130 0 0 1 330 200" />
          <path id="ring-bottom" d="M 52 200 A 148 148 0 0 0 348 200" />
          <clipPath id="moon-left"><rect x="150" y="96" width="48" height="104" /></clipPath>
          <clipPath id="moon-right"><rect x="204" y="96" width="48" height="104" /></clipPath>
        </defs>
        <circle cx="200" cy="200" r="192" fill={paper} stroke={ink} strokeWidth="8" />
        <circle cx="200" cy="200" r="172" fill="none" stroke={ink} strokeWidth="2.5" />
        <circle cx="200" cy="200" r="112" fill={ink} />
        <text fill={ink} fontFamily="'Martian Mono', ui-monospace, monospace" fontWeight="800" fontSize="25" letterSpacing="5">
          <textPath href="#ring-top" startOffset="50%" textAnchor="middle">LUNA PARTNER</textPath>
        </text>
        <text fill={ink} fontFamily="'Martian Mono', ui-monospace, monospace" fontWeight="700" fontSize="14" letterSpacing="2.5">
          <textPath href="#ring-bottom" startOffset="50%" textAnchor="middle">ZERO-WASTE · SINCE {sinceLabel(since)}</textPath>
        </text>
        {/* the Luna mark: surplus (solid) and need (outline), one moon torn in two */}
        <circle cx="200" cy="148" r="40" fill={paper} clipPath="url(#moon-left)" />
        <circle cx="200" cy="148" r="38.5" fill="none" stroke={paper} strokeWidth="3" clipPath="url(#moon-right)" />
        <text x="200" y="232" textAnchor="middle" fill={paper} fontFamily="'Martian Mono', ui-monospace, monospace" fontWeight="800" fontSize={name.length > 16 ? 15 : 19} letterSpacing="1">
          {name.toUpperCase().slice(0, 26)}
        </text>
        <text x="200" y="262" textAnchor="middle" fill={paper} fontFamily="'Martian Mono', ui-monospace, monospace" fontSize="13" letterSpacing="2">
          {meals} MEALS SHARED
        </text>
      </svg>
      <p className={s.note}>For your shop window and your Zomato or Swiggy page: customers see you give your surplus food to people who need it.</p>
      <div className={s.badgeActions}>
        <button type="button" className={s.outlineButton} onClick={svgFile}><Download size={16} aria-hidden /> SVG, any size</button>
        <button type="button" className={s.outlineButton} onClick={pngFile}><Download size={16} aria-hidden /> PNG</button>
      </div>
    </section>
  );
}
