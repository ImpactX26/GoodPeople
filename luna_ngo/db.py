"""SQLite persistence (stdlib only).

LIVE and DEMO each get their own database file so simulated data can never
leak into live decisions.

Tables: ngos, ngo_demand, food_passports, matches, match_attempts,
ngo_confirmations, agent_events.
"""
from __future__ import annotations

import json
import secrets
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator, Optional

from pydantic import ValidationError

from .models import NGO, NGOStatus, TodayPlan


def local_today() -> str:
    """Today's date where the NGOs are (config receiving_hours.timezone), for today's listings."""
    from zoneinfo import ZoneInfo
    from .config import get_config
    return datetime.now(ZoneInfo(get_config()["receiving_hours"]["timezone"])).date().isoformat()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


SCHEMA = """
CREATE TABLE IF NOT EXISTS ngos (
    ngo_id      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL,
    data        TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ngo_demand (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ngo_id       TEXT NOT NULL,
    meals_needed INTEGER NOT NULL,
    urgency      TEXT NOT NULL,
    source       TEXT,
    recorded_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS food_passports (
    passport_id  TEXT NOT NULL,
    match_id     TEXT NOT NULL,
    raw          TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    PRIMARY KEY (passport_id, match_id)
);
CREATE TABLE IF NOT EXISTS matches (
    match_id          TEXT PRIMARY KEY,
    passport_id       TEXT,
    mode              TEXT NOT NULL,
    scenario          TEXT,
    status            TEXT NOT NULL,
    strategy          TEXT,
    deadline          TEXT,
    reasoning_source  TEXT,
    state             TEXT,
    result            TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    finalized_at      TEXT
);
CREATE TABLE IF NOT EXISTS match_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id      TEXT NOT NULL,
    attempt_no    INTEGER NOT NULL,
    ngo_id        TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    match_score   REAL,
    outcome       TEXT NOT NULL,
    reason        TEXT,
    requested_at  TEXT NOT NULL,
    resolved_at   TEXT
);
CREATE TABLE IF NOT EXISTS ngo_confirmations (
    confirmation_id TEXT PRIMARY KEY,
    match_id        TEXT NOT NULL,
    ngo_id          TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    food_category   TEXT,
    status          TEXT NOT NULL,
    reason          TEXT,
    source          TEXT,
    requested_at    TEXT NOT NULL,
    responded_at    TEXT,
    otp             TEXT,
    eta_at          TEXT,
    delivery_notes  TEXT,
    otp_verified_at TEXT,
    partner_name    TEXT,
    partner_phone   TEXT,
    pickup_otp      TEXT,
    assigned_at     TEXT,
    picked_up_at    TEXT
);
CREATE TABLE IF NOT EXISTS agent_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id  TEXT NOT NULL,
    ts        TEXT NOT NULL,
    kind      TEXT NOT NULL,
    message   TEXT NOT NULL,
    data      TEXT
);
CREATE TABLE IF NOT EXISTS submissions (
    submission_id  TEXT PRIMARY KEY,
    seq            INTEGER NOT NULL,
    mode           TEXT NOT NULL,
    restaurant_id  TEXT,
    food_name      TEXT,
    stage          TEXT NOT NULL,
    form           TEXT,
    image_path     TEXT,
    assessment     TEXT,
    passport_id    TEXT,
    match_id       TEXT,
    match_result   TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_match ON agent_events(match_id, id);
CREATE INDEX IF NOT EXISTS idx_conf_match ON ngo_confirmations(match_id, ngo_id);
CREATE INDEX IF NOT EXISTS idx_conf_ngo ON ngo_confirmations(ngo_id);
"""


# otp = drop code (shown on the NGO's screen); pickup_otp = pickup code (shown on the donor's screen)
HANDOFF_COLUMNS = ("otp", "eta_at", "delivery_notes", "otp_verified_at",
                   "partner_name", "partner_phone", "pickup_otp", "assigned_at", "picked_up_at")


class DatabaseError(RuntimeError):
    pass


