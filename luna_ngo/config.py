"""Configuration loading.

All tunable numbers (weights, limits, timeouts, ETA model) live in
config/ngo_agent.json. Environment variables override LLM + runtime settings
so secrets never live in the file.
"""
from __future__ import annotations

import copy
import json
import os
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader (no dependency). Existing env vars win."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip('"').strip("'")
        if k and v and k not in os.environ:
            os.environ[k] = v


_load_dotenv(ROOT_DIR / ".env")

DEFAULT_CONFIG_PATH = ROOT_DIR / "config" / "ngo_agent.json"
DATA_DIR = Path(os.environ.get("LUNA_DATA_DIR", ROOT_DIR / "data"))

_config_cache: dict[str, Any] | None = None


def _deep_merge(base: dict, override: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def load_config(path: str | Path | None = None, overrides: dict | None = None) -> dict[str, Any]:
    cfg_path = Path(path or os.environ.get("LUNA_CONFIG", DEFAULT_CONFIG_PATH))
    with open(cfg_path, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    # env overrides (runtime / LLM only)
    env = os.environ
    llm = cfg.setdefault("llm", {})
    if env.get("LUNA_LLM_PROVIDER"):
        llm["provider"] = env["LUNA_LLM_PROVIDER"].lower()
    if env.get("LUNA_FOOD_LLM_PROVIDER"):
        llm["food_provider"] = env["LUNA_FOOD_LLM_PROVIDER"].lower()
    if env.get("LUNA_LLM_MODEL"):
        llm["anthropic_model"] = env["LUNA_LLM_MODEL"]
        llm["openai_model"] = env["LUNA_LLM_MODEL"]
    if env.get("LUNA_FOOD_LLM_MODEL"):
        llm["gemini_model"] = env["LUNA_FOOD_LLM_MODEL"]
    if env.get("LUNA_LLM_BASE_URL"):
        llm["openai_base_url"] = env["LUNA_LLM_BASE_URL"]
    if env.get("LUNA_ALLOW_RULE_FALLBACK"):
        cfg["agent_limits"]["allow_rule_based_fallback"] = env["LUNA_ALLOW_RULE_FALLBACK"].lower() in ("1", "true", "yes")
    if env.get("LUNA_MODE"):
        cfg.setdefault("flow", {})["mode"] = env["LUNA_MODE"].upper()
    if env.get("LUNA_DEMO_SCRIPT"):
        cfg.setdefault("flow", {})["demo_script"] = env["LUNA_DEMO_SCRIPT"]
    if overrides:
        cfg = _deep_merge(cfg, overrides)
    weights = cfg["match_score_weights"]
    total = sum(weights.values())
    if total <= 0:
        raise ValueError("match_score_weights must sum to a positive number")
    cfg["match_score_weights"] = {k: v / total for k, v in weights.items()}  # normalise
    return cfg


def get_config() -> dict[str, Any]:
    global _config_cache
    if _config_cache is None:
        _config_cache = load_config()
    return _config_cache


def set_config(cfg: dict[str, Any]) -> None:
    """Used by tests to inject a config."""
    global _config_cache
    _config_cache = cfg
