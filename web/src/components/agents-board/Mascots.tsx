"use client";

import { useId, type ReactNode } from "react";
import type { AgentName } from "@/lib/luna/console";
import m from "./mascots.module.css";

/**
 * The four agents as die-cut stickers stuck on their printers: a pizza slice (Food), a chef's hat (Decision),
 * a tiffin (NGO) and a delivery scooter (Logistics). The one place colour lives on the agents board.
 * Each sticker's face follows what its agent is doing; the white die-cut edge is a filter, so it hugs any shape.
 */

export type Mood = "sleep" | "awake" | "busy" | "think" | "happy" | "worried";

const INK = "#1b1b1b";
const CHEEK = "#ff8fa3";
const MOUTH = "#8c2f1e";

function Face({ x, y, mood }: { x: number; y: number; mood: Mood }) {
  const open = mood === "awake" || mood === "busy" || mood === "worried";
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse cx={-15} cy={7.5} rx={4.6} ry={2.8} fill={CHEEK} opacity={0.8} />
      <ellipse cx={15} cy={7.5} rx={4.6} ry={2.8} fill={CHEEK} opacity={0.8} />
      {open && (
        <g className={m.eyes}>
          {[-9, 9].map((ex) => (
            <g key={ex}>
              <ellipse cx={ex} cy={0} rx={3.4} ry={mood === "worried" ? 3.8 : 4.4} fill={INK} />
              <circle cx={ex + 1.2} cy={-1.6} r={1.35} fill="#fff" />
            </g>
          ))}
        </g>
      )}
      {mood === "think" &&
        [-9, 9].map((ex) => (
          <g key={ex}>
            <ellipse cx={ex} cy={0} rx={3.4} ry={4.4} fill={INK} />
            <circle cx={ex + 1.4} cy={-2.4} r={1.5} fill="#fff" />
          </g>
        ))}
      {mood === "sleep" && <path d="M-12.5 0.5q3.5 3.2 7 0M5.5 0.5q3.5 3.2 7 0" fill="none" stroke={INK} strokeWidth={2.4} strokeLinecap="round" />}
      {mood === "happy" && <path d="M-12.5 2q3.5-5 7 0M5.5 2q3.5-5 7 0" fill="none" stroke={INK} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />}
      {mood === "worried" && <path d="M-13-7.5l7 2.2M13-7.5l-7 2.2" stroke={INK} strokeWidth={2} strokeLinecap="round" />}

      {mood === "awake" && <path d="M-3.5 6q3.5 3.6 7 0" fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" />}
      {mood === "busy" && <path d="M-4 5.5q4 5 8 0z" fill={MOUTH} stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />}
      {mood === "think" && <ellipse cx={2.5} cy={8} rx={2} ry={1.7} fill={INK} />}
      {mood === "sleep" && <ellipse cx={0} cy={8} rx={1.8} ry={1.4} fill={INK} />}
      {mood === "happy" && (
        <g>
          <path d="M-5.5 5q5.5 8 11 0z" fill={MOUTH} stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
          <ellipse cx={0} cy={9} rx={2.6} ry={1.4} fill={CHEEK} />
        </g>
      )}
      {mood === "worried" && <path d="M-4.5 8.5q2.25-2.4 4.5 0q2.25 2.4 4.5 0" fill="none" stroke={INK} strokeWidth={2} strokeLinecap="round" />}
    </g>
  );
}

/* ---------- the four bodies, drawn on a 120 × 120 sheet ---------- */

function Pizza({ mood }: { mood: Mood }) {
  return (
    <>
      <path d="M22 38C44 30 76 30 98 38L64 107.5C62 111.5 58 111.5 56 107.5Z" fill="#ffd15a" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <path d="M31 47q1.5 9 5 9t3-8" fill="#ffe28f" />
      <path d="M78 46q2 7 4.5 7t2.5-6" fill="#ffe28f" />
      <circle cx={34} cy={50} r={6.5} fill="#e4573d" stroke={INK} strokeWidth={2} />
      <circle cx={32.5} cy={48.5} r={1.6} fill="#f39a82" />
      <circle cx={87} cy={50} r={6} fill="#e4573d" stroke={INK} strokeWidth={2} />
      <circle cx={85.5} cy={48.5} r={1.5} fill="#f39a82" />
      <circle cx={60} cy={91} r={5.5} fill="#e4573d" stroke={INK} strokeWidth={2} />
      <path d="M66 80q5-8 13-4.5q-4 8-13 4.5z" fill="#4caf50" stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M14 30C36 14 84 14 106 30C108 38 102 42 96 40C76 30 44 30 24 40C18 42 12 38 14 30Z" fill="#e59a3f" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <path d="M27 27C45 20.5 75 20.5 93 27" fill="none" stroke="#f7c27a" strokeWidth={3} strokeLinecap="round" />
      <Face x={60} y={62} mood={mood} />
    </>
  );
}