class Database:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # keep one shared connection; guarded by a lock (simple + safe for a hackathon server)
        self._conn = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            if self.path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)
            # databases created before the hand-off columns existed
            have = {r[1] for r in self._conn.execute("PRAGMA table_info(ngo_confirmations)")}
            for col in HANDOFF_COLUMNS:
                if col not in have:
                    self._conn.execute(f"ALTER TABLE ngo_confirmations ADD COLUMN {col} TEXT")
            self._conn.commit()

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            try:
                yield self._conn
                self._conn.commit()
            except sqlite3.Error as e:
                self._conn.rollback()
                raise DatabaseError(str(e)) from e

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            try:
                return list(self._conn.execute(sql, params).fetchall())
            except sqlite3.Error as e:
                raise DatabaseError(str(e)) from e

    def close(self):
        with self._lock:
            self._conn.close()


class Repository:
    """All reads/writes the agent and API perform. Nothing else touches SQL."""

    def __init__(self, db: Database):
        self.db = db

    # ------------------------------------------------------------------ NGOs
    def upsert_ngo(self, ngo: NGO, demand_source: str = "profile") -> None:
        now = iso(utcnow())
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO ngos(ngo_id,name,status,data,updated_at) VALUES(?,?,?,?,?) "
                "ON CONFLICT(ngo_id) DO UPDATE SET name=excluded.name,status=excluded.status,"
                "data=excluded.data,updated_at=excluded.updated_at",
                (ngo.ngo_id, ngo.name, ngo.status.value, ngo.model_dump_json(), now),
            )
            c.execute(
                "INSERT INTO ngo_demand(ngo_id,meals_needed,urgency,source,recorded_at) VALUES(?,?,?,?,?)",
                (ngo.ngo_id, ngo.current_demand.meals_needed, ngo.current_demand.urgency, demand_source, now),
            )

    def list_ngos_raw(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.query("SELECT * FROM ngos ORDER BY ngo_id")]

    def list_ngos(self, raw: bool = False) -> tuple[list[NGO], list[dict[str, str]]]:
        """Returns (valid NGOs, invalid records with error). Invalid NGO data is
        never silently used for matching. Each NGO comes with today's listing applied unless raw."""
        valid, invalid = [], []
        today = local_today()
        for row in self.db.query("SELECT ngo_id, data FROM ngos ORDER BY ngo_id"):
            try:
                ngo = NGO.model_validate_json(row["data"])
                valid.append(ngo if raw else ngo.effective(today))
            except (ValidationError, ValueError) as e:
                invalid.append({"ngo_id": row["ngo_id"], "error": _short_validation_error(e)})
        return valid, invalid

    def get_ngo(self, ngo_id: str, raw: bool = False) -> Optional[NGO]:
        """The NGO as the agent should see it today (defaults + today's listing); raw=True for the stored record."""
        rows = self.db.query("SELECT data FROM ngos WHERE ngo_id=?", (ngo_id,))
        if not rows:
            return None
        ngo = NGO.model_validate_json(rows[0]["data"])
        return ngo if raw else ngo.effective(local_today())

    def set_today(self, ngo_id: str, plan: Optional[TodayPlan]) -> Optional[NGO]:
        """Sets (or with None clears) today's listing; the defaults stay untouched."""
        ngo = self.get_ngo(ngo_id, raw=True)
        if not ngo:
            return None
        ngo.today = plan
        self.upsert_ngo(NGO.model_validate(ngo.model_dump()), demand_source="today")
        return ngo

    def set_ngo_status(self, ngo_id: str, status: NGOStatus) -> Optional[NGO]:
        ngo = self.get_ngo(ngo_id, raw=True)
        if not ngo:
            return None
        ngo.status = status
        with self.db.tx() as c:
            c.execute("UPDATE ngos SET status=?, data=?, updated_at=? WHERE ngo_id=?",
                      (status.value, ngo.model_dump_json(), iso(utcnow()), ngo_id))
        return ngo

    def update_ngo_demand(self, ngo_id: str, meals_needed: int, urgency: str, source: str = "api") -> Optional[NGO]:
        ngo = self.get_ngo(ngo_id, raw=True)
        if not ngo:
            return None
        ngo.current_demand.meals_needed = meals_needed
        ngo.current_demand.urgency = urgency  # type: ignore[assignment]
        ngo.current_demand.updated_at = utcnow()
        self.upsert_ngo(NGO.model_validate(ngo.model_dump()), demand_source=source)
        return ngo

    def latest_demand(self, ngo_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query(
            "SELECT meals_needed, urgency, source, recorded_at FROM ngo_demand WHERE ngo_id=? ORDER BY id DESC LIMIT 1",
            (ngo_id,))
        return dict(rows[0]) if rows else None

    def reserve_capacity(self, ngo_id: str, quantity: int) -> None:
        """On ACCEPTED: reduce available capacity + demand, bump active donations."""
        ngo = self.get_ngo(ngo_id, raw=True)
        if not ngo:
            return
        ngo.capacity.available_capacity_today = max(0, ngo.capacity.available_capacity_today - quantity)
        ngo.current_demand.meals_needed = max(0, ngo.current_demand.meals_needed - quantity)
        t = ngo.today
        if t is not None and t.date == local_today():          # today's listing takes the food too
            if t.available_capacity_today is not None:
                t.available_capacity_today = max(0, t.available_capacity_today - quantity)
            if t.meals_needed is not None:
                t.meals_needed = max(0, t.meals_needed - quantity)
        ngo.active_donations += 1
        ngo.donations_received_today += 1
        if ngo.effective(local_today()).capacity.available_capacity_today == 0 and ngo.status == NGOStatus.ACTIVE:
            ngo.status = NGOStatus.AT_CAPACITY
        self.upsert_ngo(ngo, demand_source="allocation")

    def clear_all(self) -> None:
        with self.db.tx() as c:
            for t in ("ngos", "ngo_demand", "food_passports", "matches", "match_attempts",
                      "ngo_confirmations", "agent_events"):
                c.execute(f"DELETE FROM {t}")

    # ------------------------------------------------------------------ passports / matches
    def save_passport(self, passport_id: str, match_id: str, raw: dict) -> None:
        with self.db.tx() as c:
            c.execute("INSERT OR REPLACE INTO food_passports VALUES(?,?,?,?)",
                      (passport_id or "UNKNOWN", match_id, json.dumps(raw, default=str), iso(utcnow())))

    def get_passport_raw(self, match_id: str) -> Optional[dict]:
        rows = self.db.query("SELECT raw FROM food_passports WHERE match_id=?", (match_id,))
        return json.loads(rows[0]["raw"]) if rows else None

    def create_match(self, match_id: str, passport_id: Optional[str], mode: str, scenario: Optional[str],
                     deadline: Optional[datetime]) -> None:
        now = iso(utcnow())
        with self.db.tx() as c:
            c.execute(
                "INSERT INTO matches(match_id,passport_id,mode,scenario,status,deadline,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?)",
                (match_id, passport_id, mode, scenario, "RECEIVED", iso(deadline), now, now))

    def update_match(self, match_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields["updated_at"] = iso(utcnow())
        cols, vals = [], []
        for k, v in fields.items():
            cols.append(f"{k}=?")
            vals.append(json.dumps(v, default=str) if isinstance(v, (dict, list)) else v)
        vals.append(match_id)
        with self.db.tx() as c:
            c.execute(f"UPDATE matches SET {', '.join(cols)} WHERE match_id=?", tuple(vals))

    def get_match(self, match_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM matches WHERE match_id=?", (match_id,))
        if not rows:
            return None
        m = dict(rows[0])
        for k in ("state", "result"):
            m[k] = json.loads(m[k]) if m.get(k) else None
        return m

    def list_matches(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT match_id, passport_id, mode, scenario, status, strategy, created_at "
                             "FROM matches ORDER BY created_at DESC LIMIT ?", (limit,))
        return [dict(r) for r in rows]

    # ------------------------------------------------------------------ attempts
    def add_attempt(self, match_id: str, ngo_id: str, quantity: int, score: Optional[float]) -> int:
        rows = self.db.query("SELECT COUNT(*) AS n FROM match_attempts WHERE match_id=?", (match_id,))
        n = rows[0]["n"] + 1
        with self.db.tx() as c:
            cur = c.execute(
                "INSERT INTO match_attempts(match_id,attempt_no,ngo_id,quantity,match_score,outcome,requested_at) "
                "VALUES(?,?,?,?,?,?,?)", (match_id, n, ngo_id, quantity, score, "AWAITING_CONFIRMATION", iso(utcnow())))
            return int(cur.lastrowid)

    def resolve_attempt(self, attempt_id: int, outcome: str, reason: Optional[str]) -> None:
        with self.db.tx() as c:
            c.execute("UPDATE match_attempts SET outcome=?, reason=?, resolved_at=? WHERE id=?",
                      (outcome, reason, iso(utcnow()), attempt_id))

    def list_attempts(self, match_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.query(
            "SELECT attempt_no, ngo_id, quantity, match_score, outcome, reason, requested_at, resolved_at "
            "FROM match_attempts WHERE match_id=? ORDER BY attempt_no", (match_id,))]

    # ------------------------------------------------------------------ confirmations
    def create_confirmation(self, match_id: str, ngo_id: str, quantity: int, food_category: Optional[str],
                            source: str) -> str:
        cid = "CONF-" + uuid.uuid4().hex[:10].upper()
        with self.db.tx() as c:
            c.execute("INSERT INTO ngo_confirmations(confirmation_id,match_id,ngo_id,quantity,food_category,status,"
                      "source,requested_at) VALUES(?,?,?,?,?,?,?,?)",
                      (cid, match_id, ngo_id, quantity, food_category, "PENDING", source, iso(utcnow())))
        return cid

    def get_confirmation(self, confirmation_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM ngo_confirmations WHERE confirmation_id=?", (confirmation_id,))
        return dict(rows[0]) if rows else None

    def pending_confirmation(self, match_id: str, ngo_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM ngo_confirmations WHERE match_id=? AND ngo_id=? AND status='PENDING' "
                             "ORDER BY requested_at DESC LIMIT 1", (match_id, ngo_id))
        return dict(rows[0]) if rows else None

    def respond_confirmation(self, confirmation_id: str, status: str, reason: Optional[str],
                             source: Optional[str] = None, delivery_notes: Optional[str] = None) -> bool:
        """Only a PENDING request can be answered (idempotent / race-safe)."""
        with self.db.tx() as c:
            if source:
                cur = c.execute("UPDATE ngo_confirmations SET status=?, reason=?, responded_at=?, source=?, "
                                "delivery_notes=? WHERE confirmation_id=? AND status='PENDING'",
                                (status, reason, iso(utcnow()), source, delivery_notes, confirmation_id))
            else:
                cur = c.execute("UPDATE ngo_confirmations SET status=?, reason=?, responded_at=?, delivery_notes=? "
                                "WHERE confirmation_id=? AND status='PENDING'",
                                (status, reason, iso(utcnow()), delivery_notes, confirmation_id))
            return cur.rowcount == 1

    def ensure_handoff(self, confirmation_id: str, eta_minutes: float) -> Optional[dict[str, Any]]:
        """Issue the delivery OTP and food ETA for an ACCEPTED confirmation. First caller wins, so the
        API (answering the NGO) and the agent thread (recording the outcome) agree on one OTP."""
        otp = f"{secrets.randbelow(10_000):04d}"
        eta = iso(utcnow() + timedelta(minutes=max(0.0, eta_minutes)))
        with self.db.tx() as c:
            c.execute("UPDATE ngo_confirmations SET otp=?, eta_at=? "
                      "WHERE confirmation_id=? AND status='ACCEPTED' AND otp IS NULL", (otp, eta, confirmation_id))
        return self.get_confirmation(confirmation_id)

    def accepted_confirmation(self, match_id: str, ngo_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM ngo_confirmations WHERE match_id=? AND ngo_id=? AND status='ACCEPTED' "
                             "ORDER BY requested_at DESC LIMIT 1", (match_id, ngo_id))
        return dict(rows[0]) if rows else None

    def assign_partner(self, confirmation_id: str, name: str, phone: str) -> Optional[dict[str, Any]]:
        """The accepting NGO sends a delivery partner. A fresh pickup code is issued each time,
        so a replaced partner's code stops working. Not allowed once the food is picked up."""
        code = f"{secrets.randbelow(10_000):04d}"
        with self.db.tx() as c:
            cur = c.execute("UPDATE ngo_confirmations SET partner_name=?, partner_phone=?, pickup_otp=?, assigned_at=? "
                            "WHERE confirmation_id=? AND status='ACCEPTED' AND picked_up_at IS NULL",
                            (name, phone, code, iso(utcnow()), confirmation_id))
        return self.get_confirmation(confirmation_id) if cur.rowcount == 1 else None

    def verify_pickup(self, match_id: str, partner_phone: str, code: str) -> Optional[dict[str, Any]]:
        """Partner enters the code shown on the donor's screen. Returns the row when it matches."""
        rows = self.db.query("SELECT * FROM ngo_confirmations WHERE match_id=? AND partner_phone=? AND status='ACCEPTED' "
                             "AND pickup_otp IS NOT NULL ORDER BY requested_at DESC LIMIT 1", (match_id, partner_phone))
        if not rows or not secrets.compare_digest(rows[0]["pickup_otp"], code.strip()):
            return None
        with self.db.tx() as c:
            c.execute("UPDATE ngo_confirmations SET picked_up_at=? WHERE confirmation_id=? AND picked_up_at IS NULL",
                      (iso(utcnow()), rows[0]["confirmation_id"]))
        return self.get_confirmation(rows[0]["confirmation_id"])

    def partner_confirmations(self, partner_phone: str) -> list[dict[str, Any]]:
        return [dict(r) for r in self.db.query(
            "SELECT * FROM ngo_confirmations WHERE partner_phone=? AND status='ACCEPTED' ORDER BY assigned_at DESC",
            (partner_phone,))]

    def verify_otp(self, match_id: str, ngo_id: str, otp: str) -> Optional[dict[str, Any]]:
        """Drop check: the partner enters the code shown on the NGO's screen. Only after pickup."""
        rows = self.db.query("SELECT * FROM ngo_confirmations WHERE match_id=? AND ngo_id=? AND status='ACCEPTED' "
                             "AND otp IS NOT NULL AND picked_up_at IS NOT NULL ORDER BY requested_at DESC LIMIT 1",
                             (match_id, ngo_id))
        if not rows or not secrets.compare_digest(rows[0]["otp"], otp.strip()):
            return None
        with self.db.tx() as c:
            c.execute("UPDATE ngo_confirmations SET otp_verified_at=? WHERE confirmation_id=? AND otp_verified_at IS NULL",
                      (iso(utcnow()), rows[0]["confirmation_id"]))
        return self.get_confirmation(rows[0]["confirmation_id"])

    def list_confirmations(self, match_id: Optional[str] = None, ngo_id: Optional[str] = None,
                           status: Optional[str] = None) -> list[dict[str, Any]]:
        sql, params = "SELECT * FROM ngo_confirmations WHERE 1=1", []
        if match_id:
            sql += " AND match_id=?"; params.append(match_id)
        if ngo_id:
            sql += " AND ngo_id=?"; params.append(ngo_id)
        if status:
            sql += " AND status=?"; params.append(status)
        sql += " ORDER BY requested_at"
        return [dict(r) for r in self.db.query(sql, tuple(params))]

    def confirmation_history(self, ngo_id: str) -> dict[str, Any]:
        """Observed behaviour of this NGO across all past matches (agent memory)."""
        rows = self.db.query("SELECT status, food_category, requested_at, responded_at FROM ngo_confirmations "
                             "WHERE ngo_id=? AND status!='PENDING'", (ngo_id,))
        total = len(rows)
        accepted = sum(1 for r in rows if r["status"] == "ACCEPTED")
        no_resp = sum(1 for r in rows if r["status"] == "NO_RESPONSE")
        conf_minutes = []
        cats: dict[str, dict[str, int]] = {}
        for r in rows:
            cat = r["food_category"] or "unknown"
            cats.setdefault(cat, {"requests": 0, "accepted": 0})
            cats[cat]["requests"] += 1
            if r["status"] == "ACCEPTED":
                cats[cat]["accepted"] += 1
            if r["responded_at"] and r["status"] in ("ACCEPTED", "REJECTED"):
                try:
                    d = datetime.fromisoformat(r["responded_at"]) - datetime.fromisoformat(r["requested_at"])
                    conf_minutes.append(d.total_seconds() / 60)
                except ValueError:
                    pass
        return {
            "requests": total, "accepted": accepted, "no_response": no_resp,
            "avg_confirmation_minutes": (sum(conf_minutes) / len(conf_minutes)) if conf_minutes else None,
            "category_stats": cats,
        }

    # ------------------------------------------------------------------ submissions (Food Agent side)
    _SUB_JSON = ("form", "assessment", "match_result")

    def create_submission(self, submission_id: str, mode: str, restaurant_id: str, food_name: str, form: dict,
                          image_path: str) -> int:
        now = iso(utcnow())
        with self.db.tx() as c:
            seq = (c.execute("SELECT COALESCE(MAX(seq), 1000) FROM submissions").fetchone()[0]) + 1
            c.execute("INSERT INTO submissions(submission_id,seq,mode,restaurant_id,food_name,stage,form,image_path,"
                      "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      (submission_id, seq, mode, restaurant_id, food_name, "RECEIVED", json.dumps(form, default=str),
                       image_path, now, now))
        return seq

    def update_submission(self, submission_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields["updated_at"] = iso(utcnow())
        cols, vals = [], []
        for k, v in fields.items():
            cols.append(f"{k}=?")
            vals.append(json.dumps(v, default=str) if k in self._SUB_JSON and v is not None else v)
        vals.append(submission_id)
        with self.db.tx() as c:
            c.execute(f"UPDATE submissions SET {', '.join(cols)} WHERE submission_id=?", tuple(vals))

    def get_submission(self, submission_id: str) -> Optional[dict[str, Any]]:
        rows = self.db.query("SELECT * FROM submissions WHERE submission_id=?", (submission_id,))
        if not rows:
            return None
        d = dict(rows[0])
        for k in self._SUB_JSON:
            d[k] = json.loads(d[k]) if d.get(k) else None
        return d

    def list_submissions(self, limit: int = 20, restaurant_id: Optional[str] = None) -> list[dict[str, Any]]:
        where, params = ("WHERE restaurant_id=? ", (restaurant_id, limit)) if restaurant_id else ("", (limit,))
        return [dict(r) for r in self.db.query(
            "SELECT submission_id, mode, food_name, stage, match_id, created_at FROM submissions "
            f"{where}ORDER BY seq DESC LIMIT ?", params)]

    # ------------------------------------------------------------------ events
    def add_event(self, match_id: str, kind: str, message: str, data: Optional[dict] = None) -> int:
        with self.db.tx() as c:
            cur = c.execute("INSERT INTO agent_events(match_id,ts,kind,message,data) VALUES(?,?,?,?,?)",
                            (match_id, iso(utcnow()), kind, message, json.dumps(data, default=str) if data else None))
            return int(cur.lastrowid)

    def list_events(self, match_id: str, after_id: int = 0) -> list[dict[str, Any]]:
        rows = self.db.query("SELECT id, ts, kind, message, data FROM agent_events WHERE match_id=? AND id>? ORDER BY id",
                             (match_id, after_id))
        out = []
        for r in rows:
            d = dict(r)
            d["data"] = json.loads(d["data"]) if d["data"] else None
            out.append(d)
        return out


def _short_validation_error(e: Exception) -> str:
    if isinstance(e, ValidationError):
        errs = e.errors()
        return "; ".join(f"{'.'.join(str(x) for x in er['loc'])}: {er['msg']}" for er in errs[:3])
    return str(e)[:200]
