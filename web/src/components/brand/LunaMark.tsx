"use client";

import { useId } from "react";
import s from "./mark.module.css";

/** The seam the halves share: the ticket's tear edge. */
const LEFT = "0,0 110,0 100,8 110,16 100,24 110,32 100,40 110,48 100,56 110,64 100,72 110,80 100,88 110,96 100,104 110,112 100,120 110,128 100,136 110,144 100,152 110,160 100,168 110,176 100,184 110,192 100,200 0,200";
const SEAM = LEFT.split(" ").slice(1, -1).join(" ");
const RIGHT = "200,0 110,0 100,8 110,16 100,24 110,32 100,40 110,48 100,56 110,64 100,72 110,80 100,88 110,96 100,104 110,112 100,120 110,128 100,136 110,144 100,152 110,160 100,168 110,176 100,184 110,192 100,200 200,200";

export type MarkState = "apart" | "full" | "logo" | "joined";

/**
 * Luna's mark: one moon torn into two halves. The solid half is surplus,
 * the outlined half is need.
 *   apart  – halves far away
 *   full   – one solid moon, the tear showing as a paper seam (the intro roll)
 *   logo   – the resting logo, a small gap between the halves
 *   joined – halves meet and the empty half fills: food matched
 * Changing `state` animates between them.
 */
export default function LunaMark({
  size = 64,
  state = "logo",
  title = "Luna",
  className = "",
}: {
  size?: number;
  state?: MarkState;
  title?: string | null;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      className={`${s.mark} ${className}`}
      data-state={state}
      width={size}
      height={size}
      viewBox="-8 0 216 200"
      role={title ? "img" : undefined}
      aria-label={title ?? undefined}
      aria-hidden={title ? undefined : true}
    >
      <defs>
        <clipPath id={`${id}l`}>
          <polygon points={LEFT} />
        </clipPath>
        <clipPath id={`${id}r`}>
          <polygon points={RIGHT} />
        </clipPath>
        <mask id={`${id}f`} maskUnits="userSpaceOnUse" x="0" y="0" width="200" height="200">
          <rect className={s.fillRise} x="0" y="0" width="200" height="200" fill="#fff" />
        </mask>
      </defs>
      <g className={s.left}>
        <circle cx="100" cy="100" r="92" fill="currentColor" clipPath={`url(#${id}l)`} />
      </g>
      <g className={s.right}>
        <g clipPath={`url(#${id}r)`}>
          <circle cx="100" cy="100" r="90" fill="none" stroke="currentColor" strokeWidth="4" />
          <circle cx="100" cy="100" r="92" fill="currentColor" mask={`url(#${id}f)`} />
        </g>
      </g>
      <polyline className={s.seam} points={SEAM} fill="none" strokeWidth="5" strokeLinejoin="miter" />
    </svg>
  );
}
