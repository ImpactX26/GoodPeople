"""LLM providers with native tool calling (no SDK dependency - plain HTTPS).

Provider-neutral transcript format used by the agent:
    {"role": "user", "content": str}
    {"role": "assistant", "text": str | None, "tool_calls": [{"id", "name", "arguments": dict}]}
    {"role": "tool", "tool_call_id": str, "name": str, "content": str}

Supported:
    anthropic  - Claude Messages API              (ANTHROPIC_API_KEY)
    gemini     - Google Gemini via its OpenAI-compatible endpoint (GEMINI_API_KEY);
                 the default for the food safety check (llm.food_provider)
    openai     - any OpenAI-compatible endpoint   (OPENAI_API_KEY / LUNA_LLM_API_KEY,
                 LUNA_LLM_BASE_URL for Groq, OpenRouter, Ollama, ...)
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx


class LLMError(RuntimeError):
    pass


class LLMProvider:
    name = "base"
    model = ""

    def vision(self, system: str, image_b64: str, mime: str, prompt: str) -> str:
        """Vision-language call: returns the model's text answer for an image."""
        raise LLMError(f"{self.name} does not support vision")

    def complete(self, system: str, messages: list[dict], tools: list[dict]) -> dict[str, Any]:
        """Returns {"text": str|None, "tool_calls": [{"id","name","arguments"}], "stop_reason": str}"""
        raise NotImplementedError

    @property
    def label(self) -> str:
        return f"{self.name}:{self.model}"


