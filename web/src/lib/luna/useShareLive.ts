"use client";

/**
 * A delivery's live map (GET /agents/shares/:id/live, Server-Sent Events over fetch so the token stays in a
 * header): the partner's latest fix, the road route to the next stop and the ETA, as each side may see them.
 */
import { useEffect, useState } from "react";
import type { LiveTrack } from "../../../../api/src/matching/live-track";
import { API_URL } from "./api";
import { getSession } from "./auth";

export type { LiveTrack };

export function useShareLive(shareId: string | null) {
  const [track, setTrack] = useState<LiveTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!shareId) return;
    const ctrl = new AbortController();
    (async () => {
      while (!ctrl.signal.aborted) {
        const token = getSession()?.token;
        if (!token) return setError("Sign in to see this delivery.");
        try {
          const res = await fetch(`${API_URL}/agents/shares/${shareId}/live`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
          if (res.status === 401 || res.status === 403 || res.status === 404) return setError("This delivery isn't visible to you.");
          if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
          setError(null);
          const reader = res.body.getReader(), decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              if (!frame.includes("event: snapshot")) continue;
              const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
              if (data) setTrack(JSON.parse(data) as LiveTrack);
            }
          }
        } catch {
          /* dropped: reconnect */
        }
        if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => ctrl.abort();
  }, [shareId]);
  return { track, error };
}
