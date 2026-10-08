"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ChevronLeft, ChevronRight, LogOut, Pause, Play, X } from "lucide-react";
import LunaMark from "@/components/brand/LunaMark";
import { Leader, PrintIn } from "@/components/ticket/Ticket";
import {
  DAYS,
  SLOT_COUNT,
  WINDOWS,
  dailyNeed,
  fromIndex,
  getAreaDetail,
  getMapWeek,
  windowIndex,
  windowLabel,
  windowShort,
  type AreaDetail,
  type MapWeek,
  type Snapshot,
} from "@/lib/luna/map/data";
import type { Base, Layer } from "./HexMap";
import s from "./map.module.css";
import AgentFeed from "@/components/agents/AgentFeed";

const HexMap = dynamic(() => import("./HexMap"), {
  ssr: false,
  loading: () => <div className={s.canvasLoading}>Printing the map&hellip;</div>,
});

export type Lens = "admin" | "donor" | "ngo" | "public";

const LENS: Record<Lens, { title: string; layer: Layer; intro: string }> = {
  admin: { title: "Food map", layer: "need", intro: "Where hunger isn’t being met, and when." },
  donor: { title: "Where food is short", layer: "need", intro: "Areas near you that need food most." },
  ngo: { title: "Surplus near you", layer: "surplus", intro: "Where food is given away, and when." },
  public: { title: "Bengaluru food map", layer: "need", intro: "Surplus and hunger across the city." },
};

function nowIndex() {
  const d = new Date();
  return windowIndex((d.getDay() + 6) % 7, Math.floor(d.getHours() / 3));
}