# --------------------------------------------------------------------------- Anthropic
class AnthropicProvider(LLMProvider):
    name = "anthropic"

    def __init__(self, api_key: str, model: str, max_tokens: int = 1200, temperature: float = 0.1,
                 timeout: float = 60, base_url: str = "https://api.anthropic.com",
                 transport: Optional[httpx.BaseTransport] = None):
        self.api_key, self.model, self.max_tokens, self.temperature = api_key, model, max_tokens, temperature
        self.client = httpx.Client(base_url=base_url, timeout=timeout, transport=transport)

    @staticmethod
    def to_wire(messages: list[dict]) -> list[dict]:
        out: list[dict] = []
        for m in messages:
            if m["role"] == "user":
                if out and out[-1]["role"] == "user":  # keep strict user/assistant alternation
                    prev = out[-1]["content"]
                    if isinstance(prev, str):
                        prev = [{"type": "text", "text": prev}]
                    out[-1]["content"] = prev + [{"type": "text", "text": m["content"]}]
                else:
                    out.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                blocks: list[dict] = []
                if m.get("text"):
                    blocks.append({"type": "text", "text": m["text"]})
                for tc in m.get("tool_calls") or []:
                    blocks.append({"type": "tool_use", "id": tc["id"], "name": tc["name"], "input": tc["arguments"]})
                out.append({"role": "assistant", "content": blocks or [{"type": "text", "text": "(no output)"}]})
            elif m["role"] == "tool":
                block = {"type": "tool_result", "tool_use_id": m["tool_call_id"], "content": m["content"]}
                if out and out[-1]["role"] == "user" and isinstance(out[-1]["content"], list):
                    out[-1]["content"].append(block)
                else:
                    out.append({"role": "user", "content": [block]})
        return out

    def complete(self, system: str, messages: list[dict], tools: list[dict]) -> dict[str, Any]:
        body = {
            "model": self.model, "max_tokens": self.max_tokens, "temperature": self.temperature,
            "system": system, "messages": self.to_wire(messages),
            "tools": [{"name": t["name"], "description": t["description"], "input_schema": t["parameters"]} for t in tools],
        }
        try:
            r = self.client.post("/v1/messages", json=body, headers={
                "x-api-key": self.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        except httpx.HTTPError as e:
            raise LLMError(f"Anthropic request failed: {e}") from e
        if r.status_code != 200:
            raise LLMError(f"Anthropic API {r.status_code}: {r.text[:300]}")
        data = r.json()
        text_parts, calls = [], []
        for b in data.get("content", []):
            if b.get("type") == "text":
                text_parts.append(b["text"])
            elif b.get("type") == "tool_use":
                calls.append({"id": b["id"], "name": b["name"], "arguments": b.get("input") or {}})
        return {"text": "\n".join(text_parts).strip() or None, "tool_calls": calls,
                "stop_reason": data.get("stop_reason", "")}


    def vision(self, system: str, image_b64: str, mime: str, prompt: str) -> str:
        body = {"model": self.model, "max_tokens": 900, "temperature": 0.0, "system": system,
                "messages": [{"role": "user", "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": mime, "data": image_b64}},
                    {"type": "text", "text": prompt}]}]}
        try:
            r = self.client.post("/v1/messages", json=body, headers={
                "x-api-key": self.api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        except httpx.HTTPError as e:
            raise LLMError(f"Anthropic vision request failed: {e}") from e
        if r.status_code != 200:
            raise LLMError(f"Anthropic API {r.status_code}: {r.text[:300]}")
        return "\n".join(b["text"] for b in r.json().get("content", []) if b.get("type") == "text")


# --------------------------------------------------------------------------- OpenAI-compatible
class OpenAICompatProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str, model: str, base_url: str, max_tokens: int = 1200, temperature: float = 0.1,
                 timeout: float = 60, transport: Optional[httpx.BaseTransport] = None,
                 extra_body: Optional[dict[str, Any]] = None):
        self.api_key, self.model, self.max_tokens, self.temperature = api_key, model, max_tokens, temperature
        self.extra_body = extra_body or {}  # provider-specific request fields (e.g. Gemini reasoning_effort)
        self.client = httpx.Client(base_url=base_url.rstrip("/"), timeout=timeout, transport=transport)

    @staticmethod
    def to_wire(system: str, messages: list[dict]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            if m["role"] == "user":
                out.append({"role": "user", "content": m["content"]})
            elif m["role"] == "assistant":
                msg: dict[str, Any] = {"role": "assistant", "content": m.get("text") or ""}
                if m.get("tool_calls"):
                    msg["tool_calls"] = [{"id": tc["id"], "type": "function",
                                          "function": {"name": tc["name"], "arguments": json.dumps(tc["arguments"])}}
                                         for tc in m["tool_calls"]]
                out.append(msg)
            elif m["role"] == "tool":
                out.append({"role": "tool", "tool_call_id": m["tool_call_id"], "content": m["content"]})
        return out

    def complete(self, system: str, messages: list[dict], tools: list[dict]) -> dict[str, Any]:
        body = {
            "model": self.model, "max_tokens": self.max_tokens, "temperature": self.temperature,
            "messages": self.to_wire(system, messages),
            "tools": [{"type": "function", "function": t} for t in tools], "tool_choice": "auto",
            **self.extra_body,
        }
        try:
            r = self.client.post("/chat/completions", json=body,
                                 headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name} request failed: {e}") from e
        if r.status_code != 200:
            raise LLMError(f"{self.name} API {r.status_code}: {r.text[:300]}")
        data = r.json()
        try:
            choice = data["choices"][0]
            msg = choice["message"]
        except (KeyError, IndexError) as e:
            raise LLMError(f"Malformed LLM response: {str(data)[:200]}") from e
        calls = []
        for tc in msg.get("tool_calls") or []:
            raw_args = tc["function"].get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
            except json.JSONDecodeError:
                args = {"__invalid_json__": raw_args}
            calls.append({"id": tc.get("id") or f"call_{len(calls)}", "name": tc["function"]["name"], "arguments": args})
        return {"text": (msg.get("content") or "").strip() or None, "tool_calls": calls,
                "stop_reason": choice.get("finish_reason", "")}


    def vision(self, system: str, image_b64: str, mime: str, prompt: str) -> str:
        body = {"model": self.model, "max_tokens": max(900, self.max_tokens), "temperature": 0.0, "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
                {"type": "text", "text": prompt}]}], **self.extra_body}
        try:
            r = self.client.post("/chat/completions", json=body, headers={"Authorization": f"Bearer {self.api_key}"})
        except httpx.HTTPError as e:
            raise LLMError(f"{self.name} vision request failed: {e}") from e
        if r.status_code != 200:
            raise LLMError(f"{self.name} vision API {r.status_code}: {r.text[:300]}")
        try:
            return r.json()["choices"][0]["message"].get("content") or ""
        except (KeyError, IndexError) as e:
            raise LLMError("Malformed vision response") from e


# --------------------------------------------------------------------------- Gemini
class GeminiProvider(OpenAICompatProvider):
    """Google Gemini through its OpenAI-compatible endpoint: tool calling + image input."""
    name = "gemini"


# --------------------------------------------------------------------------- fallback chain
RETRYABLE = ("API 429", "API 500", "API 502", "API 503", "API 504", "request failed", "timed out")


def _retryable(e: LLMError) -> bool:
    msg = str(e)
    # a used-up daily quota won't recover in seconds: move straight to the next model or key
    if "API 429" in msg and "quota" in msg.lower():
        return False
    return any(code in msg for code in RETRYABLE)


