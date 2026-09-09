"""Model adapters for the harness.

A model is anything with ``name`` and ``answer(task_agent: dict) -> dict|str``.
Two kinds ship here:

* **Baselines** that need no network or keys. They exist so the benchmark
  page always has rows and so the grader's failure-mode taxonomy is
  exercised end to end. ``NaiveStringBaseline`` behaves like a careless
  script; ``ConfidentGuesser`` behaves like a model that never says NONE.
* **API clients** for Anthropic, OpenAI and Google, written on urllib so the
  package has no SDK dependencies. Each is enabled only when its key is in
  the environment (ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY).
"""
from __future__ import annotations

import json
import os
import random
import re
import time
import urllib.request
import urllib.error
from typing import Any, Optional

def load_dotenv(path: str = ".env") -> None:
    """Minimal .env loader: KEY=VALUE lines, no quotes processing beyond stripping. Never logs values."""
    try:
        for ln in open(path, encoding="utf-8"):
            ln = ln.strip()
            if not ln or ln.startswith("#") or "=" not in ln:
                continue
            k, v = ln.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except FileNotFoundError:
        pass


load_dotenv()

SYSTEM = (
    "You are an expert in HLA immunogenetics nomenclature. Answer the task exactly as instructed, "
    "in the JSON format specified, and nothing else."
)

# Bare-output clamp for hosted API models (prompt is harness config, not task
# content — task files and ids are untouched). Ollama already forces JSON via
# format:json; hosted models otherwise pad answers with prose, which is what
# truncated claude-sonnet-4-6 on 187/550 tasks at the old 600-token budget.
PROMPT_REV = "clamp-v1"
SYSTEM_STRICT = SYSTEM + (
    " Output ONLY the single JSON object — no prose before or after it, no markdown code fences, "
    "no restating the question. If the format includes a 'reasoning' field, keep it to one short "
    "sentence at most. Any text outside the JSON object is discarded unread."
)


def _prompt(task: dict) -> str:
    return f"{task['instructions']}\n\nINPUT:\n{json.dumps(task['input'], indent=2)}"


# --------------------------------------------------------------------------- baselines

class NaiveStringBaseline:
    """What a careless script does: string manipulation, no reference lookup.
    Truncates by splitting on ':'; answers NONE for groups; TRUE for validity;
    guesses serology from the first field; leaves history questions blank."""
    name = "baseline-naive-string"

    def answer(self, t: dict) -> dict:
        st, inp = t["subtype"], t["input"]
        a = inp.get("allele", "")
        fields = a.split("*")[1].split(":") if "*" in a else []
        loc = a.split("*")[0] if "*" in a else inp.get("locus", "")
        if st == "truncate":
            ans = f"{loc}*{':'.join(fields[:inp['fields']])}"
        elif st == "expand_ambiguity":
            ans = "1"
        elif st == "valid_name":
            ans = "TRUE"
        elif st == "locus_field":
            ans = f"{loc}:{'I' if loc in ('A', 'B', 'C') else 'II'}"
        elif st == "g_group":
            ans = f"{loc}*{':'.join(fields[:3])}G" if len(fields) >= 3 else f"{loc}*{':'.join(fields)}G"
        elif st in ("p_group", "null_trap"):
            ans = f"{loc}*{':'.join(fields[:2])}P"
        elif st == "same_group":
            a2 = inp["allele_b"].split("*")[1].split(":")
            ans = "TRUE" if fields[:2] == a2[:2] else "FALSE"
        elif st == "group_members_count":
            ans = "1"
        elif st == "serology":
            ans = str(int(fields[0])) if fields and fields[0].isdigit() else "NONE"
        elif st == "renamed_to":
            ans = inp["deleted_name"]
        elif st == "existed_at":
            ans = "TRUE"
        elif st == "first_release":
            ans = "3.00.0"
        elif st == "name_at_release":
            ans = inp["current_name"]
        elif st == "deleted_reason":
            ans = "identical_sequence"
        elif st == "new_in_release":
            ans = "0"
        elif st == "resolve_chain":
            d = inp["deleted_name"]
            ans = {"current_name": d, "g_group": d + "G", "serology": "NONE"}
        elif st == "typing_report_normalize":
            out = {}
            for part in inp["typing"].split(","):
                p = part.strip().replace("Cw*", "C*")
                if ":" not in p and "*" in p:  # legacy A*0201 -> A*02:01
                    l, d = p.split("*"); p = f"{l}*{d[:2]}:{d[2:4]}"
                l = p.split("*")[0]; f = p.split("*")[1].split(":")
                out[l] = f"{l}*{':'.join(f[:2])}"
            ans = out
        elif st == "near_miss":
            ans = f"{loc}*{':'.join(fields[:3])}G"
        elif st == "release_drift":
            ans = inp["current_name"]
        else:
            ans = "UNRESOLVABLE"
        return {"answer": ans, "confidence": "high", "flags": [], "reasoning": "string heuristics only"}


