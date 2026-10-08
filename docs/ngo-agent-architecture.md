# LUNA — NGO Matching Agent: Architecture

```
FOOD AGENT ──Food Passport──▶ NGO MATCHING AGENT ──Match Result──▶ LUNA ORCHESTRATOR ──▶ LOGISTICS AGENT
```

## 1. Agent goal

> Maximise the probability that the food is successfully delivered to people who need it before the food-rescue window becomes critical.

The agent optimises for **expected successful rescue**, not proximity. It weighs demand, quantity fit, capacity, travel time, rescue-window slack, food compatibility, receiving hours, reliability (memory) and current load. It confirms with the NGO before claiming a match, and re-plans on its own when an NGO rejects, times out or goes offline.

## 2. Inputs

**Food Passport** (from the Food Agent), parsed tolerantly (`luna_ngo/models.py::FoodPassport`) and validated by `validate_food_passport`.

| Field | Required for matching | Notes |
|---|---|---|
| `passport_id` | ✅ | |
| `food_category` | ✅ | Normalised (`cooked_meals` → `cooked_meal`, …) |
| `quantity` (> 0) | ✅ | Meals |
| `restaurant_location` | ✅ | lat/lon |
| `rescue_window.remaining_minutes` **or** `rescue_window.expires_at` | ✅ | Deadline = `issued_at` (or receipt time) + remaining minutes. `expires_at` preferred. |
| `eligibility.decision == "ELIGIBLE"` | ✅ | Contract check only. Food safety is never re-evaluated. |
| `ingredients`, `allergens`, `dietary_tags` | optional | Missing allergens = **unknown** (≠ none): NGOs with allergen constraints become incompatible. Missing `dietary_tags` → vegetarian status derived from ingredients (flagged). |

Missing critical fields → outcome `NEEDS_INFORMATION`, `missing_fields` listed, `next_action = REQUEST_MISSING_PASSPORT_DATA`. Nothing is guessed.

**Contract additions requested from the Food Agent** (optional, used if present): `issued_at`, `rescue_window.expires_at`, `dietary_tags`, `restaurant_name`, `quantity_unit`.

**NGO data** — `NGO` model (`models.py`), stored in SQLite. Additions to the brief's schema (all documented, all optional):

| Field | Purpose |
|---|---|
| `accepted_categories` | Hard category filter (empty = any). `food_preferences` stays a soft preference. |
| `donations_received_today` | Load / saturation signal |
| `population_served`, `address` | Context for coordinators |
| `reliability.average_confirmation_minutes`, `cancellation_rate`, `sample_size`, `source` (`synthetic`/`reported`/`observed`/`none`) | Explainable reliability with provenance |
| `history.typical_daily_distribution_min/max`, `history.category_stats` | Memory: realistic distribution volume, category-specific rejection history |
| `contact.webhook_url` | Live confirmation notification |
| `data_source` (`DEMO_SYNTHETIC` / `LIVE`) | Prevents synthetic data entering LIVE mode |

## 3. Outputs — Match Result

```json
{
  "match_id": "MATCH-LUNA-F1842-1A2B3",
  "food_passport_id": "PASS-LUNA-F1842",
  "mode": "DEMO",
  "strategy": "SINGLE_NGO | SPLIT_DONATION | NO_MATCH",
  "status": "MATCHED | PARTIALLY_MATCHED | NO_FEASIBLE_MATCH | NEEDS_INFORMATION | WINDOW_EXPIRED | FAILED",
  "selected_ngos": [{"ngo_id": "NGO-0201", "name": "...", "allocated_quantity": 80, "match_score": 90.6,
                      "confirmation": "ACCEPTED", "location": {...}, "estimated_travel_minutes": 12.2, "distance_km": 3.0}],
  "total_quantity": 80, "allocated_quantity": 80, "unallocated_quantity": 0,
  "reasoning": ["..."], "reasoning_source": "LLM · anthropic:claude-sonnet-4-5",
  "attempts": [{"ngo_id": "NGO-0042", "outcome": "REJECTED", "reason": "..."}, {"ngo_id": "NGO-0201", "outcome": "ACCEPTED"}],
  "missing_fields": [],
  "next_action": "HANDOFF_TO_LOGISTICS",
  "logistics_handoff": {"pickup": {...}, "dropoffs": [...], "deliver_by": "...", "remaining_rescue_minutes": 105.2},
  "rescue_deadline": "...", "created_at": "...", "finalized_at": "..."
}
```