class FallbackProvider(LLMProvider):
    """Tries providers in order. Temporary errors (429/5xx/network) are retried with a short
    backoff on the same model first; anything else moves straight to the next provider.
    `last_label` records which model actually answered, for the audit trail."""
    name = "fallback"

    def __init__(self, providers: list[LLMProvider], retries: int = 2, backoff: tuple[float, ...] = (1.0, 3.0),
                 sleep=None):
        if not providers:
            raise ValueError("FallbackProvider needs at least one provider")
        self.providers, self.retries, self.backoff = providers, retries, backoff
        self.sleep = sleep or __import__("time").sleep
        self.model = providers[0].model
        self.last_label = providers[0].label

    @property
    def label(self) -> str:
        return " → ".join(p.label for p in self.providers)

    def _run(self, call: str, *args):
        errors: list[str] = []
        for p in self.providers:
            for attempt in range(self.retries + 1):
                try:
                    out = getattr(p, call)(*args)
                    self.last_label = p.label
                    return out
                except LLMError as e:
                    errors.append(f"{p.label}: {str(e)[:160]}")
                    if not _retryable(e) or attempt == self.retries:
                        break
                    self.sleep(self.backoff[min(attempt, len(self.backoff) - 1)])
        raise LLMError("All providers failed. " + " | ".join(errors))

    def vision(self, system: str, image_b64: str, mime: str, prompt: str) -> str:
        return self._run("vision", system, image_b64, mime, prompt)

    def complete(self, system: str, messages: list[dict], tools: list[dict]) -> dict[str, Any]:
        return self._run("complete", system, messages, tools)


def _food_fallbacks(llm: dict[str, Any], common: dict[str, Any]) -> list[LLMProvider]:
    """Extra providers for the food check, from llm.food_fallbacks; those without a key are skipped."""
    out: list[LLMProvider] = []
    for fb in llm.get("food_fallbacks") or []:
        kind = str(fb.get("provider", "")).lower()
        if kind == "gemini":
            key = os.environ.get(fb["key_env"]) if fb.get("key_env") else (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
            if key:
                extra = {"reasoning_effort": llm["gemini_reasoning_effort"]} if llm.get("gemini_reasoning_effort") else None
                prov = GeminiProvider(key, fb["model"], llm["gemini_base_url"], extra_body=extra,
                                      **{**common, "max_tokens": max(common["max_tokens"], llm.get("gemini_max_tokens", 0))})
                if fb.get("key_env"):
                    prov.name = f"gemini[{fb['key_env'].lower().replace('gemini_api_key', 'key')}]"
                out.append(prov)
        elif kind in ("groq", "openrouter", "openai", "openai_compatible", "ollama"):
            key = os.environ.get(fb.get("key_env") or "LUNA_LLM_API_KEY") or ("ollama" if kind == "ollama" else None)
            if key:
                prov = OpenAICompatProvider(key, fb["model"], fb["base_url"], **common)
                prov.name = kind
                out.append(prov)
    return out


# --------------------------------------------------------------------------- factory
def build_provider(cfg: dict[str, Any], purpose: str = "default") -> Optional[LLMProvider]:
    """Food check: primary provider + llm.food_fallbacks, wrapped in a FallbackProvider."""
    primary = _build_single(cfg, purpose)
    if purpose != "food":
        return primary
    llm = cfg["llm"]
    common = dict(max_tokens=llm["max_tokens"], temperature=llm["temperature"], timeout=llm["request_timeout_seconds"])
    chain = ([primary] if primary else []) + _food_fallbacks(llm, common)
    if not chain:
        return None
    return FallbackProvider(chain, retries=int(llm.get("food_retries", 2)),
                            backoff=tuple(llm.get("food_retry_backoff_seconds", [1.0, 3.0])))


def _build_single(cfg: dict[str, Any], purpose: str = "default") -> Optional[LLMProvider]:
    """Returns None when no credentials are configured (caller decides what to do).
    purpose="food" selects llm.food_provider (the food safety check); anything else llm.provider."""
    llm = cfg["llm"]
    key_name = "food_provider" if purpose == "food" and llm.get("food_provider") else "provider"
    provider = (llm.get(key_name) or "anthropic").lower()
    common = dict(max_tokens=llm["max_tokens"], temperature=llm["temperature"], timeout=llm["request_timeout_seconds"])
    if provider == "gemini":
        key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or os.environ.get("LUNA_LLM_API_KEY")
        if not key:
            return None
        extra = {"reasoning_effort": llm["gemini_reasoning_effort"]} if llm.get("gemini_reasoning_effort") else None
        return GeminiProvider(key, llm["gemini_model"], llm["gemini_base_url"], extra_body=extra,
                              **{**common, "max_tokens": max(common["max_tokens"], llm.get("gemini_max_tokens", 0))})
    if provider == "anthropic":
        key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("LUNA_LLM_API_KEY")
        if not key:
            return None
        return AnthropicProvider(key, llm["anthropic_model"], **common)
    if provider in ("openai", "openai_compatible", "groq", "openrouter", "ollama"):
        key = os.environ.get("LUNA_LLM_API_KEY") or os.environ.get("OPENAI_API_KEY") or ("ollama" if provider == "ollama" else None)
        if not key:
            return None
        return OpenAICompatProvider(key, llm["openai_model"], llm["openai_base_url"], **common)
    raise LLMError(f"Unknown LLM provider '{provider}'")
