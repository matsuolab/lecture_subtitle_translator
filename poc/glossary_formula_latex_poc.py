"""
PoC: extract formula glossary entries with displayText and LaTeX from PDF page images.

This mirrors the production glossary prompt's formula notation rules, but narrows
the task to math expressions on selected pages so we can inspect accuracy.
"""

from __future__ import annotations

import argparse
import base64
import html
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

import pdfplumber
import pypdfium2 as pdfium
from dotenv import load_dotenv
from openai import OpenAI


ROOT = Path(__file__).resolve().parents[1]
POC_ENV = ROOT / "poc" / ".env"

FORMULA_NOTATION_RULES = r"""Formula notation rules:
- displayText: human-readable Unicode plus ^/_ notation.
  - Superscripts use ^x or ^(...), e.g. θ^(t+1), x^2, e^(-x), x^(i,j).
  - Subscripts use _x or _(...), e.g. x_i, a_(i,j), L_train.
  - Keep Greek letters and operators as Unicode where visible: θ, ∇, η, ε, Σ, ∂, ∈, ≤, ≥, ⋯.
  - Keep continuous operators and parentheses accurately: = − + ⋅ / ( ) [ ] { }.
- latex: standard LaTeX notation for rendering and later glossary use.
  Example: "\\theta^{(t+1)} = \\theta^{(t)} - \\eta \\nabla E(\\theta^{(t)})"
- formula: ASCII-compatible search key. Leave empty if it would lose too much information.

Absolute prohibitions:
- Do not copy broken PDF text-layer notation into displayText/latex when superscripts, subscripts, Greek letters, or fractions are visually recoverable from the page image.
- Do not change the mathematical meaning: do not reorder terms, invent variables, or change coefficients.
- Do not infer formulas that are not visible on the page.
"""

PROMPT_TEMPLATE = """You extract mathematical expressions from a technical lecture slide.

You receive:
1. PDF text extracted from the text layer. It may be broken.
2. A rendered page image. Prefer the image for formula structure.

Target:
- Extract visible math expressions that are useful as subtitle glossary entries.
- Focus on formulas, variables, and technical mathematical notations.
- Ignore footer, copyright, page number, and ordinary prose.

{formula_rules}

Return JSON only:
{{
  "page": __PAGE_NUMBER__,
  "equations": [
    {{
      "label": "",
      "surroundingText": "",
      "displayText": "",
      "latex": "",
      "formula": "",
      "sourceBasis": "page_image" | "document_text" | "both" | "uncertain",
      "confidence": 0.0,
      "notes": ""
    }}
  ]
}}

PDF page: __PAGE_NUMBER__

PDF text layer:
__PAGE_TEXT__
"""


def load_env() -> None:
    if POC_ENV.exists():
        load_dotenv(POC_ENV)
    load_dotenv()


def extract_page_text(pdf_path: Path, page_number: int, max_chars: int) -> str:
    with pdfplumber.open(str(pdf_path)) as pdf:
        text = pdf.pages[page_number - 1].extract_text(x_tolerance=1, y_tolerance=3) or ""
    return text[:max_chars]


def render_page_jpeg(pdf_path: Path, page_number: int, scale: float, jpeg_quality: int, out_dir: Path) -> tuple[str, Path]:
    pdf = pdfium.PdfDocument(str(pdf_path))
    try:
        page = pdf[page_number - 1]
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil()
        out_dir.mkdir(parents=True, exist_ok=True)
        image_path = out_dir / f"formula_p{page_number}.jpg"
        image.save(image_path, format="JPEG", quality=jpeg_quality, optimize=True)
        encoded = base64.b64encode(image_path.read_bytes()).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}", image_path
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