class ConfidentGuesser(NaiveStringBaseline):
    """Never says NONE or UNRESOLVABLE, never lowers confidence, never flags —
    the worst clinical behaviour, useful as the floor for calibration metrics."""
    name = "baseline-confident-guesser"

    def answer(self, t: dict) -> dict:
        r = super().answer(t)
        if r["answer"] in ("NONE", "UNRESOLVABLE"):
            a = t["input"].get("allele", "A*01:01")
            r["answer"] = a.split("*")[0] + "*" + ":".join(a.split("*")[1].split(":")[:2]) + "P"
        r["confidence"] = "high"; r["flags"] = []
        return r


class CautiousAbstainer:
    """Answers UNRESOLVABLE to everything with low confidence. Establishes
    what 'refuse everything' scores (it should score ~0 but never hallucinate)."""
    name = "baseline-cautious-abstainer"

    def answer(self, t: dict) -> dict:
        return {"answer": "UNRESOLVABLE", "confidence": "low", "flags": ["ambiguous_input"], "reasoning": "abstain"}


class ReferenceOracle:
    """Answers from the pinned reference (the generator's own truth). Used
    to validate the harness end-to-end; must score 100%."""
    name = "oracle-reference"

    def __init__(self, full_by_id: dict[str, dict]):
        self.full = full_by_id

    def answer(self, t: dict) -> dict:
        a = self.full[t["task_id"]]["answer"]
        return {"answer": a["canonical"], "confidence": a["expected_confidence"], "flags": list(a["expected_flags"]), "reasoning": ""}


# --------------------------------------------------------------------------- API clients (urllib, no SDKs)

def _post(url: str, headers: dict, body: dict, retries: int = 4, timeout: int = 120) -> dict:
    data = json.dumps(body).encode()
    for i in range(retries):
        req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", **headers})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 529) and i < retries - 1:
                time.sleep(2 ** i + random.random()); continue
            raise RuntimeError(f"{e.code} {e.read()[:300]!r}") from None
        except (urllib.error.URLError, TimeoutError):
            if i < retries - 1:
                time.sleep(2 ** i); continue
            raise


class AnthropicModel:
    def __init__(self, model: str, key: Optional[str] = None, max_tokens: int = 1600):
        self.model, self.key, self.max_tokens = model, key or os.environ["ANTHROPIC_API_KEY"], max_tokens
        self.name = f"anthropic/{model}"

    def answer(self, t: dict) -> str:
        # Prefilled '{' assistant turn: the model must continue the JSON object,
        # so it cannot open with prose or a code fence. We prepend it back.
        r = _post("https://api.anthropic.com/v1/messages",
                  {"x-api-key": self.key, "anthropic-version": "2023-06-01"},
                  {"model": self.model, "max_tokens": self.max_tokens, "system": SYSTEM_STRICT,
                   "messages": [{"role": "user", "content": _prompt(t)},
                                {"role": "assistant", "content": "{"}]})
        return "{" + "".join(b.get("text", "") for b in r.get("content", []))


class OpenAIModel:
    def __init__(self, model: str, key: Optional[str] = None, max_tokens: int = 1600):
        self.model, self.key, self.max_tokens = model, key or os.environ["OPENAI_API_KEY"], max_tokens
        self.name = f"openai/{model}"

    def answer(self, t: dict) -> str:
        r = _post("https://api.openai.com/v1/chat/completions", {"Authorization": f"Bearer {self.key}"},
                  {"model": self.model, "max_completion_tokens": self.max_tokens,
                   "response_format": {"type": "json_object"},
                   "messages": [{"role": "system", "content": SYSTEM_STRICT}, {"role": "user", "content": _prompt(t)}]})
        return r["choices"][0]["message"]["content"]


