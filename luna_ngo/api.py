"""FastAPI application: REST API + dashboard + NGO portal."""
from __future__ import annotations

import os
import time
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import Body, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ValidationError

from .agent.llm import LLMError
from .config import get_config
from .db import DatabaseError, local_today
from .models import NGOStatus, TodayPlan
from .food.models import SubmissionError
from .orchestrator import LunaOrchestrator
from .service import LunaService

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


class MatchRequest(BaseModel):
    food_passport: dict[str, Any]
    mode: Literal["LIVE", "DEMO"] = "LIVE"
    brain: Literal["auto", "llm", "rules"] = "auto"


class ConfirmationBody(BaseModel):
    ngo_id: str
    response: Literal["ACCEPTED", "REJECTED"]
    reason: Optional[str] = None
    delivery_notes: Optional[str] = None  # what the delivery partner should bring (utensils, containers...)


class VerifyOtpBody(BaseModel):
    ngo_id: str
    otp: str


class PartnerBody(BaseModel):
    ngo_id: str
    partner_name: str
    partner_phone: str


class PickupBody(BaseModel):
    partner_phone: str
    otp: str


class ReplanBody(BaseModel):
    exclude_ngo_ids: list[str] = []
    note: Optional[str] = None


class SplitBody(BaseModel):
    quantity: Optional[int] = None


class StatusBody(BaseModel):
    status: NGOStatus


class TodayBody(BaseModel):
    meals_needed: Optional[int] = None
    urgency: Optional[Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]] = None
    available_capacity_today: Optional[int] = None
    receiving_hours: Optional[dict[str, str]] = None


class DemandBody(BaseModel):
    meals_needed: int
    urgency: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


class RunScenarioBody(BaseModel):
    brain: Literal["auto", "llm", "rules"] = "auto"


def _no_otp(row: dict[str, Any]) -> dict[str, Any]:
    """Codes are shown only to their holder: pickup code → donor, drop code → NGO (LUNA-SPEC §13.5)."""
    return {k: v for k, v in row.items() if k not in ("otp", "pickup_otp")}