function ChefHat({ mood }: { mood: Mood }) {
  const puffs: [number, number, number][] = [
    [36, 44, 18],
    [60, 31, 22],
    [84, 44, 18],
    [48, 50, 16],
    [72, 50, 16],
  ];
  return (
    <>
      {/* Stroked under, filled over: one outline around the whole puff. */}
      {puffs.map(([cx, cy, r]) => (
        <circle key={`o${cx}${cy}`} cx={cx} cy={cy} r={r} fill={INK} stroke={INK} strokeWidth={6} />
      ))}
      {puffs.map(([cx, cy, r]) => (
        <circle key={`f${cx}${cy}`} cx={cx} cy={cy} r={r} fill="#fff" />
      ))}
      <path d="M45 26q5 10 3 22M73 26q-5 10-3 22M28 40q3 6 9 9M92 40q-3 6-9 9" fill="none" stroke="#dde2ee" strokeWidth={2.5} strokeLinecap="round" />
      <rect x={31} y={52} width={58} height={42} rx={7} fill="#fff" stroke={INK} strokeWidth={3} />
      <path d="M34 86h52" stroke="#e7ebf4" strokeWidth={6} strokeLinecap="round" />
      <path d="M43 93L77 93L60 111Z" fill="#f2668b" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <circle cx={60} cy={95} r={4.8} fill="#f2668b" stroke={INK} strokeWidth={2.5} />
      <Face x={60} y={70} mood={mood} />
    </>
  );
}

function Tiffin({ mood }: { mood: Mood }) {
  return (
    <>
      <path d="M33 32V25C33 8 87 8 87 25V32" fill="none" stroke={INK} strokeWidth={7.5} strokeLinecap="round" />
      <path d="M33 32V25C33 8 87 8 87 25V32" fill="none" stroke="#c8d0d4" strokeWidth={3} strokeLinecap="round" />
      <circle cx={60} cy={12.5} r={4.2} fill="#e58a4e" stroke={INK} strokeWidth={2} />
      <rect x={17} y={56} width={9} height={20} rx={3} fill="#c8d0d4" stroke={INK} strokeWidth={2} />
      <rect x={94} y={56} width={9} height={20} rx={3} fill="#c8d0d4" stroke={INK} strokeWidth={2} />
      {[28, 54, 80].map((y) => (
        <rect key={y} x={24} y={y} width={72} height={26} rx={9} fill="#29b0a1" stroke={INK} strokeWidth={3} />
      ))}
      <path d="M31 34h11M31 60h8M31 86h8" stroke="rgba(255,255,255,0.6)" strokeWidth={3} strokeLinecap="round" />
      <rect x={28} y={24} width={64} height={8} rx={4} fill="#1f9486" stroke={INK} strokeWidth={2.5} />
      <rect x={21} y={51} width={78} height={6} rx={3} fill="#e58a4e" stroke={INK} strokeWidth={2} />
      <rect x={21} y={77} width={78} height={6} rx={3} fill="#e58a4e" stroke={INK} strokeWidth={2} />
      <Face x={60} y={65} mood={mood} />
    </>
  );
}