class GeminiModel:
    def __init__(self, model: str, key: Optional[str] = None, max_tokens: int = 600):
        self.model, self.key, self.max_tokens = model, key or os.environ["GOOGLE_API_KEY"], max_tokens
        self.name = f"google/{model}"

    def answer(self, t: dict) -> str:
        r = _post(f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={self.key}", {},
                  {"systemInstruction": {"parts": [{"text": SYSTEM_STRICT}]},
                   "contents": [{"role": "user", "parts": [{"text": _prompt(t)}]}],
                   "generationConfig": {"maxOutputTokens": self.max_tokens, "responseMimeType": "application/json"}})
        return "".join(p.get("text", "") for p in r["candidates"][0]["content"]["parts"])


class OllamaModel:
    """Local open-weight models via Ollama (http://localhost:11434). Zero API cost.
    Spec: ollama/<model>, e.g. ollama/llama3.1:8b, ollama/qwen2.5:14b, ollama/gemma3:12b.
    Set OLLAMA_HOST to point at another machine on the LAN."""

    def __init__(self, model: str, host: Optional[str] = None, max_tokens: int = 600):
        self.model = model
        self.host = (host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        self.max_tokens = max_tokens
        self.name = f"ollama/{model}"

    # Pin the context window: Ollama otherwise sizes it to the model's training context
    # (131k for gemma3), whose KV cache does not fit an 8 GB card + 32 GB host — the runner
    # crashed mid-run (llama-server exit 0xe06d7363) and 460/550 replies came back empty.
    # Prompts here are a few hundred tokens; 8k leaves ample room for num_predict.
    num_ctx = int(os.environ.get("HLA_BENCH_OLLAMA_NUM_CTX", "8192"))
    empty_retries = 3

    def answer(self, t: dict) -> str:
        body = {"model": self.model, "stream": False, "format": "json",
                "options": {"temperature": 0, "num_predict": self.max_tokens, "num_ctx": self.num_ctx},
                "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": _prompt(t)}]}
        content = ""
        for attempt in range(self.empty_retries):
            r = _post(f"{self.host}/api/chat", {}, body, timeout=600)
            content = r.get("message", {}).get("content", "") or ""
            if content.strip():
                break
            # An empty body with HTTP 200 is a degraded backend (crashed/restarting runner),
            # not a model answer: back off and ask again before recording it.
            time.sleep(5 * (attempt + 1))
        return content


BASELINES = {
    "baseline-naive-string": NaiveStringBaseline,
    "baseline-confident-guesser": ConfidentGuesser,
    "baseline-cautious-abstainer": CautiousAbstainer,
}


def resolve(spec: str, full_by_id: Optional[dict] = None):
    """'baseline-naive-string' | 'oracle' | 'anthropic/<model>' | 'openai/<model>' | 'google/<model>' | 'ollama/<model>'."""
    if spec in BASELINES:
        return BASELINES[spec]()
    if spec == "oracle":
        return ReferenceOracle(full_by_id or {})
    vendor, _, model = spec.partition("/")
    if vendor == "anthropic":
        return AnthropicModel(model)
    if vendor == "openai":
        return OpenAIModel(model)
    if vendor == "google":
        return GeminiModel(model)
    if vendor == "ollama":
        return OllamaModel(model)
    raise ValueError(f"unknown model spec {spec!r}")


def available_api_models() -> list[str]:
    """Model specs whose keys are present in the environment (used by `hla-bench auto`)."""
    out = []
    if os.environ.get("ANTHROPIC_API_KEY"):
        out += [f"anthropic/{m}" for m in os.environ.get("HLA_BENCH_ANTHROPIC_MODELS", "claude-sonnet-4-6").split(",")]
    if os.environ.get("OPENAI_API_KEY"):
        out += [f"openai/{m}" for m in os.environ.get("HLA_BENCH_OPENAI_MODELS", "gpt-5").split(",")]
    if os.environ.get("GOOGLE_API_KEY"):
        out += [f"google/{m}" for m in os.environ.get("HLA_BENCH_GOOGLE_MODELS", "gemini-2.5-pro").split(",")]
    if os.environ.get("HLA_BENCH_OLLAMA_MODELS"):          # e.g. "llama3.1:8b,qwen2.5:14b" on a box running Ollama
        out += [f"ollama/{m}" for m in os.environ["HLA_BENCH_OLLAMA_MODELS"].split(",")]
    return out
