"""NGO confirmation channels.

The agent never assumes acceptance. A request creates a PENDING row in
ngo_confirmations; the response arrives asynchronously and the agent waits
(with a configurable timeout) by observing the database.

* LiveConfirmationChannel      - NGO answers via the NGO portal / API
                                 (optional webhook notification).
* SimulatedConfirmationChannel - DEMO only. A scripted, clearly labelled NGO
                                 simulator answers after a delay, through the
                                 SAME database path a real NGO would use.
"""
from __future__ import annotations

import json
import threading
import time
from typing import Any, Callable, Optional

from ..db import Repository
from ..models import NGO, NGOStatus


class ConfirmationChannel:
    source = "BASE"
    label = ""

    def __init__(self, repo: Repository):
        self.repo = repo

    def send(self, match_id: str, ngo: NGO, quantity: int, food_summary: dict[str, Any]) -> str:
        raise NotImplementedError

    def wait_for_response(self, confirmation_id: str, ngo_id: str, timeout_s: float, poll_s: float,
                          should_stop: Callable[[], bool] = lambda: False) -> dict[str, Any]:
        """Block until ACCEPTED/REJECTED, NGO goes UNAVAILABLE/CLOSED, or timeout."""
        start = time.monotonic()
        while True:
            row = self.repo.get_confirmation(confirmation_id)
            if row and row["status"] != "PENDING":
                return {"response": row["status"], "reason": row["reason"], "source": row["source"],
                        "waited_seconds": round(time.monotonic() - start, 1)}
            ngo = self.repo.get_ngo(ngo_id)
            if ngo is None or ngo.status in (NGOStatus.UNAVAILABLE, NGOStatus.CLOSED):
                st = "UNAVAILABLE"
                reason = f"NGO status changed to {ngo.status.value if ngo else 'DELETED'} while awaiting confirmation"
                if self.repo.respond_confirmation(confirmation_id, st, reason):
                    return {"response": st, "reason": reason, "source": "STATUS_OBSERVED",
                            "waited_seconds": round(time.monotonic() - start, 1)}
                continue  # a response raced in; loop reads it
            if time.monotonic() - start >= timeout_s or should_stop():
                reason = f"No response within {timeout_s:g}s timeout"
                if self.repo.respond_confirmation(confirmation_id, "NO_RESPONSE", reason):
                    return {"response": "NO_RESPONSE", "reason": reason, "source": "TIMEOUT",
                            "waited_seconds": round(time.monotonic() - start, 1)}
                continue
            time.sleep(poll_s)


class LiveConfirmationChannel(ConfirmationChannel):
    source = "LIVE_PORTAL"
    label = "NGO portal"

    def send(self, match_id: str, ngo: NGO, quantity: int, food_summary: dict[str, Any]) -> str:
        cid = self.repo.create_confirmation(match_id, ngo.ngo_id, quantity, food_summary.get("food_category"), self.source)
        if ngo.contact.webhook_url:
            payload = {"confirmation_id": cid, "match_id": match_id, "ngo_id": ngo.ngo_id, "quantity": quantity,
                       "food": food_summary,
                       "respond_to": f"/api/ngo-agent/{match_id}/confirmation"}
            threading.Thread(target=_post_webhook, args=(ngo.contact.webhook_url, payload), daemon=True).start()
        return cid


def _post_webhook(url: str, payload: dict) -> None:
    try:
        import httpx
        httpx.post(url, json=payload, timeout=5)
    except Exception:
        pass  # delivery is best-effort; the NGO can still answer via the portal


class SimulatedConfirmationChannel(ConfirmationChannel):
    """DEMO MODE ONLY. `script` maps ngo_id -> behaviour:
        {"response": "ACCEPTED"|"REJECTED"|"NO_RESPONSE"|"UNAVAILABLE",
         "delay_s": 2.5, "reason": "..."}
    NGOs not in the script accept after `default_delay_s`.
    A human answering through the portal first always wins (PENDING-only update).
    """
    source = "SIMULATED"
    label = "simulated NGO (demo)"

    def __init__(self, repo: Repository, script: Optional[dict[str, dict]] = None, default_delay_s: float = 2.5,
                 on_event: Optional[Callable[[str, str, dict], None]] = None):
        super().__init__(repo)
        self.script = script or {}
        self.default_delay_s = default_delay_s
        self.on_event = on_event
        self._timers: list[threading.Timer] = []

    def send(self, match_id: str, ngo: NGO, quantity: int, food_summary: dict[str, Any]) -> str:
        cid = self.repo.create_confirmation(match_id, ngo.ngo_id, quantity, food_summary.get("food_category"), self.source)
        behaviour = self.script.get(ngo.ngo_id, {"response": "ACCEPTED"})
        resp = behaviour.get("response", "ACCEPTED")
        delay = float(behaviour.get("delay_s", self.default_delay_s))
        reason = behaviour.get("reason")
        if resp == "NO_RESPONSE":
            return cid
        t = threading.Timer(delay, self._respond, args=(match_id, cid, ngo, resp, reason))
        t.daemon = True
        self._timers.append(t)
        t.start()
        return cid

    def _respond(self, match_id: str, cid: str, ngo: NGO, resp: str, reason: Optional[str]) -> None:
        try:
            if resp == "UNAVAILABLE":
                # simulate the NGO going offline; the agent must OBSERVE it via status
                self.repo.set_ngo_status(ngo.ngo_id, NGOStatus.UNAVAILABLE)
                if self.on_event:
                    self.on_event(match_id, "simulation",
                                  {"message": f"[Simulated] {ngo.name} went offline (status → UNAVAILABLE)."})
                return
            if self.repo.respond_confirmation(cid, resp, reason, source=self.source) and self.on_event:
                self.on_event(match_id, "simulation",
                              {"message": f"[Simulated] {ngo.name} responded {resp}" + (f": “{reason}”" if reason else ".")})
        except Exception:
            pass

    def cancel_all(self) -> None:
        for t in self._timers:
            t.cancel()