function Scooter({ mood }: { mood: Mood }) {
  return (
    <>
      <path d="M80 66L75 31" stroke={INK} strokeWidth={6} strokeLinecap="round" />
      <path d="M67 30L84 27.5" stroke={INK} strokeWidth={5.5} strokeLinecap="round" />
      <circle cx={80.5} cy={45} r={5} fill="#ffe27a" stroke={INK} strokeWidth={2} />
      <rect x={9} y={27} width={37} height={29} rx={4} fill="#ff8a5b" stroke={INK} strokeWidth={3} />
      <path d="M9 35.5h37" stroke={INK} strokeWidth={2} />
      <path d="M18 45h19" stroke="rgba(255,255,255,0.7)" strokeWidth={3.5} strokeLinecap="round" />
      <path d="M16 88C14 70 28 59 46 59L70 59C84 59 97 69 101 84L101 88Z" fill="#3d7ff0" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <path d="M26 72q4-8 14-9" fill="none" stroke="#8fb6ff" strokeWidth={3} strokeLinecap="round" />
      <rect x={24} y={53} width={30} height={8} rx={4} fill="#2b2f36" stroke={INK} strokeWidth={2} />
      {[32, 90].map((cx) => (
        <g key={cx}>
          <circle cx={cx} cy={95} r={13} fill={INK} />
          <circle cx={cx} cy={95} r={5} fill="#c9cdd2" />
        </g>
      ))}
      <Face x={58} y={72} mood={mood} />
    </>
  );
}

const BODY: Record<AgentName, (p: { mood: Mood }) => ReactNode> = { food: Pizza, decision: ChefHat, ngo: Tiffin, logistics: Scooter };

/** Little ink marks around a sticker that say what the face is doing. Off the sticker, so no die-cut edge. */
function Marks({ mood }: { mood: Mood }) {
  if (mood === "sleep")
    return (
      <g className={m.zzz} fill="none" stroke={INK} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M98 22h8l-8 9h8" />
        <path d="M108 6h6l-6 7h6" />
      </g>
    );
  if (mood === "think")
    return (
      <g className={m.dots} fill="#fff" stroke={INK} strokeWidth={1.8}>
        <circle cx={99} cy={28} r={2.6} />
        <circle cx={106} cy={18} r={3.6} />
        <circle cx={114} cy={6} r={4.8} />
      </g>
    );
  if (mood === "busy")
    return (
      <g className={m.lines} stroke={INK} strokeWidth={2.4} strokeLinecap="round">
        <path d="M101 20l7-6M105 32l9-2M97 10l3-8" />
      </g>
    );
  if (mood === "worried") return <path className={m.drop} d="M17 14q-6 9-6 12a6 6 0 0 0 12 0q0-3-6-12z" fill="#fff" stroke={INK} strokeWidth={1.8} strokeLinejoin="round" />;
  if (mood === "happy")
    return (
      <g className={m.sparkle} fill={INK} stroke={INK} strokeWidth={1.4} strokeLinejoin="round">
        <path d="M104 10l2.4 5.6 5.6 2.4-5.6 2.4-2.4 5.6-2.4-5.6-5.6-2.4 5.6-2.4z" />
        <path d="M14 18l1.6 3.4 3.4 1.6-3.4 1.6-1.6 3.4-1.6-3.4-3.4-1.6 3.4-1.6z" />
      </g>
    );
  return null;
}

/** `line`: the same drawing in one ink with paper fills, for mascots printed on paper or the counter rather than stuck on a printer. */
export function Mascot({ agent, mood = "awake", size = 76, marks = true, line = false, className }: { agent: AgentName; mood?: Mood; size?: number; marks?: boolean; line?: boolean; className?: string }) {
  const id = useId().replace(/:/g, "");
  const Body = BODY[agent];
  return (
    <svg className={`${m.mascot} ${line ? m.line : ""} ${className ?? ""}`} data-mood={mood} data-agent={agent} width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" overflow="visible">
      <defs>
        <filter id={`cut${id}`} x={-20} y={-20} width={160} height={160} filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feMorphology in="SourceAlpha" operator="dilate" radius={size < 40 ? 7 : 5.5} result="grow" />
          <feFlood floodColor="#ffffff" />
          <feComposite in2="grow" operator="in" result="edge" />
          <feDropShadow in="edge" dx={0} dy={2.2} stdDeviation={1.8} floodColor="#141614" floodOpacity={0.3} result="lifted" />
          <feMerge>
            <feMergeNode in="lifted" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g className={m.body} filter={line ? undefined : `url(#cut${id})`}>
        <Body mood={mood} />
      </g>
      {marks && <Marks mood={mood} />}
    </svg>
  );
}
