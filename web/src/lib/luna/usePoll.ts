"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { useLive } from "./live";

/**
 * Loads `fetcher` now and every `everyMs` while the page is visible, so offers,
 * countdowns and trips stay live. `reload()` refreshes straight after an action.
 */
export function usePoll<T>(fetcher: () => Promise<T>, everyMs = 4000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef(fetcher);
  useEffect(() => {
    ref.current = fetcher;
  });

  const reload = useCallback(async () => {
    try {
      setData(await ref.current());
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Your sign-in has expired. Sign out and sign in again." : (err as Error).message);
    }
  }, []);

  // Pushed by the agents the moment something changes; the interval is only a backstop.
  useLive(() => void reload());

  useEffect(() => {
    let stopped = false;
    const run = () => {
      if (!stopped && document.visibilityState === "visible") void reload();
    };
    run();
    const id = setInterval(run, everyMs);
    document.addEventListener("visibilitychange", run);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", run);
    };
  }, [reload, everyMs]);

  return { data, error, reload };
}

/** Current time, ticking every second, for countdowns. */
export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
