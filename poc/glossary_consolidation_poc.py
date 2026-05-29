#!/usr/bin/env python3
"""PoC for whole-list glossary candidate consolidation.

This script intentionally uses a compact JSON payload. It can run in dry-run
mode to estimate size, or call a Chat Completions compatible endpoint when an
API key is available.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from collections import defaultdict


DEFAULT_MODEL = "gpt-5.4-nano"
DEFAULT_BASE_URL = "https://api.openai.com/v1"
REASONING_EFFORT_ALIASES = {
    "": "",
    "small": "low",
    "tiny": "minimal",
    "none": "none",
    "minimal": "minimal",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "xhigh": "xhigh",
}


def first_child_value(entry: dict[str, Any], key: str) -> Any:
    for child in entry.get("children") or []:
        if isinstance(child, dict) and child.get(key) not in (None, ""):
            return child.get(key)
    return None


def compact_entry(entry: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        "i": index,
        "id": entry.get("id", ""),
        "cat": entry.get("category", ""),
        "source": entry.get("ja", ""),
        "target": entry.get("en", ""),
        "abbr": entry.get("abbr", ""),
        "formula": entry.get("formula", ""),
        "display": entry.get("displayText", ""),
        "page": first_child_value(entry, "page"),
        "snippet": first_child_value(entry, "snippet") or "",
    }


def with_short_ids(candidates: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[str, str]]:
    id_map: dict[str, str] = {}
    out: list[dict[str, Any]] = []
    for index, candidate in enumerate(candidates, start=1):
        short_id = f"c{index:03d}"
        original_id = str(candidate.get("id", ""))
        id_map[short_id] = original_id
        item = dict(candidate)
        item["originalId"] = original_id
        item["id"] = short_id
        out.append(item)
    return out, id_map


def load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#") or "=" not in text:
            continue
        key, value = text.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def chunked(values: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [values[i:i + size] for i in range(0, len(values), size)]


def normalize_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    return "".join(ch for ch in text if ch.isalnum())


def candidate_terms(candidate: dict[str, Any]) -> list[str]:
    values = [
        candidate.get("source"),
        candidate.get("target"),
        candidate.get("abbr"),
        candidate.get("formula"),
        candidate.get("display"),
    ]
    return [normalize_text(value) for value in values if normalize_text(value)]


def has_relation(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_terms = candidate_terms(left)
    right_terms = candidate_terms(right)
    if not left_terms or not right_terms:
        return False

    for a in left_terms:
        for b in right_terms:
            if a == b:
                return True
            if len(a) >= 4 and len(b) >= 4 and (a in b or b in a):
                return True

    left_snippet = normalize_text(left.get("snippet"))
    right_snippet = normalize_text(right.get("snippet"))
    for a in left_terms:
        if len(a) >= 3 and a in right_snippet:
            return True
    for b in right_terms:
        if len(b) >= 3 and b in left_snippet:
            return True
    return False


def risk_group_batches(candidates: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    if size <= 0:
        return [candidates]

    by_page: dict[Any, list[int]] = defaultdict(list)
    by_key: dict[str, list[int]] = defaultdict(list)
    parent = list(range(len(candidates)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        root_left = find(left)
        root_right = find(right)
        if root_left != root_right:
            parent[root_right] = root_left

    for index, candidate in enumerate(candidates):
        page = candidate.get("page")
        if page not in (None, ""):
            by_page[page].append(index)
        for key in candidate_terms(candidate):
            if len(key) >= 2:
                by_key[key].append(index)

    for indexes in by_key.values():
        for index in indexes[1:]:
            union(indexes[0], index)

    def page_sort_value(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 999999

    def candidate_sort_value(candidate: dict[str, Any]) -> int:
        candidate_id = str(candidate.get("id", ""))
        if candidate_id.startswith("c") and candidate_id[1:].isdigit():
            return int(candidate_id[1:])
        return int(candidate.get("i", 999999))

    page_values = sorted(by_page, key=page_sort_value)
    for page in page_values:
        nearby = list(by_page.get(page) or [])
        page_number = page_sort_value(page)
        for adjacent in (page_number - 1, page_number + 1):
            if adjacent in by_page:
                nearby.extend(by_page[adjacent])
        for offset, left in enumerate(nearby):
            for right in nearby[offset + 1:]:
                if has_relation(candidates[left], candidates[right]):
                    union(left, right)

    components: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for index, candidate in enumerate(candidates):
        components[find(index)].append(candidate)

    groups = sorted(
        components.values(),
        key=lambda group: (
            min(page_sort_value(item.get("page")) for item in group),
            min(candidate_sort_value(item) for item in group),
        ),
    )

    batches: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    for group in groups:
        if current and len(current) + len(group) > size:
            batches.append(current)
            current = []
        if len(group) > size:
            batches.extend(chunked(group, size))
            continue
        current.extend(group)
    if current:
        batches.append(current)
    return batches


def estimate_tokens(text: str) -> int:
    return (len(text) + 3) // 4


def normalize_reasoning_effort(value: str) -> str:
    key = (value or "").strip().lower()
    if key not in REASONING_EFFORT_ALIASES:
        allowed = ", ".join(sorted(k for k in REASONING_EFFORT_ALIASES if k))
        raise ValueError(f"unsupported reasoning effort: {value!r}; allowed: {allowed}")
    return REASONING_EFFORT_ALIASES[key]


def build_prompt(candidates: list[dict[str, Any]]) -> str:
    return f"""You consolidate glossary candidates for a Japanese lecture subtitle correction app.

