"use client";

import { useEffect, useRef } from "react";
import { API_URL } from "./api";
import { getSession } from "./auth";

/**
 * Instant updates from Luna's agents (GET /agents/me/stream, Server-Sent Events over fetch so the token
 * stays in a header). One shared connection per page; every subscriber refreshes the moment an agent
 * offers food, asks for a pickup or updates a donation. Reconnects on its own; polling stays as a backstop.
 */
const listeners = new Set<() => void>();
let controller: AbortController | null = null;

async function run(ctrl: AbortController) {
  while (!ctrl.signal.aborted) {
    const token = getSession()?.token;
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/agents/me/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal, cache: "no-store" });
      if (res.status === 401 || res.status === 403) return;
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
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
          if (frame.includes("event: update")) for (const fn of listeners) fn();
        }
      }
    } catch { /* dropped: reconnect below */ }
    if (!ctrl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
  }
}

/** Calls `onUpdate` whenever an agent sends this signed-in person something. */
export function useLive(onUpdate: () => void) {
  const ref = useRef(onUpdate);
  useEffect(() => { ref.current = onUpdate; });
  useEffect(() => {
    const fn = () => ref.current();
    listeners.add(fn);
    if (!controller) { controller = new AbortController(); void run(controller); }
    return () => {
      listeners.delete(fn);
      if (!listeners.size && controller) { controller.abort(); controller = null; }
    };
  }, []);
}
