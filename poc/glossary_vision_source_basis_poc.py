"""
Compare mini/nano behavior for glossary source-basis extraction.

This PoC sends PDF page text plus the rendered page image in one request and
asks the model to label each value as document_text/page_image/missing/unknown.
It is intentionally outside the app pipeline so we can test prompt behavior
without changing production code.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from typing import Any

import pdfplumber
import pypdfium2 as pdfium
from dotenv import load_dotenv
from openai import OpenAI


ROOT = Path(__file__).resolve().parents[1]
POC_ENV = ROOT / "poc" / ".env"
DEFAULT_MODELS = ["gpt-5.4-mini", "gpt-5.4-nano"]
DEFAULT_PAGES = [1, 2]


PROMPT_TEMPLATE = """You extract glossary candidates from a technical PDF page.

You receive:
1. PDF text extracted by a text layer parser.
2. A rendered image of the same page.

Task:
- Extract only terms useful for subtitle transcription correction or English subtitle translation.
- Do not add new terms.
- Do not translate terms that are not visible in either the PDF text or the page image.
- For each extracted field, label where that exact visible value came from.

sourceBasis rules:
- "document_text": the exact/normalized value is present in the PDF text below.
- "page_image": the value is visible in the page image but not present in the PDF text below.
- "missing": the field is empty.
- "unknown": use only if you cannot determine the basis.

Return JSON only:
{
  "candidates": [
    {
      "text": "",
      "category": "term" | "proper_noun" | "formula" | "abbreviation" | "reference",
      "page": 1,
      "snippet": "",
      "ja": "",
      "en": "",
      "formula": "",
      "displayText": "",
      "sourceBasis": "document_text" | "page_image" | "unknown",
      "sourceFields": {
        "ja": "document_text" | "page_image" | "missing" | "unknown",
        "en": "document_text" | "page_image" | "missing" | "unknown",
        "formula": "document_text" | "page_image" | "missing" | "unknown",
        "displayText": "document_text" | "page_image" | "missing" | "unknown"
      }
    }
  ]
}

PDF page: __PAGE_NUMBER__

PDF text:
__PAGE_TEXT__
"""


def load_env() -> None:
    if POC_ENV.exists():
        load_dotenv(POC_ENV)
    load_dotenv()


def normalize_text(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value.strip().lower())
    return re.sub(r"\s+", " ", normalized)


def text_contains(page_text: str, value: str) -> bool:
    needle = normalize_text(value)
    if not needle:
        return True
    return needle in normalize_text(page_text)


def extract_page_text(pdf_path: Path, page_number: int, max_chars: int) -> str:
    with pdfplumber.open(str(pdf_path)) as pdf:
        page = pdf.pages[page_number - 1]
        text = page.extract_text(x_tolerance=1, y_tolerance=3) or ""
    return text[:max_chars]


def render_page_data_url(pdf_path: Path, page_number: int, scale: float, jpeg_quality: int) -> str:
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_number - 1]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        import io

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=jpeg_quality, optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    finally:
        pdf.close()


def parse_json_response(content: str) -> dict[str, Any]:
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


def call_model(client: OpenAI, model: str, page_number: int, page_text: str, image_data_url: str, max_output_tokens: int) -> dict[str, Any]:
    prompt = PROMPT_TEMPLATE.replace("__PAGE_NUMBER__", str(page_number)).replace("__PAGE_TEXT__", page_text)
    response = client.chat.completions.create(
        model=model,
        temperature=0,
        max_completion_tokens=max_output_tokens,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": "You extract glossary candidates from PDF text and page images. Return strict JSON only.",
            },
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url, "detail": "high"}},
                ],
            },
        ],
    )
    choice = response.choices[0]
    content = choice.message.content or "{}"
    parsed = parse_json_response(content)
    usage = response.usage.model_dump() if response.usage else {}
    return {
        "model": model,
        "finish_reason": choice.finish_reason,
        "usage": usage,
        "raw_content_chars": len(content),
        "parsed": parsed,
    }


def summarize_result(model_result: dict[str, Any], page_text: str) -> dict[str, Any]:
    candidates = model_result.get("parsed", {}).get("candidates", [])
    if not isinstance(candidates, list):
        candidates = []

    basis_counts: dict[str, int] = {}
    field_counts: dict[str, int] = {}
    document_claim_failures: list[dict[str, Any]] = []
    page_image_claims_text_present: list[dict[str, Any]] = []

    for idx, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            continue
        basis = str(candidate.get("sourceBasis", "missing"))
        basis_counts[basis] = basis_counts.get(basis, 0) + 1
        source_fields = candidate.get("sourceFields", {})
        if not isinstance(source_fields, dict):
            source_fields = {}
        for field in ["ja", "en", "formula", "displayText"]:
            source = str(source_fields.get(field, "missing"))
            field_counts[f"{field}:{source}"] = field_counts.get(f"{field}:{source}", 0) + 1
            value = str(candidate.get(field, "") or "")
            if source == "document_text" and value and not text_contains(page_text, value):
                document_claim_failures.append({"index": idx, "field": field, "value": value, "text": candidate.get("text", "")})
            if source == "page_image" and value and text_contains(page_text, value):
                page_image_claims_text_present.append({"index": idx, "field": field, "value": value, "text": candidate.get("text", "")})

    return {
        "candidate_count": len(candidates),
        "basis_counts": basis_counts,
        "field_counts": field_counts,
        "document_claim_failures": document_claim_failures,
        "page_image_claims_text_present": page_image_claims_text_present,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True, help="PDF path")
    parser.add_argument("--pages", default=",".join(str(p) for p in DEFAULT_PAGES), help="Comma-separated 1-based pages")
    parser.add_argument("--models", default=",".join(DEFAULT_MODELS), help="Comma-separated models")
    parser.add_argument("--max-text-chars", type=int, default=5000)
    parser.add_argument("--max-output-tokens", type=int, default=3000)
    parser.add_argument("--image-scale", type=float, default=1.6)
    parser.add_argument("--jpeg-quality", type=int, default=82)
    parser.add_argument("--out", default=str(ROOT / "docs" / "research" / "20260528_glossary_vision_source_basis_poc.json"))
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set. Put it in poc/.env or the environment.")

    pdf_path = Path(args.pdf).expanduser().resolve()
    pages = [int(x.strip()) for x in args.pages.split(",") if x.strip()]
    models = [x.strip() for x in args.models.split(",") if x.strip()]

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    results: list[dict[str, Any]] = []
    for page_number in pages:
        page_text = extract_page_text(pdf_path, page_number, args.max_text_chars)
        image_data_url = render_page_data_url(pdf_path, page_number, args.image_scale, args.jpeg_quality)
        for model in models:
            print(f"running model={model} page={page_number}", flush=True)
            model_result = call_model(client, model, page_number, page_text, image_data_url, args.max_output_tokens)
            summary = summarize_result(model_result, page_text)
            results.append({
                "page": page_number,
                "model": model,
                "pageTextChars": len(page_text),
                "summary": summary,
                **model_result,
            })
            print(
                f"  candidates={summary['candidate_count']} basis={summary['basis_counts']} "
                f"doc_fail={len(summary['document_claim_failures'])} "
                f"image_but_text={len(summary['page_image_claims_text_present'])}",
                flush=True,
            )

    output = {
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "pdf": str(pdf_path),
        "pages": pages,
        "models": models,
        "promptKind": "single_request_text_plus_image_source_basis",
        "results": results,
    }
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
