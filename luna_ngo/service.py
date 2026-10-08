"""Application service: wires repositories, channels, policies and agent threads.
Used by the API and by tests. Keeps LIVE and DEMO strictly separated."""
from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta
from functools import partial
from pathlib import Path
from typing import Any, Callable, Optional

from .agent.confirmation import LiveConfirmationChannel, SimulatedConfirmationChannel
from .agent.llm import LLMError, LLMProvider, build_provider
from .agent.policies import LLMPolicy, Policy, RuleBasedPolicy
from .agent.result import build_result
from .agent.runner import NGOMatchingAgent, prepare_match
from .agent.state import AgentState
from .agent.tools import ToolContext, _rank
from .config import DATA_DIR, get_config
from .db import Database, Repository
from .demo.scenarios import build_scenario, list_scenarios
from .engine.passport import validate_food_passport
from .engine.scoring import plan_split
from .models import NGO, NGOStatus, TERMINAL_STATUSES, MatchStatus


class LunaService:
    def __init__(self, cfg: Optional[dict] = None, data_dir: Optional[Path] = None,
                 provider_factory: Callable[[dict], Optional[LLMProvider]] = build_provider,
                 in_memory: bool = False,
                 food_provider_factory: Optional[Callable[[dict], Optional[LLMProvider]]] = None):
        self.cfg = cfg or get_config()
        data_dir = Path(data_dir or DATA_DIR)
        self.repos = {
            "LIVE": Repository(Database(":memory:" if in_memory else data_dir / "luna_live.db")),
            "DEMO": Repository(Database(":memory:" if in_memory else data_dir / "luna_demo.db")),
        }
        self.provider_factory = provider_factory
        # the food safety check has its own LLM (llm.food_provider, Gemini by default)
        self.food_provider_factory = food_provider_factory or (
            partial(build_provider, purpose="food") if provider_factory is build_provider else provider_factory)
        self.running: dict[str, tuple[NGOMatchingAgent, threading.Thread]] = {}
        self._lock = threading.Lock()
        self.current_scenario: Optional[str] = None

    # ------------------------------------------------------------------ brain
    def brain_info(self) -> dict[str, Any]:
        try:
            p = self.provider_factory(self.cfg)
        except LLMError as e:
            return {"llm_configured": False, "label": "No LLM", "error": str(e),
                    "fallback_allowed": self.cfg["agent_limits"]["allow_rule_based_fallback"]}
        return {"llm_configured": p is not None, "label": p.label if p else "No LLM configured",
                "fallback_allowed": self.cfg["agent_limits"]["allow_rule_based_fallback"]}

    def _policy(self, brain: str) -> tuple[Policy, Optional[str]]:
        if brain == "rules":
            return RuleBasedPolicy(), "Rule-based fallback selected explicitly."
        try:
            p = self.provider_factory(self.cfg)
        except LLMError as e:
            p, err = None, str(e)
        else:
            err = None
        if p is not None:
            return LLMPolicy(p, self.cfg["agent_limits"]["llm_max_retries"]), None
        if brain == "llm":
            raise LLMError("LLM requested but no LLM credentials are configured "
                           "(set ANTHROPIC_API_KEY or LUNA_LLM_PROVIDER=openai + LUNA_LLM_API_KEY).")
        if not self.cfg["agent_limits"]["allow_rule_based_fallback"]:
            raise LLMError("No LLM configured and rule-based fallback is disabled.")
        return RuleBasedPolicy(), err or "No LLM configured — using the transparent rule-based fallback."

    # ------------------------------------------------------------------ matches
    def repo_for(self, match_id: str) -> Optional[Repository]:
        for r in self.repos.values():
            if r.get_match(match_id):
                return r
        return None

    def start_match(self, raw_passport: dict, mode: str = "LIVE", scenario: Optional[str] = None,
                    brain: str = "auto", responses: Optional[dict] = None, wait: bool = False,
                    state: Optional[AgentState] = None) -> str:
        mode = mode.upper()
        repo = self.repos[mode]
        policy, note = self._policy(brain)
        if state is None:
            state = prepare_match(repo, raw_passport, mode, scenario)
        if mode == "DEMO":
            channel = SimulatedConfirmationChannel(
                repo, responses or {}, self.cfg["demo"]["default_response_delay_seconds"],
                on_event=lambda mid, kind, d: repo.add_event(mid, kind, d["message"], None))
            delay = self.cfg["demo"]["step_delay_seconds"]
        else:
            channel = LiveConfirmationChannel(repo)
            delay = 0.0
        agent = NGOMatchingAgent(repo, self.cfg, channel, policy, step_delay_s=delay,
                                 on_finalized=self._notify_orchestrator)
        if note:
            repo.add_event(state.match_id, "warning", note, None)

        def _run():
            try:
                agent.run(state)
            finally:
                with self._lock:
                    self.running.pop(state.match_id, None)

        t = threading.Thread(target=_run, name=f"agent-{state.match_id}", daemon=True)
        with self._lock:
            self.running[state.match_id] = (agent, t)
        t.start()
        if wait:
            t.join()
        return state.match_id

    def run_scenario(self, scenario_id: str, brain: str = "auto", wait: bool = False) -> str:
        sc = build_scenario(scenario_id)
        repo = self.repos["DEMO"]
        for mid, (agent, _) in list(self.running.items()):
            if repo.get_match(mid):
                agent.stop()
        repo.clear_all()  # demo data is reset for every scenario run (reproducible)
        for n in sc["ngo_models"]:
            repo.upsert_ngo(n, demand_source="demo_seed")
        self.current_scenario = scenario_id
        return self.start_match(sc["passport"], "DEMO", scenario_id, brain, sc["responses"], wait=wait)

    def seed_flow_demo_ngos(self) -> int:
        """(Re)seed the synthetic DEMO NGO database used by the end-to-end flow. Receiving hours are
        generated relative to 'now' so the demo works at any time of day. Never touches LIVE data."""
        from .demo.scenarios import scenario_defs
        repo = self.repos["DEMO"]
        n = 0
        for rec in scenario_defs()["best_rejects"]["ngos"]:
            repo.upsert_ngo(NGO.model_validate(rec), demand_source="demo_seed")
            n += 1
        return n

    def scenarios(self) -> list[dict]:
        return list_scenarios()

    def get_match_view(self, match_id: str, after_event: int = 0) -> Optional[dict[str, Any]]:
        repo = self.repo_for(match_id)
        if not repo:
            return None
        m = repo.get_match(match_id)
        return {
            "match_id": match_id, "mode": m["mode"], "scenario": m["scenario"], "status": m["status"],
            "running": match_id in self.running, "state": m["state"], "result": m["result"],
            "events": repo.list_events(match_id, after_event), "attempts": repo.list_attempts(match_id),
            "confirmations": repo.list_confirmations(match_id=match_id),
        }

    def submit_confirmation(self, match_id: str, ngo_id: str, response: str, reason: Optional[str],
                            delivery_notes: Optional[str] = None) -> dict:
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        response = response.upper()
        if response not in ("ACCEPTED", "REJECTED"):
            raise ValueError("response must be ACCEPTED or REJECTED")
        pending = repo.pending_confirmation(match_id, ngo_id)
        if not pending:
            raise LookupError("No pending confirmation request for this NGO in this match")
        notes = ((delivery_notes or "").strip() or None) if response == "ACCEPTED" else None
        cid = pending["confirmation_id"]
        ok = repo.respond_confirmation(cid, response, reason, source="NGO_PORTAL", delivery_notes=notes)
        out: dict[str, Any] = {"confirmation_id": cid, "recorded": ok, "response": response}
        if ok:
            name = (repo.get_ngo(ngo_id).name if repo.get_ngo(ngo_id) else ngo_id)
            repo.add_event(match_id, "confirmation", f"{name} responded {response} via NGO portal"
                           + (f": “{reason}”" if reason else "."), None)
            if notes:
                repo.add_event(match_id, "handoff", f"{name} asked the delivery partner to bring: {notes}", None)
        if ok and response == "ACCEPTED":
            row = repo.ensure_handoff(cid, self._plan_minutes(repo, match_id, ngo_id)) or {}
            out.update(otp=row.get("otp"), eta_at=row.get("eta_at"), delivery_notes=row.get("delivery_notes"))
        return out

    def _plan_minutes(self, repo: Repository, match_id: str, ngo_id: str) -> float:
        """Pickup prep + travel + handover for this NGO, from the agent's latest evaluation."""
        snap = (repo.get_match(match_id) or {}).get("state") or {}
        for c in snap.get("candidates", []):
            if c["ngo_id"] == ngo_id and c.get("metrics", {}).get("total_plan_minutes") is not None:
                return float(c["metrics"]["total_plan_minutes"])
        le = self.cfg["logistics_estimates"]
        return le["pickup_preparation_minutes"] + le["receiving_handover_minutes"] + 20

    def ngo_offers(self, mode: str, ngo_id: str) -> list[dict[str, Any]]:
        """Everything the agent has offered this NGO, newest first, enriched for the NGO portal.
        The OTP is only ever returned here (to the NGO itself) and to the accepting call."""
        repo = self.repos[mode.upper()]
        timeout = self.cfg["confirmation"]["live_timeout_seconds" if mode.upper() == "LIVE" else "demo_timeout_seconds"]
        out = []
        for r in reversed(repo.list_confirmations(ngo_id=ngo_id)):
            m = repo.get_match(r["match_id"]) or {}
            snap = m.get("state") or {}
            food = snap.get("food") or {}
            raw = repo.get_passport_raw(r["match_id"]) or {}
            cand = next((c for c in snap.get("candidates", []) if c["ngo_id"] == ngo_id), {})
            metrics = cand.get("metrics", {})
            out.append({
                # the pickup code belongs to the donor; the NGO only ever sees its own drop code
                **{k: v for k, v in r.items() if k != "pickup_otp"},
                "respond_by": _plus_seconds(r["requested_at"], timeout) if r["status"] == "PENDING" else None,
                "food_name": food.get("food_name") or raw.get("food_name"),
                "food_category": food.get("food_category") or raw.get("food_category"),
                "dietary_tags": food.get("dietary_tags", []),
                "allergens": food.get("allergens"),
                "restaurant": raw.get("restaurant_name") or raw.get("restaurant_id"),
                "rescue_deadline": food.get("rescue_deadline"),
                "rescue_score": cand.get("match_score"),
                "distance_km": metrics.get("distance_km"),
                "estimated_minutes": metrics.get("total_plan_minutes"),
                "match_status": m.get("status"),
            })
        return out

    def verify_handoff_otp(self, match_id: str, ngo_id: str, otp: str) -> dict:
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        conf = repo.accepted_confirmation(match_id, ngo_id)
        if conf and not conf.get("picked_up_at"):
            return {"verified": False, "reason": "The food hasn't been picked up yet. Enter the pickup code at the restaurant first."}
        row = repo.verify_otp(match_id, ngo_id, otp)
        if not row:
            return {"verified": False, "reason": "That drop code doesn't match. Ask the NGO for the code on their screen."}
        repo.add_event(match_id, "handoff", f"Drop code verified at {ngo_id}; food delivered.", None)
        return {"verified": True, "confirmation_id": row["confirmation_id"], "verified_at": row["otp_verified_at"]}

    # ------------------------------------------------------------------ delivery partner
    def assign_partner(self, match_id: str, ngo_id: str, name: str, phone: str) -> dict:
        """The NGO that accepted sends a delivery partner (a Luna volunteer account with this phone)."""
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        name = " ".join((name or "").split())[:80]
        phone = "".join(ch for ch in (phone or "") if ch.isdigit())[-10:]
        if not name:
            raise ValueError("Add the delivery partner's name.")
        if len(phone) != 10 or phone[0] not in "6789":
            raise ValueError("Enter the partner's 10-digit mobile number.")
        conf = repo.accepted_confirmation(match_id, ngo_id)
        if not conf:
            raise LookupError("This NGO hasn't accepted this food.")
        if conf.get("picked_up_at"):
            raise LookupError("The food is already picked up; the partner can't be changed now.")
        row = repo.assign_partner(conf["confirmation_id"], name, phone)
        if not row:
            raise LookupError("Couldn't assign the partner. Refresh and try again.")
        ngo = repo.get_ngo(ngo_id)
        repo.add_event(match_id, "handoff", f"{ngo.name if ngo else ngo_id} sent a delivery partner: {name}.", None)
        return {"assigned": True, "partner_name": name, "assigned_at": row["assigned_at"]}

    def partner_pickup(self, match_id: str, phone: str, code: str) -> dict:
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        row = repo.verify_pickup(match_id, phone, code)
        if not row:
            return {"verified": False, "reason": "That pickup code doesn't match. Ask the restaurant for the code on their screen."}
        repo.add_event(match_id, "handoff", f"Pickup code verified; {row['partner_name']} collected the food.", None)
        return {"verified": True, "picked_up_at": row["picked_up_at"]}

    def partner_tasks(self, mode: str, phone: str) -> list[dict[str, Any]]:
        """Deliveries assigned to this partner, with where to collect and where to drop. No codes:
        the partner must get them in person (pickup from the donor, drop from the NGO)."""
        repo = self.repos[mode.upper()]
        out = []
        for c in repo.partner_confirmations(phone):
            raw = repo.get_passport_raw(c["match_id"]) or {}
            ngo = repo.get_ngo(c["ngo_id"])
            stage = "delivered" if c.get("otp_verified_at") else "to_drop" if c.get("picked_up_at") else "to_pickup"
            out.append({
                "match_id": c["match_id"], "ngo_id": c["ngo_id"], "stage": stage, "quantity": c["quantity"],
                "food_name": raw.get("food_name"), "food_category": raw.get("food_category"),
                "pickup": {"name": raw.get("restaurant_name") or "Restaurant", "location": raw.get("restaurant_location")},
                "drop": {"name": ngo.name if ngo else c["ngo_id"], "address": ngo.address if ngo else None,
                         "location": ngo.location.model_dump() if ngo else None},
                "bring": c.get("delivery_notes"), "eta_at": c.get("eta_at"), "assigned_at": c.get("assigned_at"),
                "picked_up_at": c.get("picked_up_at"), "delivered_at": c.get("otp_verified_at"),
            })
        return out

    def replan(self, match_id: str, exclude_ngo_ids: list[str], note: Optional[str]) -> dict:
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        msg = (note or "Operator requested a re-plan.") + (f" Exclude: {', '.join(exclude_ngo_ids)}." if exclude_ngo_ids else "")
        if match_id in self.running:
            agent, _ = self.running[match_id]
            for nid in exclude_ngo_ids:
                agent.state.excluded[nid] = "excluded by operator"
                agent.state.candidate_status[nid] = "EXCLUDED"
            agent.state.ranking_stale = True
            agent.state.needs_replan = True
            agent.state.operator_messages.append(msg)
            return {"accepted": True, "mode": "injected_into_running_agent"}
        m = repo.get_match(match_id)
        if m["status"] == "MATCHED":
            raise ValueError("Match already complete; nothing to replan.")
        # resume: new run on the same match, carrying over confirmed allocations and exclusions
        raw = repo.get_passport_raw(match_id)
        st = AgentState(match_id=match_id, mode=m["mode"], scenario=m["scenario"], raw_passport=raw)
        snap = m["state"] or {}
        st.accepted = snap.get("accepted", [])
        st.attempts = snap.get("attempts", [])
        for c in snap.get("candidates", []):
            if c["match_status"] in ("REJECTED", "NO_RESPONSE", "UNAVAILABLE", "EXCLUDED") and c.get("match_exclusion"):
                st.excluded[c["ngo_id"]] = c["match_exclusion"]
                st.candidate_status[c["ngo_id"]] = c["match_status"]
            if c["match_status"] == "ACCEPTED":
                st.candidate_status[c["ngo_id"]] = "ACCEPTED"
        if st.accepted:
            st.proposal = {"strategy": "SINGLE_NGO", "allocations": [dict(a) for a in st.accepted], "reasoning": []}
        for nid in exclude_ngo_ids:
            st.excluded[nid] = "excluded by operator"
            st.candidate_status[nid] = "EXCLUDED"
        st.operator_messages.append(msg)
        repo.update_match(match_id, status="REPLANNING", finalized_at=None)
        repo.add_event(match_id, "replan", "Operator re-plan requested; agent resuming.", None)
        responses = build_scenario(m["scenario"])["responses"] if m["mode"] == "DEMO" and m["scenario"] else None
        self.start_match(raw, m["mode"], m["scenario"], responses=responses, state=st)
        return {"accepted": True, "mode": "resumed"}

    def split_options(self, match_id: str, quantity: Optional[int] = None) -> dict:
        """Read-only deterministic split analysis for operators."""
        repo = self.repo_for(match_id)
        if not repo:
            raise KeyError("match not found")
        m = repo.get_match(match_id)
        raw = repo.get_passport_raw(match_id)
        v = validate_food_passport(raw)
        if not v["valid"]:
            raise ValueError("Passport invalid: " + ", ".join(v["missing_fields"] + v["errors"]))
        st = AgentState(match_id=match_id, mode=m["mode"], scenario=m["scenario"], raw_passport=raw)
        st.food = v["food"]
        st.validation = v
        snap = m["state"] or {}
        st.accepted = snap.get("accepted", [])
        ngos, _ = repo.list_ngos()
        st.candidate_pool = [n.ngo_id for n in ngos]
        q = quantity or max(1, st.unplaced_quantity)
        ctx = ToolContext(state=st, repo=_ReadOnlyRepo(repo), cfg=self.cfg, channel=None, emit=lambda *a: None)
        ranking = _rank(ctx, q, announce=False)
        ranked_full = [st.evaluations[r["ngo_id"]] for r in ranking["ranked"]]
        observed = {n.ngo_id: repo.confirmation_history(n.ngo_id) for n in ngos}
        return plan_split(st.food, q, ranked_full, {n.ngo_id: n for n in ngos}, self.cfg, None, observed)

    # ------------------------------------------------------------------ NGO data (live admin)
    def upsert_ngo(self, mode: str, data: dict) -> NGO:
        n = NGO.model_validate(data)
        if mode.upper() == "LIVE" and n.data_source != "LIVE":
            raise ValueError("Synthetic NGO records cannot be loaded into LIVE mode.")
        if mode.upper() == "LIVE" and n.reliability.source == "synthetic":
            raise ValueError("LIVE mode does not accept synthetic reliability statistics.")
        self.repos[mode.upper()].upsert_ngo(n, demand_source="admin")
        return n

    def _notify_orchestrator(self, result: dict) -> None:
        url = os.environ.get("LUNA_ORCHESTRATOR_WEBHOOK")
        if url:
            try:
                import httpx
                httpx.post(url, json=result, timeout=5)
            except Exception:
                pass


def _plus_seconds(iso_ts: str, seconds: float) -> Optional[str]:
    try:
        return (datetime.fromisoformat(iso_ts) + timedelta(seconds=seconds)).isoformat()
    except (TypeError, ValueError):
        return None


class _ReadOnlyRepo:
    """Wraps a Repository so analysis helpers cannot write."""
    def __init__(self, repo: Repository):
        self._r = repo

    def __getattr__(self, name):
        if name in ("get_ngo", "list_ngos", "confirmation_history", "latest_demand", "get_match"):
            return getattr(self._r, name)
        return lambda *a, **k: None
