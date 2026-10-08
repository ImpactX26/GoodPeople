/**
 * Bengaluru clock. The server runs in UTC on Railway, but serving times, gap
 * windows and every time shown in a message are India time (UTC+5:30, no DST).
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** Day of week with Monday = 0 (matches map/model.ts DAYS), and minutes since local midnight. */
export function istClock(ms: number) {
  const local = new Date(ms + IST_OFFSET_MS);
  return {
    day: (local.getUTCDay() + 6) % 7,
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
    hour: local.getUTCHours(),
  };
}

/** Start of the local day containing `ms`, as epoch ms. */
export function istMidnight(ms: number) {
  return Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/** "20:00" → minutes since midnight. */
export function parseClock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/** The first of `times` ("13:00", "20:00") at or after `ms`, looking up to a day ahead. */
export function nextClockTime(ms: number, times: string[]) {
  const base = istMidnight(ms);
  let best = Infinity;
  for (const t of times) {
    for (const day of [0, 1]) {
      const at = base + day * DAY_MS + parseClock(t) * 60_000;
      if (at >= ms && at < best) best = at;
    }
  }
  return best;
}

/** "8:05 pm" in India time. */
export function fmtTime(ms: number) {
  const { minutes } = istClock(ms);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

export function fmtMinutes(ms: number) {
  if (ms > 0 && ms < 120_000 && ms % 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60 ? `${min % 60} min` : ""}`.trim();
}
