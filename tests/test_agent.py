"""Agent-loop tests: scenarios, replanning, timeouts, failures, guardrails."""
import json

import pytest

from conftest import tool_result_map
from luna_ngo.agent.confirmation import SimulatedConfirmationChannel
from luna_ngo.agent.llm import LLMError, LLMProvider
from luna_ngo.agent.policies import LLMPolicy, RuleBasedPolicy
from luna_ngo.agent.runner import NGOMatchingAgent, prepare_match
from luna_ngo.db import Database, DatabaseError, Repository
from luna_ngo.demo.scenarios import build_scenario, ngo, passport
from luna_ngo.models import NGO


def run(svc, sid, brain="rules"):
    mid = svc.run_scenario(sid, brain=brain, wait=True)
    return svc.get_match_view(mid)


# ------------------------------------------------------------------ demo scenarios (rule-based policy)
def test_perfect_match(svc):
    v = run(svc, "perfect_match")
    r = v["result"]
    assert r["status"] == "MATCHED" and r["strategy"] == "SINGLE_NGO"
    assert r["selected_ngos"][0]["ngo_id"] == "NGO-0042" and r["allocated_quantity"] == 80
    assert r["next_action"] == "HANDOFF_TO_LOGISTICS" and r["logistics_handoff"]["dropoffs"]


def test_best_rejects_then_replans_to_next(svc, cfg):
    cfg["confirmation"]["demo_timeout_seconds"] = 3
    sc = build_scenario("best_rejects")
    sc_resp = sc["responses"]["NGO-0042"]
    sc_resp["delay_s"] = 0.05
    # patch scenario delay for speed
    import luna_ngo.service as service_mod
    orig = service_mod.build_scenario
    service_mod.build_scenario = lambda sid: sc
    try:
        v = run(svc, "best_rejects")
    finally:
        service_mod.build_scenario = orig
    r = v["result"]
    assert r["status"] == "MATCHED"
    outcomes = [(a["ngo_id"], a["outcome"]) for a in r["attempts"]]
    assert outcomes[0] == ("NGO-0042", "REJECTED")
    assert outcomes[-1][1] == "ACCEPTED" and outcomes[-1][0] != "NGO-0042"
    assert v["state"]["replans"] == 1
    assert any(e["kind"] == "replan" for e in v["events"])


def test_no_response_timeout_then_replan(svc):
    v = run(svc, "no_response")
    att = v["result"]["attempts"]
    assert att[0]["outcome"] == "NO_RESPONSE" and att[-1]["outcome"] == "ACCEPTED"
    assert v["result"]["status"] == "MATCHED"


def test_unavailable_detected_and_replanned(svc, cfg):
    cfg["confirmation"]["demo_timeout_seconds"] = 3
    sc = build_scenario("best_unavailable")
    sc["responses"]["NGO-0042"]["delay_s"] = 0.05
    import luna_ngo.service as service_mod
    orig = service_mod.build_scenario
    service_mod.build_scenario = lambda sid: sc
    try:
        v = run(svc, "best_unavailable")
    finally:
        service_mod.build_scenario = orig
    att = v["result"]["attempts"]
    assert att[0]["ngo_id"] == "NGO-0042" and att[0]["outcome"] == "UNAVAILABLE"
    # Little Lamps (ETA 8 min) has insufficient capacity; Care Center chosen
    assert v["result"]["selected_ngos"][0]["ngo_id"] == "NGO-0107"


def test_split_donation(svc):
    r = run(svc, "split_donation")["result"]
    assert r["strategy"] == "SPLIT_DONATION" and r["status"] == "MATCHED"
    assert len(r["selected_ngos"]) >= 2 and r["allocated_quantity"] == 200


def test_too_urgent_only_feasible_ngos(svc):
    v = run(svc, "too_urgent")
    r = v["result"]
    assert r["status"] == "MATCHED"
    chosen = r["selected_ngos"][0]["ngo_id"]
    far = next(c for c in v["state"]["candidates"] if c["ngo_id"] == "NGO-0150")
    assert not far["feasible"] and chosen != "NGO-0150"


def test_no_feasible_match_explained(svc):
    r = run(svc, "no_feasible")["result"]
    assert r["status"] == "NO_FEASIBLE_MATCH" and r["strategy"] == "NO_MATCH"
    assert r["next_action"] == "ESCALATE_TO_ORCHESTRATOR"
    assert any("Evidence" in x for x in r["reasoning"])


def test_missing_passport_data_requests_it(svc):
    p = passport()
    p.pop("quantity")
    mid = svc.start_match(p, "DEMO", brain="rules", wait=True)
    r = svc.get_match_view(mid)["result"]
    assert r["status"] == "NEEDS_INFORMATION" and "quantity" in r["missing_fields"]
    assert r["next_action"] == "REQUEST_MISSING_PASSPORT_DATA"