Task:
- Merge entries that represent the same concept.
- Pair source and target text only when both strings are present in candidates/snippets/pages.
- Do not invent translations, explanations, or new terms.
- Drop lecture titles, chapter/section headings, schedule items, references, URLs, and sentence-like generic phrases.
- Keep single math symbols/formulas only as correction-only candidates, not formal dictionary entries.
- Fix category misuse: Optimizer, Deep Learning, Regularization, Batch Norm etc. are terms, not abbreviations. Abbreviation is for forms like SGD/GPU/TPU.
- Prefer compact output. No desc, no note, no long reason text.
- Every input id must appear exactly once, either in canonical[].sourceIds or dropped[].sourceIds.
- If unsure, keep the item as use="review"; do not silently omit it.

Desired examples:

Example A: pair existing source/target candidates.
Input candidates:
- id=A1, cat=term, source="深層学習", target="", page=1
- id=A2, cat=abbreviation, source="", target="Deep Learning", page=1
Desired output:
- canonical: cat=term, source="深層学習", target="Deep Learning", abbr="", sourceIds=["A1","A2"], use="formal", reason="paired"

Example B: drop headings but keep the real term.
Input candidates:
- id=B1, cat=term, source="Transformer基礎", target="", page=2
- id=B2, cat=proper_noun, source="Transformer", target="Transformer", page=2
Desired output:
- canonical: cat=proper_noun, source="Transformer", target="Transformer", sourceIds=["B2"], use="correction", reason="paired"
- dropped: sourceIds=["B1"], reason="heading"

Example C: fix category misuse, not abbreviation.
Input candidates:
- id=C1, cat=term, source="最適化アルゴリズム", target="", abbr="Optimizer", page=5
- id=C2, cat=abbreviation, source="", target="optimizer", page=5
Desired output:
- canonical: cat=term, source="最適化アルゴリズム", target="Optimizer", abbr="", sourceIds=["C1","C2"], use="review", reason="category_fixed"

Example D: abbreviations require a real short form.
Input candidates:
- id=D1, cat=abbreviation, source="GPU", target="Graphics Processing Unit", page=61
Desired output:
- canonical: cat=abbreviation, source="GPU", target="Graphics Processing Unit", abbr="GPU", sourceIds=["D1"], use="formal", reason="paired"

Example E: single symbols are useful for correction, not formal export.
Input candidates:
- id=E1, cat=formula, formula="eta", display="η", page=11
Desired output:
- canonical: cat=formula, formula="eta", display="η", sourceIds=["E1"], use="correction", reason="formula_correction"

Example F: weak phrases are not glossary terms.
Input candidates:
- id=F1, cat=term, source="実践的な方法論", target="", page=5
Desired output:
- dropped: sourceIds=["F1"], reason="weak_phrase"

Output strict JSON:
{{
  "canonical": [
    {{
      "cat": "term|proper_noun|formula|abbreviation|reference",
      "source": "",
      "target": "",
      "abbr": "",
      "formula": "",
      "display": "",
      "sourceIds": ["original id"],
      "pages": [1],
      "use": "formal|correction|review|disabled",
      "reason": "paired|merged|formula_correction|heading_dropped|reference|weak_phrase|missing_pair|category_fixed"
    }}
  ],
  "dropped": [
    {{"sourceIds": ["original id"], "reason": "heading|sentence|reference|duplicate|weak_phrase"}}
  ]
}}

