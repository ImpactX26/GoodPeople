"""Decision policies: who chooses the next action.

* LLMPolicy        - the real agent brain. An LLM with native tool calling
                     decides which tool to call next, interprets results,
                     chooses candidates, decides when to replan / split /
                     finalize, and writes the explanations.
* RuleBasedPolicy  - a transparent, clearly-labelled SAFETY FALLBACK used only
                     when no LLM is configured or the LLM fails. It is never
                     presented as LLM reasoning (UI + events + result say so).
"""
from __future__ import annotations

import itertools
import json
from typing import Any, Optional

from .llm import LLMError, LLMProvider
from .state import AgentState
from .tools import TOOL_SPECS

SYSTEM_PROMPT = """You are LUNA's NGO Matching Agent, an autonomous agent inside a food-rescue network.

GOAL: maximise the probability that the surplus food in the Food Passport is successfully delivered to people who need it before its rescue window becomes critical. Optimise for successful rescue, not for proximity alone.

HOW YOU WORK
- You act only through tools. Every fact you use (NGO capacity, demand, location, hours, distance, travel time, scores, reliability, acceptance) MUST come from a tool result. Never invent or estimate numbers yourself.
- Typical flow: load + validate the passport -> find candidates -> rank -> decide (single NGO or split) -> create_match -> request confirmation -> observe the answer -> replan if needed -> finalize. Skip tools you don't need; use detail tools (capacity, hours, history, match score...) only when they help a decision.
- If the passport is missing critical data, do NOT guess: finalize so the Orchestrator can request it.
- The Food Agent owns food safety. Never re-judge safety.
- An NGO being ranked #1 does not mean it accepts. Only an ACCEPTED confirmation counts.
- If an NGO rejects, does not respond, or becomes unavailable: immediately call replan_match, then choose the next best feasible NGO and request confirmation. Keep going until the food is placed, no feasible NGO remains, or the rescue window is gone. Do not ask a human.
- If no single NGO can absorb the quantity, call evaluate_split_options and split when it increases expected meals delivered.
- Prefer NGOs that leave a safe margin in the rescue window; an infeasible plan is never acceptable.
- Current operational status (CLOSED, UNAVAILABLE, AT_CAPACITY) always overrides historical reliability.
- When done, call finalize_match with a short, plain-English explanation grounded in tool results.

STYLE
- Before each tool call write ONE short sentence (max 25 words) for an operations dashboard saying what you are doing and why. Plain English, no JSON, no tool names, no internal jargon.
- create_match reasoning: 3-6 short bullet-style sentences a judge or NGO coordinator can understand.
"""


class Policy:
    label = "policy"
    kind = "base"

    def start(self, state: AgentState) -> None: ...

    def next_step(self, state: AgentState) -> dict[str, Any]:
        """Returns {"text": str|None, "tool_calls": [{"id","name","arguments"}]}"""
        raise NotImplementedError

    def observe(self, call: dict, result_json: str) -> None: ...

    def add_operator_message(self, text: str) -> None: ...


# =========================================================================== LLM
class LLMPolicy(Policy):
    kind = "llm"

    def __init__(self, provider: LLMProvider, max_retries: int = 2, system_prompt: str = SYSTEM_PROMPT,
                 tools: Optional[list] = None, start_message: Optional[str] = None):
        self.provider = provider
        self.max_retries = max_retries
        self.system_prompt = system_prompt
        self.tools = tools if tools is not None else TOOL_SPECS
        self.start_message = start_message
        self.messages: list[dict] = []
        self.label = f"LLM · {provider.label}"
        self._nudges = 0

    def start(self, state) -> None:
        if self.start_message:
            self.messages = [{"role": "user", "content": self.start_message}]
            return
        self.messages = [{"role": "user", "content":
                          f"A new Food Passport has arrived (match_id {state.match_id}, mode {state.mode}). "
                          "Find the NGO(s) that will successfully receive and distribute this food, and get confirmation."}]

    def add_operator_message(self, text: str) -> None:
        self.messages.append({"role": "user", "content": f"Operator update: {text}"})

    def next_step(self, state: AgentState) -> dict[str, Any]:
        last_err: Optional[Exception] = None
        for _ in range(self.max_retries + 1):
            try:
                out = self.provider.complete(self.system_prompt, self.messages, self.tools)
                break
            except LLMError as e:
                last_err = e
        else:
            raise LLMError(str(last_err))
        calls = out.get("tool_calls") or []
        self.messages.append({"role": "assistant", "text": out.get("text"), "tool_calls": calls})
        if not calls:
            self._nudges += 1
            if self._nudges > 2:
                raise LLMError("LLM repeatedly answered without choosing an action")
            self.messages.append({"role": "user", "content":
                                  "Continue autonomously by calling a tool. If the task is complete, call finalize_match."})
        return {"text": out.get("text"), "tool_calls": calls}

    def observe(self, call: dict, result_json: str) -> None:
        self.messages.append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": result_json})


