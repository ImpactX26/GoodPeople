"use client";

import { useEffect, useRef, useState } from "react";
import { API_URL, api, ApiError } from "./api";
import type { Session } from "./auth";
import { usePickupNotifications } from "@/components/trip/PartnerNotifications";
import { PARTNER_ACCESS_REVOKED_EVENT, PARTNER_SNAPSHOT_EVENT, type PartnerSnapshot } from "./usePartnerRequests";
import { offlineCodeMatches, readTripCache, writeTripCache, TRIP_CONFIG as C, type TripCache, type TripPoint, type TripView, type QueuedAction } from "./trip";

export function useTrip(id: string, session: Session) {
  const notifications = usePickupNotifications();
  const [trip, setTrip] = useState<TripView | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsEnabled, setGpsEnabled] = useState(false);
  const cache = useRef<TripCache>({ trip: null, queue: [], codeTries: { pickup: 0, drop: 0 } });
  const raw = useRef<TripPoint | null>(null);
  const flushing = useRef(false), cacheReady = useRef(false);
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const key = `${session.role}:${session.phone}:${id}`;
  const persist = async () => {
    try { await writeTripCache(key, structuredClone(cache.current)); }
    catch { setError("Offline storage is unavailable. Keep your connection active to avoid losing delivery updates."); }
  };
  const apply = (value: TripView) => {
    if (cache.current.trip && cache.current.trip.version > value.version) return;
    if (cache.current.trip && cache.current.trip.routeRevision !== value.routeRevision) {
      cache.current.queue = cache.current.queue.filter(a => a.action === "location");
      cache.current.codeTries = { pickup: 0, drop: 0 }; setPending(cache.current.queue.length);
      setError("The destination has changed. Follow the updated route and ask the new NGO for its code.");
    }
    cache.current.trip = value;
    // A server snapshot must not undo a locally completed handover awaiting sync.
    if (!cache.current.queue.some(a => a.action !== "location")) setTrip(session.role === "volunteer" && raw.current && raw.current.at > (value.location?.at ?? 0) && value.locationVisible ? { ...value, location: raw.current } : value);
    void persist();
  };
  const refresh = async () => { const value = await api<TripView>(`/trips/${id}`, { token: session.token }); apply(value); return value; };
  const flush = async () => {
    if (flushing.current || !navigator.onLine || !cacheReady.current) return;
    flushing.current = true;
    try {
      while (cache.current.queue.length) {
        const action = cache.current.queue[0];
        try {
          const value = await api<TripView>(`/partner/legs/${id}/${action.action}`, {
            method: "POST", token: session.token, headers: { "Idempotency-Key": action.key }, body: JSON.stringify(action.body),
          });
          cache.current.queue.shift(); cache.current.trip = value;
          setPending(cache.current.queue.length); await persist();
          if (!cache.current.queue.some(a => a.action !== "location")) setTrip(value);
        } catch (e) {
          if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
            if (action.action === "code" && e.message.startsWith("Incorrect code.")) {
              cache.current.queue.shift(); setPending(cache.current.queue.length); await persist(); setError(e.message); continue;
            }
            // A rejected offline transition invalidates dependent actions. Restore server truth.
            cache.current.queue = cache.current.queue.filter(a => a !== action && a.action === "location");
            setPending(cache.current.queue.length); await persist();
            setError(`${e.message} Queued handovers were stopped; check the delivery step before continuing.`);
            try { const value = await refresh(); setTrip(value); } catch {}
          } else { setConnected(false); break; }
        }
      }
      if (!cache.current.queue.length) await refresh().catch(() => {});
    } finally { flushing.current = false; }
  };
  useEffect(() => { flushRef.current = flush; });

  useEffect(() => {
    if (session.role !== "volunteer") return;
    const receive = (event: Event) => {
      const data = (event as CustomEvent<PartnerSnapshot>).detail;
      const current = data.leg?.id === id ? data.leg : data.requests.find(t => t.id === id);
      if (current) apply(current);
      else if (data.withdrawn.some(t => t.id === id) && cache.current.trip?.requestStatus === "pending") {
        cache.current = { trip: null, queue: [], codeTries: { pickup: 0, drop: 0 } }; setTrip(null); setPending(0);
        setError("Taken by someone else, thanks!"); void persist();
      }
    };
    const revoke = () => {
      cache.current = { trip: null, queue: [], codeTries: { pickup: 0, drop: 0 } }; raw.current = null;
      setTrip(null); setPending(0); setError("Sign in again to access this delivery."); void persist();
    };
    window.addEventListener(PARTNER_SNAPSHOT_EVENT, receive);
    window.addEventListener(PARTNER_ACCESS_REVOKED_EVENT, revoke);
    return () => { window.removeEventListener(PARTNER_SNAPSHOT_EVENT, receive); window.removeEventListener(PARTNER_ACCESS_REVOKED_EVENT, revoke); };
    // The global volunteer subscription shares one connection across home and navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, session.role]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout>;
    const revoke = () => {
      cancelled = true; controller.abort(); setTrip(null); setConnected(false); setPending(0); raw.current = null;
      cache.current = { trip: null, queue: [], codeTries: { pickup: 0, drop: 0 } }; void persist();
      setError("This delivery is no longer available to your account.");
    };
    const connect = async () => {
      if (cancelled) return;
      try {
        const response = await fetch(`${API_URL}/trips/${id}/stream`, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal, cache: "no-store" });
        if (!response.ok || !response.body) {
          if ([401, 403, 404].includes(response.status)) { revoke(); return; }
          throw new Error("Live updates unavailable.");
        }
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let buffer = "";
        setConnected(true); void flushRef.current();
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (frame.includes("event: access_revoked")) { revoke(); return; }
            if (frame.includes("event: snapshot")) {
              const data = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
              apply(JSON.parse(data) as TripView); setConnected(true);
            }
          }
        }
      } catch { /* Reconnect with an authoritative snapshot after network drops. */ }
      if (!cancelled) { setConnected(false); reconnectTimer = setTimeout(connect, C.reconnectMs); }
    };
    void (async () => {
      try {
        const stored = await readTripCache(key);
        if (stored && (!stored.trip?.closedAt || Date.now() - stored.trip.closedAt < C.locationRetentionMs)) {
          cache.current = stored;
          let localTrip = stored.trip;
          for (const a of stored.queue) {
            if (!localTrip) break;
            if (a.action === "arrived") localTrip = { ...localTrip, status: a.body.kind === "pickup" ? "at_pickup" : "at_drop" };
            if (a.action === "code") {
              const kind = a.body.kind as "pickup" | "drop", verifier = localTrip.offlineCodes?.[kind];
              if (verifier && await offlineCodeMatches(verifier.salt, verifier.hash, String(a.body.code))) localTrip = { ...localTrip, status: kind === "pickup" ? "picked_up" : "delivered", ...(kind === "drop" ? { closedAt: Number(a.body.occurredAt) } : {}) };
            }
            if (a.action === "pickup-check") localTrip = { ...localTrip, status: "to_drop" };
          }
          setTrip(localTrip); setPending(stored.queue.length);
        }
      } catch { setError("Offline storage is unavailable. Keep your connection active."); }
      if (cancelled) return;
      cacheReady.current = true;
      if (session.role === "volunteer") void refresh().catch(e => { if (!cancelled) setError((e as Error).message); });
      else void connect();
    })();
    const online = () => { void flushRef.current(); };
    const retry = setInterval(online, C.locationSendMs);
    window.addEventListener("online", online);
    return () => { cancelled = true; controller.abort(); clearTimeout(reconnectTimer); clearInterval(retry); window.removeEventListener("online", online); };
    // Stable lifetime per signed-in delivery; callbacks use refs for the current queue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key, session.token, session.role]);

  const enqueue = async (action: string, body: Record<string, unknown>, status?: TripView["status"]) => {
    if (!cacheReady.current) throw new Error("Wait for the delivery to load.");
    const item: QueuedAction = { key: crypto.randomUUID(), action, body: { ...body, occurredAt: Date.now(), routeRevision: cache.current.trip?.routeRevision ?? 1 } };
    cache.current.queue.push(item); setPending(cache.current.queue.length);
    // Durably record before acknowledging a local handover.
    try { await writeTripCache(key, structuredClone(cache.current)); }
    catch { cache.current.queue = cache.current.queue.filter(a => a !== item); setPending(cache.current.queue.length); throw new Error("Could not save this action. Check your connection and retry."); }
    if (status) setTrip(value => value ? { ...value, status, ...(status === "delivered" ? { closedAt: Date.now(), location: null } : {}) } : value);
    if (action === "sample-location") raw.current = body.point as TripPoint;
    await flushRef.current();
  };

  const active = session.role === "volunteer" && trip?.requestStatus === "accepted" && !trip.closedAt;
  useEffect(() => {
    if (!gpsEnabled || !active) return;
    if (!navigator.geolocation) { queueMicrotask(() => setGpsError("Location is unavailable on this device.")); return; }
    const watch = navigator.geolocation.watchPosition(position => {
      const { latitude, longitude, accuracy, speed, heading } = position.coords;
      raw.current = { lat: latitude, lng: longitude, accuracyM: accuracy, speedMps: speed, heading, at: position.timestamp };
      if (accuracy > C.maxAccuracyM) { setGpsError("GPS accuracy is low. Move somewhere with a clear view of the sky."); return; }
      setGpsError(null);
      setTrip(current => current ? { ...current, location: raw.current } : current);
      const locationActions = cache.current.queue.filter(a => a.action === "location");
      const count = cache.current.queue.filter(a => a.action === "location").reduce((n, a) => n + (a.body.points as TripPoint[]).length, 0);
      if (count >= C.maxQueue) { setGpsError("Location storage is full. Reconnect to sync the buffered locations."); return; }
      const tail = locationActions.at(-1), points = tail?.body.points as TripPoint[] | undefined;
      // Freeze keys once sent: a changed batch must never reuse an idempotency key.
      if (points && points.length < C.maxBatch && !(flushing.current && tail === cache.current.queue[0])) points.push(raw.current);
      else cache.current.queue.push({ key: crypto.randomUUID(), action: "location", body: { points: [raw.current] } });
      setPending(cache.current.queue.length); void persist();
    }, e => setGpsError(e.code === 1 ? "Location permission was denied. Enable it in your browser settings." : "Waiting for GPS. Keep the app open."),
    { enableHighAccuracy: true, maximumAge: 0, timeout: C.staleMs });
    let stopped = false;
    void navigator.wakeLock?.request("screen").then(lock => {
      if (stopped) void lock.release();
      else wakeLock = lock;
    }).catch(() => {});
    let wakeLock: WakeLockSentinel | undefined;
    return () => { stopped = true; navigator.geolocation.clearWatch(watch); void wakeLock?.release(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gpsEnabled, active, key]);
  return { trip, connected: session.role === "volunteer" ? notifications.connected : connected, error, pending, gpsError, gpsEnabled, enableGps: () => setGpsEnabled(true),
    raw, enqueue, cache, setError, refresh, apply };
}