While running, `GET /api/ngo-agent/match/{id}?view=result` returns the same shape with in-progress status (`AWAITING_CONFIRMATION`, …).

## 4. Tools (`luna_ngo/agent/tools.py`)

| Tool | What it does (deterministic) |
|---|---|
| `get_food_passport` | Returns the received passport |
| `validate_food_passport` | Critical fields, ELIGIBLE contract, deadline, dietary/allergen normalisation |
| `find_candidate_ngos` | NGOs within search radius; skips + reports invalid NGO records |
| `get_ngo_details` | Profile + live status |
| `get_ngo_current_demand` | Latest demand record |
| `check_ngo_capacity` | Absorbable meals = min(available capacity, need × (1+tolerance), typical distribution × factor) |
| `check_receiving_hours` | Open at arrival? waiting allowed only if hand-over still completes before the rescue deadline; overnight hours supported |
| `check_food_compatibility` | Accepted categories, vegetarian/vegan/halal/Jain constraints, allergen-free constraints, preference match, category-rejection memory |
| `calculate_distance` | Haversine + road factor |
| `estimate_delivery_time` | Prep + travel + hand-over vs remaining window (+ safety margin) |
| `get_ngo_history` | Memory: blended baseline + observed acceptance, confirmation time, category stats |
| `calculate_match_score` | Explainable weighted score with per-factor contributions |
| `rank_ngos` | Runs every hard filter + scoring over the pool → ranked list, exclusions with reasons, filter funnel |
| `evaluate_split_options` | SINGLE vs SPLIT by expected meals delivered |
| `create_match` | Records the agent's decision + explanation; re-validates every allocation |
| `request_ngo_confirmation` | **Gate**: live re-check of feasibility, then send request and wait (timeout) → ACCEPTED / REJECTED / NO_RESPONSE / UNAVAILABLE |
| `update_ngo_status` | Match-level status only (cannot change an NGO's real operational status) |
| `replan_match` | Drop failed NGOs, refresh live NGO data, recompute window, re-rank for unplaced meals |
| `finalize_match` | Outcome computed from recorded confirmations; refuses premature finalisation once |

Tool arguments chosen by the LLM are always re-validated. Invalid actions return an `error` to the LLM (shown in the feed as a 🛡 *Safety check*) instead of executing.

## 5. State machine

**Match** (`MatchStatus`):

```
RECEIVED → VALIDATING ─┬─(missing data)──────────────▶ NEEDS_INFORMATION
                       └─▶ SEARCHING → EVALUATING ─┬─(none feasible)──▶ NO_FEASIBLE_MATCH
                                                   └─▶ AWAITING_CONFIRMATION
                                                          ├─ ACCEPTED (all placed) ─▶ MATCHED
                                                          ├─ ACCEPTED (some placed) ─▶ EVALUATING … ─▶ PARTIALLY_MATCHED
                                                          └─ REJECTED / NO_RESPONSE / UNAVAILABLE ─▶ REPLANNING ─▶ EVALUATING …
any state ── deadline passed ─▶ WINDOW_EXPIRED      any state ── LLM/DB fault, limits ─▶ FAILED (safe stop)
```

**NGO** — two layers, kept separate on purpose:

* Operational status (owned by the NGO / ops): `ACTIVE`, `AT_CAPACITY` (never primary), `CLOSED` (excluded), `UNAVAILABLE` (excluded).
* Per-match candidate status: `CANDIDATE`, `EXCLUDED`, `AWAITING_CONFIRMATION` (never assumed accepted), `ACCEPTED`, `REJECTED`, `NO_RESPONSE`, `UNAVAILABLE`.

## 6. Matching algorithm (`luna_ngo/engine/scoring.py`)

1. **Hard filters** (in order, each produces a human reason): status → distance & service area → food compatibility → capacity & demand (min useful allocation, max active donations) → receiving hours → rescue-window feasibility (`prep + travel + hand-over + wait + safety margin ≤ remaining`).
2. **Factors** (0–1):

| Factor | Formula |
|---|---|
| demand_urgency | `level(LOW .3, MED .6, HIGH .85, CRIT 1) × (0.5 + 0.5 × min(1, need / quantity))` |
| capacity_fit | `allocatable / quantity` |
| travel_time | `0.5 × (1 − plan_minutes / remaining) + 0.5 × (1 − travel / 60)` |
| food_compatibility | 1.0 preferred · 0.8 accepted · × memory penalty for categories it usually rejects |
| receiving_hours | 0.5–1.0 by minutes before closing; reduced if it must wait to open |
| reliability | `0.45 acceptance + 0.35 distribution + 0.10 (1 − cancellation) + 0.10 confirmation speed` |
| current_load | `1 − min(1, (active + 0.5 × received_today) / max_active)` |

3. **Score** = `100 × Σ weightᵢ × factorᵢ`. Weights live in `config/ngo_agent.json` (`match_score_weights`, normalised to 1). Default: demand 30 %, capacity 20 %, travel 15 %, compatibility 15 %, hours 10 %, reliability 5 %, load 5 %.
4. **Quantity / split**: `P(success) = acceptance × distribution × time_factor`. Single expected = `min(q, allocatable₁) × P₁`. Split = greedy over ranked NGOs (≤ `max_ngos`, each ≥ `min_allocation_meals`, feasibility re-checked with per-extra-stop overhead). Split is recommended only if expected meals delivered improve by ≥ `min_expected_gain_ratio` (10 %).

Example from the brief (80 meals): NGO A need 20/cap 20 → capacity_fit 0.25; NGO B need 100/cap 120 → 1.0; NGO C 50/50 → 0.625. B wins (unit test `test_quantity_matching_prefers_ngo_that_can_absorb`).

## 7. LLM role

The LLM (Claude via the Messages API, or any OpenAI-compatible model) is the policy in the loop (`agent/policies.py::LLMPolicy`). Each step it receives the transcript of its own tool calls and results and decides:

* which tool to call next (and which not to call),
* how to interpret results (e.g. "best can only take 110 of 200 → evaluate a split"),
* which candidate to choose and with what quantity,
* when to replan, when more information is needed, when to stop,
* the human explanation (`create_match.reasoning`, `finalize_match.reasoning`, one-line narration shown as 💭 in the feed).

The LLM **cannot** produce capacity, location, demand, hours, distance, ETA, scores or acceptance: those only come from tools, and its actions are re-validated by tools.

## 8. Deterministic role

`engine/` (geo, passport, checks, scoring) and the tool layer: distance, ETA, capacity, time windows, receiving hours, compatibility, scoring, ranking, split evaluation, feasibility gates, outcome computation (`agent/result.py::compute_outcome`). Same inputs → same numbers, unit-tested.

## 9. Replanning

Triggered by observed facts, never by a button:

1. `request_ngo_confirmation` observes REJECTED / NO_RESPONSE (configurable timeout) / UNAVAILABLE (the wait loop also watches the NGO's live status).
2. NGO is excluded **for this match**; the attempt is persisted; `needs_replan` is set.
3. The LLM calls `replan_match`: failed NGOs removed, NGO data refreshed from the DB (new NGOs can appear, others disappear), remaining window recomputed (time has passed), candidates re-ranked for the **unplaced** quantity (accepted parts of a split are kept).
4. The LLM chooses the next NGO (or a split) → confirmation → loop.
5. Ends when everything is placed, no feasible NGO remains, or the window closes.

Operators can also inject a re-plan (`POST /api/ngo-agent/{id}/replan`) — into a running agent, or to resume a finished non-matched match (e.g. a new NGO registered).

## 10. Memory

* **Short-term**: `AgentState` (pool, ranking, proposal, attempts, exclusions), snapshotted to the `matches` table after every step.
* **Long-term**: every confirmation outcome is stored in `ngo_confirmations` with food category and response time. `confirmation_history()` aggregates it into acceptance rate, average confirmation time and per-category acceptance, blended with the NGO's declared baseline (`reliability`, `history`).
* With fewer than `min_samples_for_history` records a neutral prior is used and labelled "insufficient history" — no invented statistics in LIVE mode.
* **History never overrides current state**: hard filters run before any score (`test_history_never_overrides_closed_status`).

## 11. Failure handling

| Failure | Behaviour |
|---|---|
| LLM error / timeout | Retries (`llm_max_retries`), then switches to the clearly labelled rule-based fallback (if allowed), else `FAILED` + `MANUAL_REVIEW`. The switch is shown in the feed, the status card and `reasoning_source`. |
| LLM proposes invalid action | Tool returns an error; feed shows 🛡 Safety check; LLM must correct itself |
| LLM never finishes | `max_iterations`, `max_tool_calls`, `wall_clock_timeout_seconds` → forced, deterministic finalisation |
| NGO no response | Configurable timeout → `NO_RESPONSE` → replan |
| NGO goes offline mid-confirmation | Detected via status polling → `UNAVAILABLE` → replan |
| Rescue window closes | Loop stops → `WINDOW_EXPIRED` (keeps any confirmed allocations) |
| Database error | Agent stops safely → `FAILED`, API returns 503 on new requests |
| Invalid NGO record | Skipped and reported (feed + `invalid_ngo_records`); API rejects invalid writes with 422 |
| Missing passport data | `NEEDS_INFORMATION` with `missing_fields` |

## 12. Integration with the Food Agent

* The Food Agent **owns food eligibility**; the NGO Agent only checks `eligibility.decision == "ELIGIBLE"` and never re-scores safety.
* Integration: `POST /api/ngo-agent/match` with either a bare Food Passport or `{"food_passport": {...}, "mode": "LIVE", "brain": "auto"}`. Returns `202 {match_id, status_url}`; add `?wait=true` for a synchronous call.
* Optional push: set `LUNA_ORCHESTRATOR_WEBHOOK` to receive the final Match Result.

## 13. Future: Logistics Agent

The NGO Agent hands over `logistics_handoff` (pickup, confirmed drop-offs with quantities, receiving hours, confirmation ids, deliver-by deadline). The Logistics Agent will own driver assignment, routing (multi-stop for splits), pickup and delivery tracking.

Integration points already in place:

* `engine/geo.py::estimate_delivery_plan` is the single function to replace with a Logistics-Agent ETA / routing call.
* If logistics later fails (no driver), the Orchestrator can call `POST /api/ngo-agent/{id}/replan` with the constraint, and the agent re-plans with live data.

## Modes

| | LIVE | DEMO |
|---|---|---|
| Database | `data/luna_live.db` | `data/luna_demo.db` (reset per scenario) |
| NGO data | Real records only (`data_source=LIVE`, no synthetic reliability) | Synthetic, labelled |
| Confirmations | NGO portal `/portal` or API (+ optional webhook) | Scripted simulator, labelled `[Simulated]`; a human can still answer first via the portal |
| LLM | Configured LLM | Same LLM (or labelled fallback) |


## Appendix — Food Agent and the Luna Orchestrator

```
Restaurant form (/) -> POST /api/luna/submissions
        |
   LunaOrchestrator  (only component that knows both agents)
        |-- FOOD AGENT: tools = inspect_food_image (VLM), check_submission_consistency, evaluate_food_safety (rules), calculate_rescue_score, finalize_assessment
        |        decision: ELIGIBLE | NEEDS_REVIEW | INELIGIBLE   (LLM/VLM may only tighten, never loosen)
        |        ELIGIBLE -> Food Passport (issued_by FOOD_AGENT)
        |-- NGO AGENT: started automatically with the passport (see above) -> Match Result
        '-- public view (plain language) / ops view (everything)
```

Stages: RECEIVED, ANALYZING_FOOD, FINDING_NGO, AWAITING_NGO, MATCHED, PARTIAL, NOT_ELIGIBLE, NEEDS_REVIEW, NO_NGO, ERROR.
Safety precedence: hard failure (time/temperature/spoilage) > review (low vision confidence, unverified vision in LIVE) > risk-score threshold.
The Food Passport is the only data contract between the agents; the Match Result (`ready_for_logistics`) is the hand-off to the Logistics Agent.