def call_model(
    client: OpenAI,
    model: str,
    page_number: int,
    page_text: str,
    image_data_url: str,
    max_output_tokens: int,
) -> dict[str, Any]:
    prompt = (
        PROMPT_TEMPLATE
        .replace("{formula_rules}", FORMULA_NOTATION_RULES)
        .replace("__PAGE_NUMBER__", str(page_number))
        .replace("__PAGE_TEXT__", page_text)
    )
    response = client.chat.completions.create(
        model=model,
        temperature=0,
        max_completion_tokens=max_output_tokens,
        response_format={"type": "json_object"},
        messages=[
            {
                "role": "system",
                "content": "You read mathematical formulas from lecture slide images and return strict JSON.",
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
    return {
        "model": model,
        "finish_reason": choice.finish_reason,
        "usage": response.usage.model_dump() if response.usage else {},
        "parsed": parse_json_response(content),
        "raw_content": content,
    }


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def build_html_report(data: dict[str, Any]) -> str:
    cards = ""
    for page in data["pages"]:
        image_path = page["imagePath"]
        cards += f'<section class="page"><h2>Page {page["page"]}</h2><img src="{esc(image_path)}" alt="page {page["page"]}">'
        cards += "<details><summary>PDF text layer</summary><pre>" + esc(page["text"]) + "</pre></details>"
        for result in page["results"]:
            equations = result.get("parsed", {}).get("equations", [])
            cards += f'<div class="model"><h3>{esc(result["model"])} <span>{len(equations)} equations</span></h3>'
            cards += f'<p class="muted">finish={esc(result["finish_reason"])} / tokens={esc(result.get("usage", {}))}</p>'
            cards += "<table><thead><tr><th>#</th><th>label</th><th>displayText</th><th>LaTeX</th><th>formula key</th><th>basis</th><th>confidence</th><th>notes</th></tr></thead><tbody>"
            for idx, eq in enumerate(equations, 1):
                if not isinstance(eq, dict):
                    continue
                cards += (
                    f"<tr><td>{idx}</td><td>{esc(eq.get('label', ''))}</td>"
                    f"<td><code>{esc(eq.get('displayText', ''))}</code></td>"
                    f"<td><code>{esc(eq.get('latex', ''))}</code></td>"
                    f"<td><code>{esc(eq.get('formula', ''))}</code></td>"
                    f"<td>{esc(eq.get('sourceBasis', ''))}</td>"
                    f"<td>{esc(eq.get('confidence', ''))}</td>"
                    f"<td>{esc(eq.get('notes', ''))}</td></tr>"
                )
            cards += "</tbody></table></div>"
        cards += "</section>"

    return f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Formula LaTeX PoC</title>
<style>
body{{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#1f2937;margin:0;line-height:1.55}}
header{{background:#172033;color:white;padding:28px 36px}} header h1{{margin:0 0 8px}} header p{{margin:4px 0;color:#cbd5e1}}
main{{max-width:1400px;margin:auto;padding:24px 36px}} .page,.model{{background:white;border:1px solid #d9dee7;border-radius:8px;padding:18px;margin:18px 0;box-shadow:0 1px 2px rgba(15,23,42,.04)}}
img{{max-width:100%;border:1px solid #cbd5e1;border-radius:6px;background:white}} table{{width:100%;border-collapse:collapse}} th,td{{border-bottom:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}} th{{background:#eef2f7;color:#334155;font-size:13px}} code,pre{{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f1f5f9;border-radius:4px;padding:2px 4px}} pre{{white-space:pre-wrap;padding:12px}} .muted{{color:#64748b}} h3 span{{font-size:13px;color:#64748b;font-weight:500}}
</style></head><body><header><h1>Formula LaTeX PoC</h1><p>Production glossary formula rules + page image. Pages: {esc(data["targetPages"])}</p><p>PDF: {esc(data["pdf"])}</p><p>Created: {esc(data["createdAt"])}</p></header><main>{cards}</main></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--pages", default="16,19")
    parser.add_argument("--models", default="gpt-5.4-mini,gpt-5.4-nano")
    parser.add_argument("--max-text-chars", type=int, default=5000)
    parser.add_argument("--max-output-tokens", type=int, default=3000)
    parser.add_argument("--image-scale", type=float, default=2.0)
    parser.add_argument("--jpeg-quality", type=int, default=88)
    parser.add_argument("--out-json", default=str(ROOT / "docs" / "research" / "20260528_formula_latex_poc.json"))
    parser.add_argument("--out-html", default=str(ROOT / "docs" / "research" / "20260528_formula_latex_poc_report.html"))
    args = parser.parse_args()

    load_env()
    if not os.getenv("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is not set. Put it in poc/.env or the environment.")

    pdf_path = Path(args.pdf).resolve()
    pages = [int(x.strip()) for x in args.pages.split(",") if x.strip()]
    models = [x.strip() for x in args.models.split(",") if x.strip()]
    asset_dir = ROOT / "docs" / "research" / "assets" / "formula_latex_poc"

    client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
    page_results: list[dict[str, Any]] = []
    for page_number in pages:
        page_text = extract_page_text(pdf_path, page_number, args.max_text_chars)
        image_data_url, image_path = render_page_jpeg(pdf_path, page_number, args.image_scale, args.jpeg_quality, asset_dir)
        results: list[dict[str, Any]] = []
        for model in models:
            print(f"running model={model} page={page_number}", flush=True)
            result = call_model(client, model, page_number, page_text, image_data_url, args.max_output_tokens)
            eqs = result.get("parsed", {}).get("equations", [])
            print(f"  equations={len(eqs) if isinstance(eqs, list) else 'invalid'} finish={result['finish_reason']}", flush=True)
            results.append(result)
        page_results.append({
            "page": page_number,
            "text": page_text,
            "imagePath": str(image_path),
            "results": results,
        })

    output = {
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "pdf": str(pdf_path),
        "targetPages": pages,
        "models": models,
        "promptKind": "formula_latex_image_plus_text",
        "pages": page_results,
    }
    out_json = Path(args.out_json).resolve()
    out_html = Path(args.out_html).resolve()
    out_json.parent.mkdir(parents=True, exist_ok=True)
    out_json.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    out_html.write_text(build_html_report(output), encoding="utf-8")
    print(f"wrote {out_json}")
    print(f"wrote {out_html}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
