"""LLM provider wire formats (no network) + REST API."""
import json
import time

import httpx
import pytest
from fastapi.testclient import TestClient

from luna_ngo.agent.confirmation import SimulatedConfirmationChannel
from luna_ngo.agent.llm import AnthropicProvider, LLMError, OpenAICompatProvider
from luna_ngo.agent.policies import LLMPolicy
from luna_ngo.agent.runner import NGOMatchingAgent, prepare_match
from luna_ngo.api import create_app
from luna_ngo.db import Database, Repository
from luna_ngo.demo.scenarios import build_scenario, ngo, passport
from luna_ngo.config import load_config
from luna_ngo.models import NGO
from luna_ngo.service import LunaService


# ------------------------------------------------------------------ Anthropic wire format, full agent run
def anthropic_brain(request: httpx.Request) -> httpx.Response:
    """A fake Claude endpoint that answers like a tool-using model."""
    body = json.loads(request.content)
    assert request.headers["x-api-key"] == "test-key"
    assert body["tools"] and "input_schema" in body["tools"][0]
    msgs = body["messages"]
    names, last, res = {}, None, {}
    for m in msgs:
        if m["role"] == "assistant":
            for b in m["content"]:
                if b["type"] == "tool_use":
                    names[b["id"]] = b["name"]
        if m["role"] == "user" and isinstance(m["content"], list):
            for b in m["content"]:
                if b["type"] == "tool_result":
                    last, res = names[b["tool_use_id"]], json.loads(b["content"])
    n = len(msgs)

    def tool(name, **inp):
        return httpx.Response(200, json={"content": [{"type": "text", "text": f"Doing {name}."},
                                                     {"type": "tool_use", "id": f"tu_{n}", "name": name, "input": inp}],
                                         "stop_reason": "tool_use"})
    flow = {None: "get_food_passport", "get_food_passport": "validate_food_passport",
            "validate_food_passport": "find_candidate_ngos", "find_candidate_ngos": "rank_ngos"}
    if last in flow:
        return tool(flow[last])
    if last in ("rank_ngos", "replan_match"):
        b = res["ranked"][0]
        return tool("create_match", strategy="SINGLE_NGO", allocations=[{"ngo_id": b["ngo_id"], "quantity": 80}],
                    reasoning=[f"{b['name']} has the best score"])
    if last == "create_match":
        return tool("request_ngo_confirmation", ngo_id=res["proposal"]["allocations"][0]["ngo_id"])
    if last == "request_ngo_confirmation":
        return tool("finalize_match", reasoning=["Confirmed"]) if res["response"] == "ACCEPTED" \
            else tool("replan_match", reason="rejected")
    return tool("finalize_match", reasoning=["done"], force_reason="x")


def test_anthropic_provider_drives_agent_with_replan(cfg):
    cfg["confirmation"]["demo_timeout_seconds"] = 2
    repo = Repository(Database(":memory:"))
    sc = build_scenario("best_rejects")
    for n in sc["ngo_models"]:
        repo.upsert_ngo(n)
    prov = AnthropicProvider("test-key", "claude-test", transport=httpx.MockTransport(anthropic_brain))
    st = prepare_match(repo, sc["passport"], "DEMO")
    ch = SimulatedConfirmationChannel(repo, {"NGO-0042": {"response": "REJECTED", "delay_s": 0.05}}, 0.05)
    res = NGOMatchingAgent(repo, cfg, ch, LLMPolicy(prov, 0)).run(st)
    assert res["status"] == "MATCHED" and res["attempts"][0]["outcome"] == "REJECTED"
    assert res["reasoning_source"] == "LLM · anthropic:claude-test"
    thoughts = [e for e in repo.list_events(st.match_id) if e["kind"] == "thought"]
    assert thoughts and thoughts[0]["message"].startswith("Doing")


def test_anthropic_http_error_raises_llmerror():
    prov = AnthropicProvider("k", "m", transport=httpx.MockTransport(lambda r: httpx.Response(529, text="overloaded")))
    with pytest.raises(LLMError):
        prov.complete("s", [{"role": "user", "content": "hi"}], [])


def test_openai_compatible_parsing():
    def handler(request):
        body = json.loads(request.content)
        assert body["messages"][0]["role"] == "system"
        assert body["tools"][0]["type"] == "function"
        tool_msgs = [m for m in body["messages"] if m["role"] == "tool"]
        assert tool_msgs and tool_msgs[0]["tool_call_id"] == "c1"
        return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {
            "content": "Ranking now.", "tool_calls": [{"id": "c2", "type": "function",
                                                       "function": {"name": "rank_ngos", "arguments": "{\"quantity\": 80}"}}]}}]})
    prov = OpenAICompatProvider("k", "gpt-test", "https://example.test/v1", transport=httpx.MockTransport(handler))
    msgs = [{"role": "user", "content": "go"},
            {"role": "assistant", "text": None, "tool_calls": [{"id": "c1", "name": "find_candidate_ngos", "arguments": {}}]},
            {"role": "tool", "tool_call_id": "c1", "name": "find_candidate_ngos", "content": "{}"}]
    out = prov.complete("sys", msgs, [{"name": "rank_ngos", "description": "d", "parameters": {"type": "object", "properties": {}}}])
    assert out["tool_calls"][0] == {"id": "c2", "name": "rank_ngos", "arguments": {"quantity": 80}}
    assert out["text"] == "Ranking now."


