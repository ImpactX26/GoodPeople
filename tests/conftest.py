import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from luna_ngo.config import load_config, set_config  # noqa: E402

FAST = {
    "demo": {"step_delay_seconds": 0, "default_response_delay_seconds": 0.05},
    "confirmation": {"demo_timeout_seconds": 0.6, "live_timeout_seconds": 0.6, "poll_interval_seconds": 0.02},
}


@pytest.fixture
def cfg():
    c = load_config(overrides=FAST)
    set_config(c)
    return c


@pytest.fixture
def svc(cfg):
    from luna_ngo.service import LunaService
    return LunaService(cfg, in_memory=True, provider_factory=lambda c: None)


def tool_result_map(messages):
    """Helper for scripted LLMs: returns (last_tool_name, last_result_dict)."""
    names = {}
    last = (None, None)
    for m in messages:
        if m["role"] == "assistant":
            for tc in m.get("tool_calls") or []:
                names[tc["id"]] = tc["name"]
        if m["role"] == "tool":
            last = (names.get(m["tool_call_id"]), json.loads(m["content"]))
    return last
