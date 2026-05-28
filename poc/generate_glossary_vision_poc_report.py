from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
from typing import Any


PRICING = {
    "gpt-5.4-mini": {"input": 0.75, "output": 4.50},
    "gpt-5.4-nano": {"input": 0.20, "output": 1.25},
}


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def basis_badge(key: Any, value: Any) -> str:
    name = str(key)
    cls = {
        "document_text": "doc",
        "page_image": "img",
        "unknown": "unk",
        "missing": "miss",
    }.get(name, "unk")
    suffix = f" {value}" if value != "" else ""
    return f'<span class="badge {cls}">{esc(name)}{esc(suffix)}</span>'


def build_report(data: dict[str, Any]) -> str:
    rows: list[dict[str, Any]] = []
    totals: dict[str, dict[str, Any]] = {}

    for result in data["results"]:
        summary = result["summary"]
        usage = result.get("usage") or {}
        model = result["model"]
        total = totals.setdefault(
            model,
            {
                "calls": 0,
                "cand": 0,
                "doc_fail": 0,
                "image_text": 0,
                "prompt": 0,
                "comp": 0,
                "total": 0,
                "basis": {},
            },
        )
        total["calls"] += 1
        total["cand"] += summary["candidate_count"]
        total["doc_fail"] += len(summary["document_claim_failures"])
        total["image_text"] += len(summary["page_image_claims_text_present"])
        total["prompt"] += usage.get("prompt_tokens", 0) or 0
        total["comp"] += usage.get("completion_tokens", 0) or 0
        total["total"] += usage.get("total_tokens", 0) or 0
        for key, count in summary["basis_counts"].items():
            total["basis"][key] = total["basis"].get(key, 0) + count

        parsed = result.get("parsed", {})
        candidates = parsed.get("candidates", []) if isinstance(parsed, dict) else []
        rows.append(
            {
                "page": result["page"],
                "model": model,
                "cand": summary["candidate_count"],
                "basis": summary["basis_counts"],
                "doc_fail": len(summary["document_claim_failures"]),
                "image_text": len(summary["page_image_claims_text_present"]),
                "prompt": usage.get("prompt_tokens", 0) or 0,
                "comp": usage.get("completion_tokens", 0) or 0,
                "doc_fail_examples": summary["document_claim_failures"][:4],
                "image_text_examples": summary["page_image_claims_text_present"][:4],
                "candidates": candidates,
            }
        )

    for model, total in totals.items():
        price = PRICING.get(model, {"input": 0, "output": 0})
        total["cost"] = total["prompt"] / 1_000_000 * price["input"] + total["comp"] / 1_000_000 * price["output"]

    summary_cards = "".join(
        f"""
<section class="card metric">
  <h3>{esc(model)}</h3>
  <div class="big">{total['cand']}</div><div class="label">candidates / {total['calls']} calls</div>
  <p>{''.join(basis_badge(key, value) for key, value in sorted(total['basis'].items()))}</p>
  <dl><dt>document_text claims not found</dt><dd>{total['doc_fail']}</dd><dt>page_image claims also in text</dt><dd>{total['image_text']}</dd><dt>tokens</dt><dd>{total['prompt']:,} in / {total['comp']:,} out</dd><dt>rough cost</dt><dd>${total['cost']:.4f}</dd></dl>
</section>"""
        for model, total in totals.items()
    )

    row_html = ""
    for row in rows:
        row_html += f"""<tr>
<td>{row['page']}</td><td><code>{esc(row['model'])}</code></td><td>{row['cand']}</td><td>{''.join(basis_badge(key, value) for key, value in sorted(row['basis'].items()))}</td><td class="{'warn' if row['doc_fail'] else ''}">{row['doc_fail']}</td><td class="{'warn' if row['image_text'] else ''}">{row['image_text']}</td><td>{row['prompt']:,} / {row['comp']:,}</td></tr>"""

    examples = ""
    for row in rows:
        if not row["doc_fail_examples"] and not row["image_text_examples"]:
            continue
        examples += f'<section class="card"><h3>Page {row["page"]} / <code>{esc(row["model"])}</code></h3>'
        if row["doc_fail_examples"]:
            examples += "<h4>document_text claim not found after NFKC text check</h4><ul>"
            for item in row["doc_fail_examples"]:
                examples += f'<li><b>{esc(item.get("field"))}</b>: <code>{esc(item.get("value"))}</code> <span class="muted">candidate: {esc(item.get("text"))}</span></li>'
            examples += "</ul>"
        if row["image_text_examples"]:
            examples += "<h4>page_image claim, but value was also found in text</h4><ul>"
            for item in row["image_text_examples"]:
                examples += f'<li><b>{esc(item.get("field"))}</b>: <code>{esc(item.get("value"))}</code> <span class="muted">candidate: {esc(item.get("text"))}</span></li>'
            examples += "</ul>"
        examples += "</section>"

    candidate_sections = ""
    for row in rows:
        body = ""
        for candidate in row["candidates"][:20]:
            if not isinstance(candidate, dict):
                continue
            fields = candidate.get("sourceFields") if isinstance(candidate.get("sourceFields"), dict) else {}
            body += f'<tr><td>{esc(candidate.get("text", ""))}</td><td>{esc(candidate.get("category", ""))}</td><td>{basis_badge(candidate.get("sourceBasis", "unknown"), "")}</td><td>{esc(candidate.get("ja", ""))}</td><td>{esc(candidate.get("en", ""))}</td><td>{esc(candidate.get("formula", "") or candidate.get("displayText", ""))}</td><td><code>{esc(fields)}</code></td></tr>'
        candidate_sections += f"""<details><summary>Page {row['page']} / {esc(row['model'])}: candidates ({len(row['candidates'])})</summary><table><thead><tr><th>text</th><th>cat</th><th>basis</th><th>ja</th><th>en</th><th>formula/display</th><th>sourceFields</th></tr></thead><tbody>{body}</tbody></table></details>"""

    return f"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Glossary Vision Source Basis PoC</title>