def test_food_check_uses_gemini_while_ngo_agent_keeps_its_provider(cfg, monkeypatch):
    from luna_ngo.agent.llm import AnthropicProvider, GeminiProvider, build_provider
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "a-key")
    c = {**cfg, "llm": {**cfg["llm"], "provider": "anthropic", "food_provider": "gemini"}}
    assert isinstance(build_provider(c), AnthropicProvider)  # NGO agent: unchanged
    chain = build_provider(c, purpose="food")
    prov = chain.providers[0]  # the food check is a fallback chain; Gemini Flash leads it
    assert isinstance(prov, GeminiProvider) and prov.model == cfg["llm"]["gemini_model"]
    seen = {}

    def handler(request):
        seen["url"], seen["auth"], seen["body"] = str(request.url), request.headers["authorization"], json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"condition": "fresh"}'}}]})
    prov.client = httpx.Client(base_url=cfg["llm"]["gemini_base_url"], transport=httpx.MockTransport(handler))
    assert "fresh" in prov.vision("sys", "aGk=", "image/jpeg", "look")
    assert seen["url"] == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert seen["auth"] == "Bearer g-key" and seen["body"]["reasoning_effort"] == "low"
    assert seen["body"]["messages"][1]["content"][0]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    monkeypatch.delenv("GEMINI_API_KEY")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("LUNA_LLM_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY_2", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    assert build_provider(c, purpose="food") is None  # no key -> transparent rule-based fallback


def test_service_wires_food_check_to_food_provider():
    from luna_ngo.agent.llm import build_provider
    svc = LunaService(load_config(), in_memory=True)
    assert svc.provider_factory is build_provider
    assert svc.food_provider_factory.keywords == {"purpose": "food"}


# ------------------------------------------------------------------ API
@pytest.fixture
def client(svc):
    return TestClient(create_app(svc))


def _wait(client, mid, timeout=10):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = client.get(f"/api/ngo-agent/match/{mid}").json()
        if not v["running"] and v["status"] not in ("RECEIVED",):
            return v
        time.sleep(0.05)
    raise AssertionError("timeout")


def test_api_demo_scenario_flow(client):
    r = client.post("/api/demo/scenarios/perfect_match/run", json={"brain": "rules"})
    assert r.status_code == 202
    v = _wait(client, r.json()["match_id"])
    assert v["status"] == "MATCHED"
    res = client.get(f"/api/ngo-agent/match/{v['match_id']}?view=result").json()
    assert res["strategy"] == "SINGLE_NGO" and res["selected_ngos"][0]["allocated_quantity"] == 80
    assert client.get("/api/ngos?mode=DEMO").json()["ngos"]
    assert client.get("/api/ngos/NGO-0042?mode=DEMO").json()["observed_history"]["accepted"] == 1
    split = client.post(f"/api/ngo-agent/{v['match_id']}/split", json={"quantity": 400}).json()
    assert split["recommended"] in ("SPLIT_DONATION", "SINGLE_NGO")


def test_api_live_mode_real_confirmation_via_portal(client, cfg):
    cfg["confirmation"]["live_timeout_seconds"] = 5
    live_ngo = ngo("NGO-L1", "Live Kitchen", 2, 0, 100, "HIGH", 120)
    live_ngo["data_source"] = "LIVE"
    live_ngo["reliability"] = {"source": "none"}
    assert client.post("/api/ngos?mode=LIVE", json=live_ngo).status_code == 200
    r = client.post("/api/ngo-agent/match", json={"food_passport": passport(), "mode": "LIVE", "brain": "rules"})
    mid = r.json()["match_id"]
    for _ in range(100):  # wait until the agent asks the NGO
        pend = client.get("/api/portal/pending?mode=LIVE").json()
        if pend:
            break
        time.sleep(0.05)
    assert pend and pend[0]["ngo_id"] == "NGO-L1"
    ok = client.post(f"/api/ngo-agent/{mid}/confirmation", json={"ngo_id": "NGO-L1", "response": "ACCEPTED"})
    assert ok.status_code == 200 and ok.json()["recorded"]
    v = _wait(client, mid)
    assert v["status"] == "MATCHED"
    cand = v["state"]["candidates"][0]
    assert cand["reliability"]["insufficient_history"]  # live mode: no fake statistics


def _live_ngo(ngo_id, name, km, score_need):
    n = ngo(ngo_id, name, km, 0, score_need, "HIGH", 120)
    n["data_source"] = "LIVE"
    n["reliability"] = {"source": "none"}
    return n


def _await_offer(client, ngo_id):
    for _ in range(100):
        offers = [o for o in client.get(f"/api/portal/offers?mode=LIVE&ngo_id={ngo_id}").json()
                  if o["status"] == "PENDING"]
        if offers:
            return offers[0]
        time.sleep(0.05)
    raise AssertionError(f"{ngo_id} never got an offer")


def test_api_reject_cascades_then_accept_issues_otp_and_eta(client, cfg):
    cfg["confirmation"]["live_timeout_seconds"] = 5
    client.post("/api/ngos?mode=LIVE", json=_live_ngo("NGO-A", "Near Need", 1, 100))
    client.post("/api/ngos?mode=LIVE", json=_live_ngo("NGO-B", "Far Need", 6, 90))
    mid = client.post("/api/ngo-agent/match", json={"food_passport": passport(), "mode": "LIVE",
                                                     "brain": "rules"}).json()["match_id"]
    first = _await_offer(client, "NGO-A")
    assert first["respond_by"] and first["rescue_score"] is not None and first["food_name"]
    client.post(f"/api/ngo-agent/{mid}/confirmation", json={"ngo_id": "NGO-A", "response": "REJECTED",
                                                           "reason": "No space"})
    _await_offer(client, "NGO-B")  # the next NGO in the ranking gets it
    ok = client.post(f"/api/ngo-agent/{mid}/confirmation",
                     json={"ngo_id": "NGO-B", "response": "ACCEPTED", "delivery_notes": "Bring 2 serving ladles"}).json()
    assert len(ok["otp"]) == 4 and ok["eta_at"] and ok["delivery_notes"] == "Bring 2 serving ladles"
    v = _wait(client, mid)
    assert v["status"] == "MATCHED"
    assert all("otp" not in c for c in v["confirmations"])  # ops view never shows the OTP
    drop = v["result"]["logistics_handoff"]["dropoffs"][0]
    assert drop["ngo_id"] == "NGO-B" and drop["delivery_notes"] == "Bring 2 serving ladles" and drop["food_eta_at"]
    accepted = next(o for o in client.get("/api/portal/offers?mode=LIVE&ngo_id=NGO-B").json() if o["status"] == "ACCEPTED")
    assert accepted["otp"] == ok["otp"]  # same OTP from both the API and the agent thread
    early = client.post(f"/api/ngo-agent/{mid}/verify-otp", json={"ngo_id": "NGO-B", "otp": ok["otp"]}).json()
    assert not early["verified"] and "picked up" in early["reason"]  # no drop before pickup
    client.post(f"/api/ngo-agent/{mid}/partner", json={"ngo_id": "NGO-B", "partner_name": "Kavya", "partner_phone": "9123456789"})
    code = client.app.state.svc.repos["LIVE"].accepted_confirmation(mid, "NGO-B")["pickup_otp"]
    assert client.post(f"/api/ngo-agent/{mid}/pickup", json={"partner_phone": "9123456789", "otp": code}).json()["verified"]
    bad = client.post(f"/api/ngo-agent/{mid}/verify-otp", json={"ngo_id": "NGO-B", "otp": "x"}).json()
    good = client.post(f"/api/ngo-agent/{mid}/verify-otp", json={"ngo_id": "NGO-B", "otp": ok["otp"]}).json()
    assert not bad["verified"] and good["verified"]


def test_api_rejects_synthetic_data_in_live_and_invalid_ngo(client):
    assert client.post("/api/ngos?mode=LIVE", json=ngo("X", "X", 1, 0, 10, "HIGH", 10)).status_code == 422
    bad = ngo("Y", "Y", 1, 0, 10, "HIGH", 10)
    bad["data_source"] = "LIVE"
    bad["reliability"] = {"source": "none"}
    bad["service_area_km"] = -3
    assert client.post("/api/ngos?mode=LIVE", json=bad).status_code == 422


def test_api_confirmation_without_pending_is_409(client):
    r = client.post("/api/demo/scenarios/perfect_match/run", json={"brain": "rules"})
    v = _wait(client, r.json()["match_id"])
    resp = client.post(f"/api/ngo-agent/{v['match_id']}/confirmation", json={"ngo_id": "NGO-0042", "response": "ACCEPTED"})
    assert resp.status_code == 409


def test_api_operator_replan_resumes_finished_match(client):
    repo = client.app.state.svc.repos["DEMO"]
    r = client.post("/api/demo/scenarios/no_feasible/run", json={"brain": "rules"})
    v = _wait(client, r.json()["match_id"])
    assert v["status"] == "NO_FEASIBLE_MATCH"
    # a compatible NGO comes online, operator asks for a re-plan
    good = ngo("NGO-NEW", "New Shelter", 1.5, 0, 80, "HIGH", 80)
    repo.upsert_ngo(NGO.model_validate(good))
    assert client.post(f"/api/ngo-agent/{v['match_id']}/replan", json={"note": "New NGO registered"}).status_code == 200
    time.sleep(0.2)
    v2 = _wait(client, v["match_id"])
    assert v2["status"] == "MATCHED" and v2["result"]["selected_ngos"][0]["ngo_id"] == "NGO-NEW"


def test_api_bare_passport_and_404(client):
    assert client.get("/api/ngo-agent/match/NOPE").status_code == 404
    r = client.post("/api/ngo-agent/match?mode=DEMO", json={**passport(), "quantity": None})
    assert r.status_code == 202
