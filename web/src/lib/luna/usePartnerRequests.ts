"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { API_URL } from "./api";
import type { Session } from "./auth";
import { TRIP_CONFIG as C, type TripView } from "./trip";
export const PARTNER_SNAPSHOT_EVENT = "luna:partner-snapshot";
export const PARTNER_ACCESS_REVOKED_EVENT = "luna:partner-access-revoked";
export interface PartnerSnapshot { requests: TripView[]; leg: TripView | null; withdrawn: { id: string; reason: string }[] }

export function usePartnerRequests(session: Session) {
  const router = useRouter();
  const [requests, setRequests] = useState<TripView[]>([]), [notice, setNotice] = useState(""), [connected, setConnected] = useState(false);
  const [leg, setLeg] = useState<TripView | null>(null), [withdrawn, setWithdrawn] = useState<{ id: string; reason: string }[]>([]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    let previousLeg: TripView | null = null, latestRequests: TripView[] = [];
    const controller = new AbortController();
    const publish = (data: PartnerSnapshot) => {
      const value = data.leg;
      previousLeg = value && previousLeg?.id === value.id && previousLeg.routeRevision === value.routeRevision && previousLeg.status === value.status && !value.closedAt && !value.route ? { ...value, route: previousLeg.route, routeError: previousLeg.routeError } : value;
      setLeg(previousLeg); latestRequests = data.requests;
      window.dispatchEvent(new CustomEvent<PartnerSnapshot>(PARTNER_SNAPSHOT_EVENT, { detail: { ...data, leg: previousLeg } }));
    };
    const connect = async () => {
      try {
        const response = await fetch(`${API_URL}/partner/requests/stream`, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal });
        if ([401, 403].includes(response.status)) {
          setRequests([]); setLeg(null); setConnected(false); setNotice("Sign in again to receive pickup requests.");
          window.dispatchEvent(new Event(PARTNER_ACCESS_REVOKED_EVENT)); return;
        }
        if (!response.ok || !response.body) throw new Error("Pickup alerts unavailable.");
        const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
        setConnected(true);
        while (!cancelled) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            if (!frame.includes("event: snapshot") && !frame.includes("event: leg")) continue;
            const payload = JSON.parse(frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n"));
            if (frame.includes("event: leg")) { publish({ leg: payload as TripView, requests: latestRequests, withdrawn: [] }); continue; }
            const data = payload as PartnerSnapshot;
            publish(data);
            setWithdrawn(data.withdrawn);
            setRequests(data.requests);
            for (const request of data.requests) if (!seen.current.has(request.id)) {
              seen.current.add(request.id); const message = `New pickup: ${request.food}, ${request.servings} servings. ${request.pickupArea} → ${request.dropArea}.`;
              setNotice(message);
              if (typeof Notification !== "undefined" && Notification.permission === "granted") { const notification = new Notification("Luna · pickup request", { body: message, tag: request.id }); notification.onclick = () => { window.focus(); router.push(`/deliveries?id=${request.id}`); notification.close(); }; }
            }
            for (const withdrawn of data.withdrawn) setNotice(withdrawn.reason);
          }
        }
      } catch { /* The stream reconnects with the current set of requests. */ }
      if (!cancelled) { setConnected(false); timer = setTimeout(connect, C.reconnectMs); }
    };
    void connect(); return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [session.token, router]);
  return { requests, notice, connected, leg, withdrawn };
}