def create_app(service: Optional[LunaService] = None, orchestrator: Optional[LunaOrchestrator] = None) -> FastAPI:
    app = FastAPI(title="LUNA NGO Matching Agent", version="1.0.0")
    # the Next.js app (web/) calls this API from the browser
    origins = [o.strip() for o in os.environ.get("LUNA_CORS_ORIGINS", "").split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins,
                       allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
                       allow_methods=["*"], allow_headers=["*"])
    svc = service or LunaService(get_config())
    app.state.svc = svc
    orch = orchestrator or LunaOrchestrator(svc)
    app.state.orch = orch

    def _mode(mode: str) -> str:
        m = mode.upper()
        if m not in ("LIVE", "DEMO"):
            raise HTTPException(400, "mode must be LIVE or DEMO")
        return m

    # ------------------------------------------------------------------ system
    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.get("/api/system")
    def system():
        return {"brain": svc.brain_info(), "scenarios": svc.scenarios(), "current_scenario": svc.current_scenario,
                "weights": svc.cfg["match_score_weights"], "limits": svc.cfg["agent_limits"],
                "confirmation": svc.cfg["confirmation"]}

    # ------------------------------------------------------------------ agent
    @app.post("/api/ngo-agent/match", status_code=202)
    def create_match(body: dict[str, Any] = Body(...), wait: bool = Query(False),
                     mode: Optional[str] = Query(None)):
        """Accepts either {"food_passport": {...}, "mode": ..., "brain": ...} or a bare Food Passport."""
        if "food_passport" in body:
            try:
                req = MatchRequest.model_validate(body)
            except ValidationError as e:
                raise HTTPException(422, e.errors())
            passport, m, brain = req.food_passport, req.mode, req.brain
        else:
            passport, m, brain = body, "LIVE", "auto"
        if mode:
            m = _mode(mode)
        try:
            match_id = svc.start_match(passport, m, brain=brain, wait=wait)
        except LLMError as e:
            raise HTTPException(503, str(e))
        except DatabaseError as e:
            raise HTTPException(503, f"Database unavailable: {e}")
        view = svc.get_match_view(match_id)
        return {"match_id": match_id, "status": view["status"], "result": view["result"],
                "status_url": f"/api/ngo-agent/match/{match_id}"}

    @app.get("/api/ngo-agent/match/{match_id}")
    def get_match(match_id: str, after_event: int = 0, view: Literal["result", "full"] = "full"):
        v = svc.get_match_view(match_id, after_event)
        if not v:
            raise HTTPException(404, "match not found")
        # the OTP belongs to the NGO; the delivery partner must get it from them at hand-over
        v["confirmations"] = [_no_otp(c) for c in v["confirmations"]]
        return v["result"] if view == "result" else v

    @app.get("/api/ngo-agent/matches")
    def list_matches(mode: str = "DEMO", limit: int = 20):
        return svc.repos[_mode(mode)].list_matches(limit)

    @app.post("/api/ngo-agent/{match_id}/confirmation")
    def confirmation(match_id: str, body: ConfirmationBody):
        try:
            return svc.submit_confirmation(match_id, body.ngo_id, body.response, body.reason, body.delivery_notes)
        except KeyError:
            raise HTTPException(404, "match not found")
        except LookupError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(400, str(e))

    @app.post("/api/ngo-agent/{match_id}/verify-otp")
    def verify_otp(match_id: str, body: VerifyOtpBody):
        """Drop: the delivery partner enters the code shown on the NGO's screen (after pickup)."""
        try:
            return svc.verify_handoff_otp(match_id, body.ngo_id, body.otp)
        except KeyError:
            raise HTTPException(404, "match not found")

    @app.post("/api/ngo-agent/{match_id}/partner")
    def assign_partner(match_id: str, body: PartnerBody):
        """The NGO that accepted sends a delivery partner (name + phone of a Luna volunteer)."""
        try:
            return svc.assign_partner(match_id, body.ngo_id, body.partner_name, body.partner_phone)
        except KeyError:
            raise HTTPException(404, "match not found")
        except LookupError as e:
            raise HTTPException(409, str(e))
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.post("/api/ngo-agent/{match_id}/pickup")
    def pickup(match_id: str, body: PickupBody):
        """Pickup: the delivery partner enters the code shown on the donor's screen."""
        try:
            return svc.partner_pickup(match_id, body.partner_phone, body.otp)
        except KeyError:
            raise HTTPException(404, "match not found")

    @app.get("/api/partner/tasks")
    def partner_tasks(phone: str, mode: str = "LIVE"):
        """A delivery partner's runs: where to collect, where to drop, what to bring (no codes)."""
        return svc.partner_tasks(_mode(mode), phone)

    @app.post("/api/ngo-agent/{match_id}/replan")
    def replan(match_id: str, body: ReplanBody):
        try:
            return svc.replan(match_id, body.exclude_ngo_ids, body.note)
        except KeyError:
            raise HTTPException(404, "match not found")
        except (ValueError, LLMError) as e:
            raise HTTPException(409, str(e))

    @app.post("/api/ngo-agent/{match_id}/split")
    def split(match_id: str, body: SplitBody = Body(default=SplitBody())):
        try:
            return svc.split_options(match_id, body.quantity)
        except KeyError:
            raise HTTPException(404, "match not found")
        except ValueError as e:
            raise HTTPException(409, str(e))

    # ------------------------------------------------------------------ NGOs
    @app.get("/api/ngos")
    def list_ngos(mode: str = "DEMO"):
        ngos, invalid = svc.repos[_mode(mode)].list_ngos()
        return {"mode": mode.upper(), "ngos": [n.model_dump(mode="json", exclude={"contact"}) for n in ngos],
                "invalid_records": invalid}

    @app.get("/api/ngos/{ngo_id}")
    def get_ngo(ngo_id: str, mode: str = "DEMO"):
        repo = svc.repos[_mode(mode)]
        n = repo.get_ngo(ngo_id, raw=True)       # the stored defaults, plus today's listing if any
        if not n:
            raise HTTPException(404, "NGO not found")
        d = n.model_dump(mode="json", exclude={"contact"})
        d["today_active"] = bool(n.today and n.today.date == local_today())
        d["observed_history"] = repo.confirmation_history(ngo_id)
        return d

    @app.post("/api/ngos")
    def upsert_ngo(body: dict[str, Any], mode: str = "LIVE"):
        try:
            return svc.upsert_ngo(_mode(mode), body).model_dump(mode="json")
        except (ValidationError, ValueError) as e:
            raise HTTPException(422, str(e))

    @app.patch("/api/ngos/{ngo_id}/status")
    def set_status(ngo_id: str, body: StatusBody, mode: str = "DEMO"):
        n = svc.repos[_mode(mode)].set_ngo_status(ngo_id, body.status)
        if not n:
            raise HTTPException(404, "NGO not found")
        return {"ngo_id": ngo_id, "status": n.status.value}

    @app.put("/api/ngos/{ngo_id}/today")
    def set_today(ngo_id: str, body: TodayBody, mode: str = "LIVE"):
        """Today's listing: overrides the default listing until midnight (local)."""
        try:
            plan = TodayPlan.model_validate({**body.model_dump(exclude_none=True), "date": local_today()})
        except (ValidationError, ValueError) as e:
            raise HTTPException(422, str(e))
        n = svc.repos[_mode(mode)].set_today(ngo_id, plan)
        if not n:
            raise HTTPException(404, "NGO not found")
        return {"ngo_id": ngo_id, "today": plan.model_dump(mode="json")}

    @app.delete("/api/ngos/{ngo_id}/today")
    def clear_today(ngo_id: str, mode: str = "LIVE"):
        if not svc.repos[_mode(mode)].set_today(ngo_id, None):
            raise HTTPException(404, "NGO not found")
        return {"ngo_id": ngo_id, "today": None}

    @app.patch("/api/ngos/{ngo_id}/demand")
    def set_demand(ngo_id: str, body: DemandBody, mode: str = "DEMO"):
        n = svc.repos[_mode(mode)].update_ngo_demand(ngo_id, body.meals_needed, body.urgency)
        if not n:
            raise HTTPException(404, "NGO not found")
        return {"ngo_id": ngo_id, "current_demand": n.current_demand.model_dump(mode="json")}

    # ------------------------------------------------------------------ demo
    @app.get("/api/demo/scenarios")
    def scenarios():
        return svc.scenarios()

    @app.post("/api/demo/scenarios/{scenario_id}/run", status_code=202)
    def run_scenario(scenario_id: str, body: RunScenarioBody = Body(default=RunScenarioBody())):
        try:
            mid = svc.run_scenario(scenario_id, brain=body.brain)
        except KeyError:
            raise HTTPException(404, "unknown scenario")
        except LLMError as e:
            raise HTTPException(503, str(e))
        return {"match_id": mid, "status_url": f"/api/ngo-agent/match/{mid}"}

    # ------------------------------------------------------------------ NGO portal
    @app.get("/api/portal/pending")
    def portal_pending(mode: str = "LIVE", ngo_id: Optional[str] = None):
        repo = svc.repos[_mode(mode)]
        rows = repo.list_confirmations(ngo_id=ngo_id, status="PENDING")
        out = []
        for r in rows:
            n = repo.get_ngo(r["ngo_id"])
            raw = repo.get_passport_raw(r["match_id"]) or {}
            out.append({**_no_otp(r), "ngo_name": n.name if n else r["ngo_id"], "food_name": raw.get("food_name"),
                        "restaurant": raw.get("restaurant_name") or raw.get("restaurant_id")})
        return out

    @app.get("/api/portal/offers")
    def portal_offers(ngo_id: str, mode: str = "LIVE"):
        """One NGO's inbox: pending offers (with respond-by time) and accepted ones (with OTP + ETA)."""
        return svc.ngo_offers(_mode(mode), ngo_id)

    # ------------------------------------------------------------------ LUNA end-to-end flow (restaurant -> Food Agent -> NGO Agent)
    @app.get("/api/luna/info")
    def luna_info():
        return orch.info()

    @app.post("/api/luna/submissions", status_code=202)
    def luna_submit(body: dict[str, Any] = Body(...)):
        """Restaurant submission (JSON, image as data-URL/base64). Starts the whole autonomous flow."""
        try:
            sid = orch.submit(body)
        except SubmissionError as e:
            return JSONResponse(status_code=422, content={"errors": e.errors})
        except DatabaseError as e:
            raise HTTPException(503, f"Database unavailable: {e}")
        return {"submission_id": sid, "status_url": f"/api/luna/submissions/{sid}"}

    @app.post("/api/luna/food-check")
    def luna_food_check(body: dict[str, Any] = Body(...)):
        """Food Agent only (no NGO matching): the Luna app grades each new listing with this."""
        try:
            return orch.check_food(body)
        except SubmissionError as e:
            return JSONResponse(status_code=422, content={"errors": e.errors})
        except LLMError as e:
            raise HTTPException(503, f"Food check unavailable: {e}")
        except DatabaseError as e:
            raise HTTPException(503, f"Database unavailable: {e}")

    @app.get("/api/luna/submissions/{sid}")
    def luna_status(sid: str):
        v = orch.public_view(sid)
        if not v:
            raise HTTPException(404, "submission not found")
        return v

    @app.get("/api/luna/submissions/{sid}/ops")
    def luna_ops(sid: str):
        v = orch.ops_view(sid)
        if not v:
            raise HTTPException(404, "submission not found")
        return v

    @app.get("/api/luna/submissions")
    def luna_list(limit: int = 20, donor_id: Optional[str] = None):
        """All recent submissions, or one donor's (as donor-facing views, with the freshness grade)."""
        rows = orch.repo.list_submissions(limit, restaurant_id=donor_id)
        if donor_id:
            return [v for v in (orch.public_view(r["submission_id"]) for r in rows) if v]
        return rows

    # ------------------------------------------------------------------ UI
    @app.get("/")
    def index():
        return FileResponse(FRONTEND / "luna.html")

    @app.get("/ops")
    def ops():
        return FileResponse(FRONTEND / "index.html")

    @app.get("/portal")
    def portal():
        return FileResponse(FRONTEND / "portal.html")

    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
    return app