Candidates:
{json.dumps(candidates, ensure_ascii=False, separators=(",", ":"))}
"""


def post_chat_completion(
    *,
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    max_output_tokens: int,
    reasoning_effort: str,
    timeout: int,
) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "max_completion_tokens": max_output_tokens,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": "Return strict JSON only. Be concise."},
            {"role": "user", "content": prompt},
        ],
    }
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        raw = response.read().decode("utf-8")
    return json.loads(raw)


def parse_response_content(response: dict[str, Any]) -> dict[str, Any]:
    content = response.get("choices", [{}])[0].get("message", {}).get("content", "")
    if not content:
        raise RuntimeError("response did not include message content")
    return json.loads(content)


def collect_result_ids(parsed: dict[str, Any]) -> set[str]:
    ids: set[str] = set()
    for key in ("canonical", "dropped"):
        values = parsed.get(key) or []
        if not isinstance(values, list):
            continue
        for item in values:
            if not isinstance(item, dict):
                continue
            for source_id in item.get("sourceIds") or []:
                if isinstance(source_id, str):
                    ids.add(source_id)
    return ids


def completion_details(usage: dict[str, Any]) -> dict[str, Any]:
    details = usage.get("completion_tokens_details")
    return details if isinstance(details, dict) else {}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="self-made glossary JSON")
    parser.add_argument("--output", required=True, help="output report JSON")
    parser.add_argument("--model", default=os.environ.get("OPENAI_MODEL", DEFAULT_MODEL))
    parser.add_argument("--base-url", default=os.environ.get("OPENAI_BASE_URL", DEFAULT_BASE_URL))
    parser.add_argument("--env-file", default="", help="optional .env file; key is not printed")
    parser.add_argument("--batch-size", type=int, default=0, help="0 means all candidates in one request")
    parser.add_argument("--id-mode", choices=["original", "short"], default="original")
    parser.add_argument("--batch-strategy", choices=["plain", "risk-groups"], default="plain")
    parser.add_argument("--max-output-tokens", type=int, default=12000)
    parser.add_argument("--reasoning-effort", default="", help="OpenAI reasoning_effort; 'small' aliases to 'low'")
    parser.add_argument("--timeout", type=int, default=180)
    parser.add_argument("--run", action="store_true", help="actually call API")
    args = parser.parse_args()
    reasoning_effort = normalize_reasoning_effort(args.reasoning_effort)

    if args.env_file:
      load_env_file(Path(args.env_file))

    input_path = Path(args.input)
    entries = json.loads(input_path.read_text(encoding="utf-8"))
    candidates = [compact_entry(entry, idx) for idx, entry in enumerate(entries)]
    id_map: dict[str, str] = {}
    if args.id_mode == "short":
        candidates, id_map = with_short_ids(candidates)
    if args.batch_strategy == "risk-groups":
        batches = risk_group_batches(candidates, args.batch_size)
    else:
        batches = [candidates] if args.batch_size <= 0 else chunked(candidates, args.batch_size)

    report: dict[str, Any] = {
        "input": str(input_path),
        "model": args.model,
        "reasoningEffort": reasoning_effort,
        "requestedReasoningEffort": args.reasoning_effort,
        "idMode": args.id_mode,
        "idMap": id_map,
        "batchStrategy": args.batch_strategy,
        "batchSize": args.batch_size or "all",
        "candidateCount": len(candidates),
        "batches": [],
        "ranApi": False,
    }

    api_key = os.environ.get("OPENAI_API_KEY", "")
    for batch_index, batch in enumerate(batches):
        prompt = build_prompt(batch)
        batch_report: dict[str, Any] = {
            "batchIndex": batch_index,
            "candidateCount": len(batch),
            "promptChars": len(prompt),
            "estimatedPromptTokens": estimate_tokens(prompt),
        }
        if args.run:
            if not api_key:
                raise RuntimeError("OPENAI_API_KEY is not set")
            started = time.time()
            response = post_chat_completion(
                base_url=args.base_url,
                api_key=api_key,
                model=args.model,
                prompt=prompt,
                max_output_tokens=args.max_output_tokens,
                reasoning_effort=reasoning_effort,
                timeout=args.timeout,
            )
            parsed = parse_response_content(response)
            usage = response.get("usage") or {}
            details = completion_details(usage)
            input_ids = {str(item.get("id", "")) for item in batch if item.get("id")}
            covered_ids = collect_result_ids(parsed)
            missing_ids = sorted(input_ids - covered_ids)
            batch_report.update({
                "durationSec": round(time.time() - started, 2),
                "usage": usage,
                "finishReason": response.get("choices", [{}])[0].get("finish_reason"),
                "reasoningTokens": details.get("reasoning_tokens", 0),
                "canonicalCount": len(parsed.get("canonical") or []),
                "droppedCount": len(parsed.get("dropped") or []),
                "coveredInputIds": len(covered_ids & input_ids),
                "missingInputIds": missing_ids,
                "result": parsed,
            })
            report["ranApi"] = True
        report["batches"].append(batch_report)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "candidateCount": report["candidateCount"],
        "batchSize": report["batchSize"],
        "batches": len(report["batches"]),
        "ranApi": report["ranApi"],
        "maxEstimatedPromptTokens": max(batch["estimatedPromptTokens"] for batch in report["batches"]),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        print(f"HTTP {exc.code}: {detail}", file=sys.stderr)
        raise SystemExit(1)