export default function MapScreen({
  lens,
  homeAreaName = null,
  onSignOut,
  backHref,
}: {
  lens: Lens;
  /** The signed-in donor's or NGO's area name, from their profile. */
  homeAreaName?: string | null;
  onSignOut?: () => void;
  backHref?: string;
}) {
  const [layer, setLayer] = useState<Layer>(LENS[lens].layer);
  const [base, setBase] = useState<Base>("printed");
  const [idx, setIdx] = useState(nowIndex);
  const [playing, setPlaying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [homeAreaId, setHomeAreaId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [week, setWeek] = useState<MapWeek | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [detail, setDetail] = useState<AreaDetail | null>(null);
  const mapPanel = useRef<HTMLDivElement>(null);

  const { day } = fromIndex(idx);
  const snapshot = useMemo<Snapshot>(() => week?.windows[idx] ?? {}, [week, idx]);
  const series = week?.series ?? [];
  const top = week?.top ?? null;
  const areaName = useMemo(() => Object.fromEntries((week?.areas ?? []).map((a) => [a.id, a.name])), [week]);

  useEffect(() => {
    let live = true;
    getMapWeek()
      .then((w) => {
        if (!live) return;
        setWeek(w);
        setLoadError(null);
        // Donors and NGOs open on their own area.
        const home = homeAreaName ? w.areas.find((a) => a.name === homeAreaName) : undefined;
        if (home) {
          setHomeAreaId(home.id);
          setSelected(home.id);
          setFocus({ id: home.id, n: 0 });
        }
      })
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [attempt, homeAreaName]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    getAreaDetail(selected)
      .then((d) => live && setDetail(d))
      .catch(() => live && setDetail(null));
    return () => {
      live = false;
    };
  }, [selected]);

  // After the sheet (and the scroll room under it) has rendered, bring the map to the top on phones.
  useEffect(() => {
    if (!sheetOpen || !selected || !window.matchMedia("(max-width: 860px)").matches) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mapPanel.current?.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }, [sheetOpen, selected]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => setIdx((i) => (i + 1) % WINDOWS), 750);
    return () => clearInterval(id);
  }, [playing]);

  const pick = (id: string, fly = true) => {
    setSelected(id);
    setSheetOpen(true);
    // On phones the sheet covers the lower half: bring the map to the top and always fly,
    // so the picked area sits in the strip above the sheet.
    const phone = window.matchMedia("(max-width: 860px)").matches;
    if (fly || phone) setFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }));
  };

  const gapsNow = Object.entries(snapshot).filter(([, w]) => w.isGap);
  const areaDetail = selected && detail?.area.id === selected ? detail : null;

  return (
    <div className={s.screen} data-sheet={sheetOpen && !!selected}>
      {/* ---------- Printer bar ---------- */}
      <header className={s.bar}>
        <div className={s.brand}>
          {backHref ? (
            <Link href={backHref} className={s.back} aria-label="Back">
              <ChevronLeft size={18} aria-hidden="true" />
            </Link>
          ) : null}
          <LunaMark size={26} title="Luna" className={s.barMark} />
          <h1 className={s.title}>
            {LENS[lens].title}
            <span className={s.city}>Bengaluru</span>
          </h1>
          <span className={s.sample}>Sample data</span>
        </div>
        <div className={s.controls}>
          <Segmented
            label="Layer"
            value={layer}
            onChange={setLayer}
            options={[
              { value: "need", label: "Need" },
              { value: "surplus", label: "Surplus" },
            ]}
          />
          <Segmented
            label="Map"
            value={base}
            onChange={setBase}
            options={[
              { value: "printed", label: "Printed" },
              { value: "streets", label: "Streets" },
            ]}
          />
        </div>
        <nav className={s.account} aria-label="Account">
        {lens === "admin" && <><Link href="/admin/reviews" className={s.barButton}>Listing reviews</Link><Link href="/deliveries" className={s.barButton}>Deliveries</Link></>}
        {onSignOut ? (
          <button type="button" className={s.barButton} onClick={onSignOut}>
            <LogOut size={15} aria-hidden="true" /> Sign out
          </button>
        ) : lens === "public" ? (
          <Link href="/login" className={s.barButton}>
            Sign in
          </Link>
        ) : null}
        </nav>
      </header>

      {/* ---------- The order rail: this week's hungriest areas ---------- */}
      <section className={s.railWrap} aria-labelledby="rail-title">
        <h2 id="rail-title" className={s.railTitle}>
          Hungriest this week
        </h2>
        <div className={s.rail}>
          <ol className={s.tickets}>
            {top === null
              ? Array.from({ length: 6 }, (_, i) => <li key={i} className={`${s.ticket} ${s.ticketBlank}`} aria-hidden="true" />)
              : top.length === 0
                ? (
                  <li className={`${s.ticket} ${s.ticketFed}`}>
                    <span className={s.tName}>All fed</span>
                    <span className={s.tNote}>No area was short this week.</span>
                  </li>
                )
                : top.map((w, i) => (
                  <li key={w.areaId}>
                    <button
                      type="button"
                      className={s.ticket}
                      data-on={selected === w.areaId}
                      data-gap={w.gapWindows > 0}
                      onClick={() => pick(w.areaId)}
                    >
                      <span className={s.tRank}>#{i + 1}</span>
                      <span className={s.tName}>{w.name}</span>
                      <span className={s.tShort}>
                        {w.short.toLocaleString("en-IN")} <small>meals short</small>
                      </span>
                      <span className={s.tWorst}>Worst {windowShort(w.worst.day, w.worst.slot)}</span>
                    </button>
                  </li>
                ))}
          </ol>
        </div>
      </section>

      {/* ---------- Map + slip ---------- */}
      <div className={s.body}>
        <div className={s.mapPanel} ref={mapPanel}>
          {week ? (
            <>
              <HexMap
                areas={week.areas}
                hexes={week.hexes}
                snapshot={snapshot}
                layer={layer}
                base={base}
                selected={selected}
                focus={focus}
                onSelect={(id) => pick(id, false)}
              />
              <Legend layer={layer} />
            </>
          ) : loadError ? (
            <div className={s.mapError} role="alert">
              <p>{loadError}</p>
              <button type="button" className={s.nowButton} onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </button>
            </div>
          ) : (
            <div className={s.canvasLoading}>Printing the map&hellip;</div>
          )}
        </div>

        <aside className={s.slipCol} data-open={sheetOpen}>
          <div className={s.slip}>
            <button type="button" className={s.sheetClose} onClick={() => setSheetOpen(false)} aria-label="Close details">
              <X size={18} aria-hidden="true" />
            </button>
            {selected && areaDetail && snapshot[selected] ? (
              <PrintIn key={`${selected}:${idx}`} lines={14}>
                <AreaSlip detail={areaDetail} window={snapshot[selected]} idx={idx} onClear={() => setSelected(null)} home={selected === homeAreaId} />
              </PrintIn>
            ) : selected ? (
              <p className={s.muted}>Printing&hellip;</p>
            ) : (
              <PrintIn key={`city:${idx}`} lines={10}>
                <CitySlip snapshot={snapshot} idx={idx} gaps={gapsNow.map(([id]) => id)} names={areaName} onPick={pick} intro={LENS[lens].intro} />
              </PrintIn>
            )}
          </div>

          {lens === "admin" && (
            <div className={s.stub}>
              <AgentFeed headingClass={s.slipHeading} />
            </div>
          )}
        </aside>
      </div>

      {/* ---------- Time tape ---------- */}
      <footer className={s.tape}>
        <div className={s.tapeControls}>
          <button type="button" className={s.iconButton} onClick={() => setIdx((i) => (i + WINDOWS - 1) % WINDOWS)} aria-label="Previous window">
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <output className={s.readout} aria-live="polite">
            {windowLabel(idx)}
          </output>
          <button type="button" className={s.iconButton} onClick={() => setIdx((i) => (i + 1) % WINDOWS)} aria-label="Next window">
            <ChevronRight size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={s.iconButton}
            data-on={playing}
            onClick={() => setPlaying((p) => !p)}
            aria-label={playing ? "Pause the week" : "Play the week"}
          >
            {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
          </button>
          <button type="button" className={s.nowButton} onClick={() => setIdx(nowIndex())}>
            Now
          </button>
        </div>
        <div className={s.strip}>
          <div className={s.bars} aria-hidden="true">
            {series.map((v, i) => (
              <span
                key={i}
                className={s.barCell}
                data-on={i === idx}
                data-daystart={i % SLOT_COUNT === 0}
                style={{ height: `${10 + (v / Math.max(...series)) * 90}%` }}
              />
            ))}
          </div>
          <input
            className={s.range}
            type="range"
            min={0}
            max={WINDOWS - 1}
            step={1}
            value={idx}
            onChange={(e) => {
              setPlaying(false);
              setIdx(Number(e.target.value));
            }}
            aria-label="Time of week"
            aria-valuetext={windowLabel(idx)}
          />
          <div className={s.days} aria-hidden="true">
            {DAYS.map((d, i) => (
              <span key={d} data-on={day === i}>
                {d}
              </span>
            ))}
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ---------- Pieces ---------- */

function Segmented<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className={s.segmented} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={s.segment}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Legend({ layer }: { layer: Layer }) {
  return (
    <div className={s.legend}>
      <span className={s.legendScale}>
        <span className={s.legendRamp} aria-hidden="true" />
        {layer === "need" ? "Meals short" : "Meals given away"}
      </span>
      <span className={s.legendItem}>
        <span className={s.swatchGap} aria-hidden="true" /> Gap spot
      </span>
      <span className={s.legendItem}>
        <span className={s.swatchNone} aria-hidden="true" /> No NGO yet
      </span>
    </div>
  );
}

function CitySlip({
  snapshot,
  idx,
  gaps,
  names,
  onPick,
  intro,
}: {
  snapshot: Snapshot;
  idx: number;
  gaps: string[];
  names: Record<string, string>;
  onPick: (id: string) => void;
  intro: string;
}) {
  const t = Object.values(snapshot).reduce(
    (acc, w) => ({ surplus: acc.surplus + w.surplus, need: acc.need + w.need, received: acc.received + w.received, short: acc.short + w.short }),
    { surplus: 0, need: 0, received: 0, short: 0 },
  );
  const n = (x: number) => x.toLocaleString("en-IN");
  return (
    <div>
      <h2 className={s.slipTitle}>Whole city</h2>
      <p className={s.slipWhen}>{windowLabel(idx)}</p>
      <p className={s.slipNote}>{intro} Pick an area on the map or a ticket on the rail.</p>
      <hr className={s.rule} />
      <h3 className={s.slipHeading}>Gap spots now</h3>
      {gaps.length === 0 ? (
        <p className={s.muted}>None in this window. Everyone who needs food is getting most of it.</p>
      ) : (
        <ul className={s.gapList}>
          {gaps.map((id) => {
            const w = snapshot[id];
            return (
              <li key={id}>
                <button type="button" className={s.gapItem} onClick={() => onPick(id)}>
                  <span>{names[id]}</span>
                  <span className={s.red}>{Math.round(w.gapRatio * 100)}% short</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <hr className={s.rule} />
      <h3 className={s.slipHeading}>Meals, whole city</h3>
      <Leader label="Surplus listed" value={n(t.surplus)} />
      <Leader label="Needed" value={n(t.need)} />
      <Leader label="Reached" value={n(t.received)} />
      <Leader label="Short" value={<span className={t.short ? s.red : undefined}>{n(t.short)}</span>} />
    </div>
  );
}


function AreaSlip({
  detail,
  window: w,
  idx,
  onClear,
  home,
}: {
  detail: AreaDetail;
  window: Snapshot[string];
  idx: number;
  onClear: () => void;
  home: boolean;
}) {
  const { area, week, trend, topDonors } = detail;
  const n = (x: number) => x.toLocaleString("en-IN");
  return (
    <div>
      <h2 className={s.slipTitle}>{area.name}</h2>
      <p className={s.slipWhen}>
        {windowLabel(idx)}
        {home && <span className={s.homeTag}>Your area</span>}
      </p>
      {w.isGap ? (
        <p className={s.gapStamp}>Gap spot · {Math.round(w.gapRatio * 100)}% short</p>
      ) : w.need === 0 ? (
        <p className={s.slipNote}>No meals needed in this window.</p>
      ) : (
        <p className={s.slipNote}>{Math.round((w.received / Math.max(w.need, 1)) * 100)}% of need reached people in this window.</p>
      )}
      <hr className={s.rule} />
      <h3 className={s.slipHeading}>Meals, this window</h3>
      <Leader label="Surplus listed" value={n(w.surplus)} />
      <Leader label="Needed" value={n(w.need)} />
      <Leader label="Reached" value={n(w.received)} />
      <Leader label="Short" value={<span className={w.isGap ? s.red : undefined}>{n(w.short)}</span>} />
      <h3 className={s.slipHeading}>Need reached, last 4 weeks</h3>
      <table className={s.trend}>
        <tbody>
          {trend.map((t) => (
            <tr key={t.label}>
              <th scope="row">{t.label}</th>
              <td>
                <span className={s.trendBar}>
                  <span style={{ width: `${Math.min(100, t.pct)}%` }} data-low={t.pct < 60} />
                </span>
              </td>
              <td className={s.trendPct}>{t.pct}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr className={s.rule} />
      <h3 className={s.slipHeading}>This week</h3>
      <Leader label="Meals short" value={n(week.short)} />
      <Leader label="Worst window" value={windowShort(week.worst.day, week.worst.slot)} />

      <hr className={s.rule} />
      <h3 className={s.slipHeading}>Top donors</h3>
      <ul className={s.plainList}>
        {topDonors.map((d) => (
          <li key={d.name}>
            <span>{d.name}</span>
            <span className={s.dim}>{KIND[d.kind]}</span>
          </li>
        ))}
      </ul>

      <h3 className={s.slipHeading}>NGOs</h3>
      {area.ngos.length === 0 ? (
        <p className={s.muted}>
          No NGO here yet. Need is estimated from population: about {n(dailyNeed(area))} meals a day.
        </p>
      ) : (
        <ul className={s.plainList}>
          {area.ngos.map((g) => (
            <li key={g.name}>
              <span>{g.name}</span>
              <span className={s.dim}>
                {g.type} · {g.mealsPerDay}/day{g.fridge ? " · fridge" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}


      <button type="button" className={s.linkButton} onClick={onClear}>
        Back to whole city
      </button>
    </div>
  );
}

const KIND = { restaurant: "Restaurant", caterer: "Caterer", hotel: "Hotel", household: "Household" } as const;