# =========================================================================== fallback
class RuleBasedPolicy(Policy):
    """Deterministic safety fallback. Mirrors the documented decision procedure."""
    kind = "rules"
    label = "Rule-based fallback (no LLM)"

    def __init__(self):
        self._ids = itertools.count(1)

    def _call(self, name: str, text: str, **args) -> dict[str, Any]:
        return {"text": text, "tool_calls": [{"id": f"rb_{next(self._ids)}", "name": name, "arguments": args}]}

    def next_step(self, s: AgentState) -> dict[str, Any]:
        if not s.passport_loaded:
            return self._call("get_food_passport", "Loading the Food Passport.")
        if s.validation is None:
            return self._call("validate_food_passport", "Checking the passport has everything matching needs.")
        if not s.validation.get("valid"):
            return self._call("finalize_match", "Passport cannot be matched as-is; returning it to the Orchestrator.",
                              reasoning=["The Food Passport is missing or has invalid information required for matching."])
        if s.candidate_pool is None:
            return self._call("find_candidate_ngos", "Searching for NGOs near the restaurant.")
        if s.unplaced_quantity == 0 and s.pending_quantity == 0:
            return self._call("finalize_match", "All food is placed with confirmed NGOs.",
                              reasoning=_accept_reasons(s))
        if s.needs_replan:
            return self._call("replan_match", "A confirmation failed; re-ranking the remaining NGOs.",
                              reason="previous NGO could not take the donation")
        if s.ranking is None or s.ranking_stale:
            return self._call("rank_ngos", "Scoring and ranking every candidate NGO.")
        ranked = s.untried_feasible()
        if not ranked:
            return self._call("finalize_match", "No feasible NGO remains.",
                              reasoning=["No remaining NGO can feasibly receive this food within the rescue window."],
                              force_reason="exhausted feasible candidates")
        proposed = [a for a in (s.proposal or {}).get("allocations", []) if a["status"] == "PROPOSED"]
        if proposed:
            a = proposed[0]
            return self._call("request_ngo_confirmation", f"Asking {a['name']} to confirm {a['quantity']} meals.",
                              ngo_id=a["ngo_id"], quantity=a["quantity"], reason="Top-ranked feasible NGO.")
        q = s.unplaced_quantity
        best = ranked[0]
        if best["allocatable_quantity"] < q:
            if s.split_options is None:
                return self._call("evaluate_split_options", "Best NGO cannot take everything; evaluating a split.")
            if s.split_options.get("recommended") == "SPLIT_DONATION" and s.split_options.get("split"):
                allocs = [{"ngo_id": a["ngo_id"], "quantity": a["quantity"]} for a in s.split_options["split"]["allocations"]]
                return self._call("create_match", "Splitting the donation across NGOs.", strategy="SPLIT_DONATION",
                                  allocations=allocs, reasoning=list(s.split_options["explanation"]))
        alloc = min(q, best["allocatable_quantity"])
        return self._call("create_match", f"Selecting {best['name']}, the highest-scoring feasible NGO.",
                          strategy="SINGLE_NGO", allocations=[{"ngo_id": best["ngo_id"], "quantity": alloc}],
                          reasoning=[f"{best['name']} has the highest match score ({int(best['match_score'] + 0.5)})."]
                          + best["strengths"][:4])


def _accept_reasons(s: AgentState) -> list[str]:
    return [f"{a['name']} confirmed it will receive {a['quantity']} meals." for a in s.accepted]