def test_partial_match_when_capacity_runs_out(svc):
    repo = svc.repos["DEMO"]
    repo.clear_all()
    repo.upsert_ngo(NGO.model_validate(ngo("A", "Only One", 2, 0, 50, "HIGH", 50)))
    mid = svc.start_match(passport(qty=120), "DEMO", brain="rules", wait=True)
    r = svc.get_match_view(mid)["result"]
    assert r["status"] == "PARTIALLY_MATCHED" and r["allocated_quantity"] == 50 and r["unallocated_quantity"] == 70


def test_invalid_ngo_record_is_skipped(svc):
    repo = svc.repos["DEMO"]
    repo.clear_all()
    repo.upsert_ngo(NGO.model_validate(ngo("A", "Good", 2, 0, 100, "HIGH", 120)))
    with repo.db.tx() as c:
        c.execute("INSERT INTO ngos VALUES('BAD','Broken','ACTIVE','{\"ngo_id\":\"BAD\"}','now')")
    mid = svc.start_match(passport(), "DEMO", brain="rules", wait=True)
    v = svc.get_match_view(mid)
    assert v["result"]["status"] == "MATCHED"
    assert v["state"]["invalid_ngo_records"][0]["ngo_id"] == "BAD"
    assert any("Skipped NGO record BAD" in e["message"] for e in v["events"])


# ------------------------------------------------------------------ LLM failure / fallback
class BrokenLLM(LLMProvider):
    name, model = "broken", "x"

    def complete(self, system, messages, tools):
        raise LLMError("503 overloaded")


def _agent(repo, cfg, policy, responses=None, allow_fallback=True):
    ch = SimulatedConfirmationChannel(repo, responses or {}, 0.05)
    return NGOMatchingAgent(repo, cfg, ch, policy, allow_fallback=allow_fallback)


def _seeded_repo(scenario="perfect_match"):
    repo = Repository(Database(":memory:"))
    sc = build_scenario(scenario)
    for n in sc["ngo_models"]:
        repo.upsert_ngo(n)
    return repo, sc


def test_llm_failure_falls_back_transparently(cfg):
    repo, sc = _seeded_repo()
    st = prepare_match(repo, sc["passport"], "DEMO")
    res = _agent(repo, cfg, LLMPolicy(BrokenLLM(), 0)).run(st)
    assert res["status"] == "MATCHED"
    assert "Rule-based" in res["reasoning_source"]
    ev = repo.list_events(st.match_id)
    assert any("AI reasoning service unavailable" in e["message"] for e in ev)


def test_llm_failure_without_fallback_fails_safely(cfg):
    repo, sc = _seeded_repo()
    st = prepare_match(repo, sc["passport"], "DEMO")
    res = _agent(repo, cfg, LLMPolicy(BrokenLLM(), 0), allow_fallback=False).run(st)
    assert res["status"] == "FAILED" and res["next_action"] == "MANUAL_REVIEW"


# ------------------------------------------------------------------ database failure
class FlakyRepo(Repository):
    def __init__(self, db, fail_on):
        super().__init__(db)
        self.fail_on = fail_on

    def list_ngos(self):
        if self.fail_on == "list_ngos":
            raise DatabaseError("disk I/O error")
        return super().list_ngos()


def test_database_failure_stops_safely(cfg):
    db = Database(":memory:")
    repo = FlakyRepo(db, "list_ngos")
    for n in build_scenario("perfect_match")["ngo_models"]:
        Repository.upsert_ngo(repo, n)
    st = prepare_match(repo, passport(), "DEMO")
    res = _agent(repo, cfg, RuleBasedPolicy()).run(st)
    assert res["status"] == "FAILED"
    assert any("Database error" in r for r in res["reasoning"])


# ------------------------------------------------------------------ guardrails against a misbehaving LLM
class ReckLessLLM(LLMProvider):
    """Tries to (1) skip validation, (2) request an infeasible NGO, (3) claim a match without acceptance."""
    name, model = "reckless", "x"

    def __init__(self):
        self.step = 0

    def complete(self, system, messages, tools):
        self.step += 1
        seq = [
            ("request_ngo_confirmation", {"ngo_id": "NGO-0042"}),           # before validation
            ("validate_food_passport", {}),
            ("find_candidate_ngos", {}),
            ("request_ngo_confirmation", {"ngo_id": "NGO-CLOSED"}),         # closed NGO
            ("request_ngo_confirmation", {"ngo_id": "NGO-0042", "quantity": 999}),
            ("finalize_match", {"reasoning": ["Matched!"]}),                # no acceptance -> guarded
            ("finalize_match", {"reasoning": ["Matched!"], "force_reason": "test"}),
        ]
        name, args = seq[min(self.step - 1, len(seq) - 1)]
        return {"text": f"step {self.step}", "tool_calls": [{"id": f"c{self.step}", "name": name, "arguments": args}],
                "stop_reason": "tool_use"}