<style>
body{{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f7f9;color:#1f2937;line-height:1.55}}
header{{background:#172033;color:white;padding:28px 36px}} header h1{{margin:0 0 8px;font-size:26px}} header p{{margin:4px 0;color:#cbd5e1}}
main{{padding:24px 36px;max-width:1320px;margin:auto}} .grid{{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}} .card{{background:white;border:1px solid #d9dee7;border-radius:8px;padding:18px;margin:16px 0;box-shadow:0 1px 2px rgba(15,23,42,.04)}}
.metric .big{{font-size:38px;font-weight:750}} .label,.muted{{color:#64748b}} h2{{margin-top:28px}} h3{{margin:0 0 10px}} h4{{margin:14px 0 6px}}
table{{width:100%;border-collapse:collapse;background:white}} th,td{{border-bottom:1px solid #e5e7eb;padding:9px 10px;text-align:left;vertical-align:top}} th{{background:#eef2f7;color:#334155;font-size:13px}} code{{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:#f1f5f9;border-radius:4px;padding:1px 4px}}
.badge{{display:inline-block;border-radius:999px;padding:2px 8px;margin:2px;font-size:12px;font-weight:650}} .doc{{background:#dbeafe;color:#1d4ed8}} .img{{background:#fee2e2;color:#b91c1c}} .unk{{background:#fef3c7;color:#92400e}} .miss{{background:#e5e7eb;color:#374151}} .warn{{color:#b91c1c;font-weight:750}}
dl{{display:grid;grid-template-columns:1fr auto;gap:4px 14px}} dt{{color:#64748b}} dd{{margin:0;font-weight:650}} details{{background:white;border:1px solid #d9dee7;border-radius:8px;margin:12px 0;padding:10px 12px}} summary{{cursor:pointer;font-weight:700}}
.callout{{border-left:5px solid #2563eb}} .risk{{border-left-color:#dc2626}} .ok{{border-left-color:#16a34a}}
</style></head><body><header><h1>Glossary Vision Source Basis PoC</h1><p>PDF本文 + ページ画像を1リクエストで渡し、mini/nano が sourceBasis をどれくらい分けられるかを比較。</p><p>Input PDF: {esc(data['pdf'])}</p><p>Pages: {', '.join(map(str, data['pages']))} / Created: {esc(data['createdAt'])}</p></header><main>
<section class="card callout"><h2>結論</h2><p><b>1リクエスト方式でも sourceBasis は出せるが、そのまま verification source として信用するのは危険。</b> nano は page_image を積極的に申告する一方、本文にも存在する値を page_image とする例が多い。mini はほぼ document_text に寄せるが、式・表記ゆれでは document_text 申告が本文照合に落ちる例が残る。</p><p>実装判断としては、Text pass / Vision pass を完全分離する前に、<b>単一Vision request + deterministic text verifier + sourceBasis再分類</b> をPoC採用するのが妥当。LLM申告の page_image は <code>vision_claimed</code> に留め、<code>vision_verified</code> とは呼ばない。</p></section>
<div class="grid">{summary_cards}</div>
<section class="card"><h2>Page x Model Summary</h2><table><thead><tr><th>page</th><th>model</th><th>candidates</th><th>sourceBasis</th><th>doc claim failures</th><th>image claim also text</th><th>tokens in/out</th></tr></thead><tbody>{row_html}</tbody></table></section>
<section class="card risk"><h2>設計上の注意</h2><ul><li><code>page_image</code> 申告は、画像だけに存在する証明ではない。本文照合で再分類が必要。</li><li><code>document_text</code> 照合はNFKC正規化が必須。PDF text layer は互換漢字・全角記号・数式添字で簡単に崩れる。</li><li>URL/reference/footer は nano が拾いやすいので、D処理で disabled 寄りに落とす必要がある。</li><li>式ページでは mini/nano の抽出粒度が大きく変わるため、候補生成モデルはコストだけで決めない方がよい。</li></ul></section>
<section class="card ok"><h2>推奨する次実装</h2><ol><li>現行のVision requestは1回のまま維持し、候補に <code>sourceBasis</code> / <code>sourceFields</code> を追加する。</li><li>D処理でPDF本文をNFKC正規化して deterministic に再照合する。</li><li>本文にあれば <code>document_verified</code>、本文になくLLMがpage_image申告なら <code>vision_claimed</code>、本文にも画像申告にも根拠が弱いものは <code>needs_review</code> にする。</li><li><code>vision_verified</code> は、将来OCR/別Vision確認パスを入れるまで使わない。</li></ol></section>
<h2>Suspicious Examples</h2>{examples}
<h2>Candidate Details</h2>{candidate_sections}
</main></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    Path(args.output).write_text(build_report(data), encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
