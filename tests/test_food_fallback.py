"""The food check's provider chain: retry temporary errors, then fall back, then give up cleanly."""
import pytest

from luna_ngo.agent.llm import FallbackProvider, LLMError, LLMProvider, build_provider


class Fake(LLMProvider):
    def __init__(self, name, errors):
        self.name, self.model, self.errors, self.calls = name, name, list(errors), 0

    def vision(self, *a):
        self.calls += 1
        if self.errors:
            raise LLMError(self.errors.pop(0))
        return f"ok from {self.name}"


def test_temporary_error_is_retried_on_the_same_model():
    p = Fake("flash", ["gemini vision API 503: high demand"])
    chain = FallbackProvider([p, Fake("lite", [])], sleep=lambda s: None)
    assert chain.vision("s", "img", "image/jpeg", "q") == "ok from flash"
    assert p.calls == 2 and chain.last_label == "flash:flash"


def test_falls_back_after_retries_and_records_who_answered():
    flash = Fake("flash", ["API 503"] * 3)
    lite = Fake("lite", [])
    chain = FallbackProvider([flash, lite], retries=2, sleep=lambda s: None)
    assert chain.vision("s", "i", "m", "q") == "ok from lite"
    assert flash.calls == 3 and chain.last_label == "lite:lite"


def test_non_temporary_error_skips_straight_to_next():
    bad_key = Fake("flash", ["gemini vision API 401: invalid key"])
    chain = FallbackProvider([bad_key, Fake("groq", [])], sleep=lambda s: None)
    assert chain.vision("s", "i", "m", "q") == "ok from groq"
    assert bad_key.calls == 1


def test_all_failing_raises_one_clear_error():
    chain = FallbackProvider([Fake("a", ["API 503"] * 9), Fake("b", ["API 500"] * 9)], retries=1, sleep=lambda s: None)
    with pytest.raises(LLMError, match="All providers failed"):
        chain.vision("s", "i", "m", "q")


def test_chain_skips_fallbacks_without_keys(monkeypatch, cfg):
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.delenv("GEMINI_API_KEY_2", raising=False)
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    p = build_provider(cfg, purpose="food")
    assert [x.model for x in p.providers] == [cfg["llm"]["gemini_model"], "gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]
    monkeypatch.setenv("GROQ_API_KEY", "q")
    assert build_provider(cfg, purpose="food").providers[-1].name == "groq"


def test_used_up_quota_skips_ahead_without_waiting():
    waits = []
    spent = Fake("flash", ["gemini vision API 429: You exceeded your current quota"])
    chain = FallbackProvider([spent, Fake("key2", [])], sleep=waits.append)
    assert chain.vision("s", "i", "m", "q") == "ok from key2"
    assert spent.calls == 1 and waits == []


def test_backup_key_joins_the_chain(monkeypatch, cfg):
    monkeypatch.setenv("GEMINI_API_KEY", "k1")
    monkeypatch.setenv("GEMINI_API_KEY_2", "k2")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    p = build_provider(cfg, purpose="food")
    keys = [x.api_key for x in p.providers]
    assert keys[:3] == ["k1", "k1", "k1"] and keys[3:] == ["k2", "k2", "k2"]