def test_guardrails_block_invalid_llm_actions(cfg):
    repo, sc = _seeded_repo()
    repo.upsert_ngo(NGO.model_validate(ngo("NGO-CLOSED", "Closed One", 1, 0, 100, "HIGH", 100, status="CLOSED")))
    st = prepare_match(repo, sc["passport"], "DEMO")
    res = _agent(repo, cfg, LLMPolicy(ReckLessLLM(), 0)).run(st)
    assert res["status"] == "NO_FEASIBLE_MATCH"   # it can never become MATCHED without a recorded ACCEPTED
    guards = [e["message"] for e in repo.list_events(st.match_id) if e["kind"] == "guardrail"]
    assert any("validate_food_passport" in g for g in guards)
    assert any("Closed One" in g for g in guards)
    assert any("at most" in g or "unplaced" in g for g in guards)
    assert any("not been evaluated" in g or "untried" in g for g in guards)
    assert repo.list_confirmations(match_id=st.match_id) == []


class LoopingLLM(LLMProvider):
    name, model = "loop", "x"

    def complete(self, system, messages, tools):
        return {"text": None, "tool_calls": [{"id": str(len(messages)), "name": "get_food_passport", "arguments": {}}],
                "stop_reason": "tool_use"}


def test_iteration_limit_prevents_infinite_loop(cfg):
    cfg["agent_limits"]["max_iterations"] = 5
    repo, sc = _seeded_repo()
    st = prepare_match(repo, sc["passport"], "DEMO")
    res = _agent(repo, cfg, LLMPolicy(LoopingLLM(), 0)).run(st)
    assert st.iterations == 5 and res["status"] in ("FAILED", "NO_FEASIBLE_MATCH", "NEEDS_INFORMATION")
    assert any("Safety limit" in e["message"] for e in repo.list_events(st.match_id))


# ------------------------------------------------------------------ a scripted "LLM" through the real LLMPolicy
class ScriptedLLM(LLMProvider):
    """Stands in for a real model: decides the next tool from the last tool result.
    Exercises the full LLM policy path (transcript, tool calls, observations)."""
    name, model = "scripted", "test"

    def complete(self, system, messages, tools):
        last, res = tool_result_map(messages)
        res = res or {}

        def call(n, **a):
            return {"text": f"Next: {n}", "tool_calls": [{"id": f"t{len(messages)}", "name": n, "arguments": a}],
                    "stop_reason": "tool_use"}
        if last is None:
            return call("get_food_passport")
        if last == "get_food_passport":
            return call("validate_food_passport")
        if last == "validate_food_passport":
            return call("find_candidate_ngos") if res.get("valid") else call("finalize_match", reasoning=["missing data"])
        if last == "find_candidate_ngos":
            return call("rank_ngos")
        if last in ("rank_ngos", "replan_match"):
            ranked = res.get("ranked") or []
            if not ranked:
                return call("finalize_match", reasoning=["No feasible NGO"], force_reason="none left")
            b = ranked[0]
            return call("create_match", strategy="SINGLE_NGO", allocations=[{"ngo_id": b["ngo_id"],
                        "quantity": min(b["allocatable_quantity"], res.get("quantity") or res.get("unplaced_quantity"))}],
                        reasoning=[f"{b['name']} ranked first"])
        if last == "create_match":
            a = res["proposal"]["allocations"][-1]
            return call("request_ngo_confirmation", ngo_id=a["ngo_id"])
        if last == "request_ngo_confirmation":
            if res.get("response") == "ACCEPTED" and res.get("unplaced_quantity") == 0:
                return call("finalize_match", reasoning=["Confirmed"])
            return call("replan_match", reason="previous NGO failed")
        return call("finalize_match", reasoning=["done"], force_reason="fallthrough")


def test_llm_policy_end_to_end_reject_then_replan(cfg):
    cfg["confirmation"]["demo_timeout_seconds"] = 2
    repo, sc = _seeded_repo("best_rejects")
    st = prepare_match(repo, sc["passport"], "DEMO")
    responses = {"NGO-0042": {"response": "REJECTED", "delay_s": 0.05, "reason": "full"}}
    res = _agent(repo, cfg, LLMPolicy(ScriptedLLM(), 0), responses).run(st)
    assert res["status"] == "MATCHED"
    assert res["attempts"][0]["outcome"] == "REJECTED"
    assert res["selected_ngos"][0]["ngo_id"] != "NGO-0042"
    assert res["reasoning_source"].startswith("LLM")
