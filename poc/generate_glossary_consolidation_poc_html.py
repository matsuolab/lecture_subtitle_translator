#!/usr/bin/env python3
"""Generate an HTML report for glossary consolidation PoC results.

Usage:
    python generate_glossary_consolidation_poc_html.py \
        --original /path/to/self-made-glossary.json

`--original` defaults to the env var GLOSSARY_POC_ORIGINAL if set, otherwise
falls back to ./self-made-glossary.json in the current working directory.
"""

from __future__ import annotations

import argparse
import html
import json
import os
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ORIGINAL = Path(os.environ.get("GLOSSARY_POC_ORIGINAL", "self-made-glossary.json"))
RESULTS = [
    ("全件一括 nano", ROOT / "docs/research/20260528_glossary_consolidation_poc_all_nano.json"),
    ("100件分割 nano + 例示", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch100_nano_examples.json"),
    ("50件分割 nano + 例示", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch50_nano_examples.json"),
    ("50件分割 nano + 例示 + reasoning low", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch50_nano_reasoning_low.json"),
    ("50件分割 mini + 例示", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch50_mini_no_reasoning.json"),
    ("50件 risk-groups nano + short id", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch50_nano_shortid_riskgroups.json"),
    ("50件 risk-groups mini + short id", ROOT / "docs/research/20260528_glossary_consolidation_poc_batch50_mini_shortid_riskgroups.json"),
]
OUT = ROOT / "docs/research/20260528_glossary_consolidation_poc_report.html"


def esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def first_page(entry: dict[str, Any]) -> Any:
    for child in entry.get("children") or []:
        if isinstance(child, dict) and child.get("page"):
            return child.get("page")
    return ""


def normalize_source_ids(ids: list[Any], originals: list[dict[str, Any]], id_map: dict[str, str] | None = None) -> list[str]:
    id_map = id_map or {}
    out: list[str] = []
    for value in ids or []:
        text = str(value)
        if text in id_map:
            out.append(id_map[text])
            continue
        if text.isdigit():
            idx = int(text)
            if 0 <= idx < len(originals):
                out.append(str(originals[idx].get("id", "")))
                continue
        out.append(text)
    return out


def flatten_result(result: dict[str, Any], originals: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    canonical: list[dict[str, Any]] = []
    dropped: list[dict[str, Any]] = []
    id_map = result.get("idMap") if isinstance(result.get("idMap"), dict) else {}
    for batch in result.get("batches") or []:
        parsed = batch.get("result") or {}
        for item in parsed.get("canonical") or []:
            item = dict(item)
            item["sourceIds"] = normalize_source_ids(item.get("sourceIds") or [], originals, id_map)
            canonical.append(item)
        for item in parsed.get("dropped") or []:
            item = dict(item)
            item["sourceIds"] = normalize_source_ids(item.get("sourceIds") or [], originals, id_map)
            dropped.append(item)
    return canonical, dropped


def summarize(label: str, path: Path, originals: list[dict[str, Any]]) -> dict[str, Any]:
    result = load_json(path)
    canonical, dropped = flatten_result(result, originals)
    original_ids = {str(entry.get("id", "")) for entry in originals if entry.get("id")}
    all_covered = {sid for item in canonical + dropped for sid in item.get("sourceIds") or [] if sid}
    covered = all_covered & original_ids
    extra_ids = all_covered - original_ids
    input_tokens = sum((batch.get("usage") or {}).get("prompt_tokens") or 0 for batch in result.get("batches") or [])
    output_tokens = sum((batch.get("usage") or {}).get("completion_tokens") or 0 for batch in result.get("batches") or [])
    total_tokens = sum((batch.get("usage") or {}).get("total_tokens") or 0 for batch in result.get("batches") or [])
    reasoning_tokens = sum(batch.get("reasoningTokens") or ((batch.get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens") or 0 for batch in result.get("batches") or [])
    return {
        "label": label,
        "path": path,
        "result": result,
        "canonical": canonical,
        "dropped": dropped,
        "covered": len(covered),
        "missing": len(originals) - len(covered),
        "extraIds": len(extra_ids),
        "canonicalCount": len(canonical),
        "droppedCount": len(dropped),
        "batches": len(result.get("batches") or []),
        "batchSize": result.get("batchSize"),
        "inputTokens": input_tokens,
        "outputTokens": output_tokens,
        "reasoningTokens": reasoning_tokens,
        "totalTokens": total_tokens,
        "useCounts": Counter(str(item.get("use") or "(blank)") for item in canonical),
        "catCounts": Counter(str(item.get("cat") or "(blank)") for item in canonical),
        "dropCounts": Counter(str(item.get("reason") or "(blank)") for item in dropped),
    }


def original_by_id(originals: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {str(entry.get("id")): entry for entry in originals}


def find_items(items: list[dict[str, Any]], *patterns: str) -> list[dict[str, Any]]:
    found = []
    for item in items:
        text = " ".join(str(item.get(key) or "") for key in ("source", "target", "abbr", "formula", "display", "reason"))
        if any(pattern in text for pattern in patterns):
            found.append(item)
    return found


def render_count_table(counter: Counter[str]) -> str:
    if not counter:
        return '<div class="muted">なし</div>'
    rows = []
    for key, count in counter.most_common():
        rows.append(f"<tr><td>{esc(key)}</td><td class='num'>{count}</td></tr>")
    return "<table><tbody>" + "".join(rows) + "</tbody></table>"


def render_batch_log(summary: dict[str, Any]) -> str:
    rows = []
    for batch in (summary.get("result") or {}).get("batches") or []:
        usage = batch.get("usage") or {}
        rows.append(
            "<tr>"
            f"<td class='num'>{esc(batch.get('batchIndex'))}</td>"
            f"<td class='num'>{esc(batch.get('candidateCount'))}</td>"
            f"<td>{esc(batch.get('finishReason') or '')}</td>"
            f"<td class='num'>{esc(batch.get('canonicalCount') or 0)}</td>"
            f"<td class='num'>{esc(batch.get('droppedCount') or 0)}</td>"
            f"<td class='num'>{esc(batch.get('coveredInputIds') or 0)}</td>"
            f"<td class='num'>{esc(len(batch.get('missingInputIds') or []))}</td>"
            f"<td class='num'>{(usage.get('prompt_tokens') or 0):,}</td>"
            f"<td class='num'>{(usage.get('completion_tokens') or 0):,}</td>"
            f"<td class='num'>{(batch.get('reasoningTokens') or 0):,}</td>"
            f"<td class='num'>{(usage.get('total_tokens') or 0):,}</td>"
            f"<td class='num'>{esc(batch.get('durationSec') or '')}</td>"
            "</tr>"
        )
    if not rows:
        return '<div class="muted">なし</div>'
    return (
        "<table><thead><tr><th>batch</th><th>input</th><th>finish</th><th>canonical</th>"
        "<th>dropped</th><th>covered</th><th>missing</th><th>input tok</th>"
        "<th>output tok</th><th>reasoning tok</th><th>total tok</th><th>sec</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def render_original_rows(ids: list[str], originals_by_id: dict[str, dict[str, Any]]) -> str:
    rows = []
    for sid in ids:
        original = originals_by_id.get(sid)
        if not original:
            continue
        rows.append(
            "<tr>"
            f"<td>{esc(original.get('category'))}</td>"
            f"<td>{esc(original.get('ja'))}</td>"
            f"<td>{esc(original.get('en'))}</td>"
            f"<td>{esc(original.get('abbr'))}</td>"
            f"<td class='num'>{esc(first_page(original))}</td>"
            "</tr>"
        )
    return "<table><thead><tr><th>cat</th><th>source</th><th>target</th><th>abbr</th><th>page</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table>"


def render_card(item: dict[str, Any], originals_by_id: dict[str, dict[str, Any]]) -> str:
    ids = item.get("sourceIds") or []
    return f"""
    <section class="entry">
      <div class="line">
        <span class="pill">{esc(item.get('cat') or 'dropped')}</span>
        <strong>{esc(item.get('source') or item.get('display') or item.get('formula') or '(sourceなし)')}</strong>
        <span class="arrow">→</span>
        <strong class="target">{esc(item.get('target') or '(targetなし)')}</strong>
        <span class="use">{esc(item.get('use') or item.get('reason'))}</span>
      </div>
      <div class="meta">reason: {esc(item.get('reason'))} / ids: {esc(', '.join(ids[:6]))}{' ...' if len(ids) > 6 else ''}</div>
      {render_original_rows(ids, originals_by_id)}
    </section>
    """


def render_full_result_table(summary: dict[str, Any], originals_by_id: dict[str, dict[str, Any]]) -> str:
    rows = []
    for kind, items in (("canonical", summary["canonical"]), ("dropped", summary["dropped"])):
        for index, item in enumerate(items, start=1):
            ids = item.get("sourceIds") or []
            original_texts = []
            pages = []
            for sid in ids:
                original = originals_by_id.get(sid)
                if not original:
                    continue
                label = " / ".join(str(original.get(key) or "") for key in ("ja", "en", "abbr", "formula", "displayText") if original.get(key))
                if label:
                    original_texts.append(label)
                page = first_page(original)
                if page not in ("", None):
                    pages.append(str(page))
            rows.append(
                "<tr>"
                f"<td class='num'>{index}</td>"
                f"<td>{esc(kind)}</td>"
                f"<td>{esc(item.get('cat') or '')}</td>"
                f"<td>{esc(item.get('source') or item.get('display') or item.get('formula') or '')}</td>"
                f"<td>{esc(item.get('target') or '')}</td>"
                f"<td>{esc(item.get('use') or '')}</td>"
                f"<td>{esc(item.get('reason') or '')}</td>"
                f"<td>{esc(', '.join(sorted(set(pages), key=lambda x: int(x) if x.isdigit() else 999999)))}</td>"
                f"<td>{esc(' / '.join(original_texts[:5]))}{' ...' if len(original_texts) > 5 else ''}</td>"
                f"<td>{esc(', '.join(ids[:5]))}{' ...' if len(ids) > 5 else ''}</td>"
                "</tr>"
            )
    return (
        "<table><thead><tr><th>#</th><th>kind</th><th>cat</th><th>source</th><th>target</th>"
        "<th>use</th><th>reason</th><th>pages</th><th>originals</th><th>ids</th></tr></thead><tbody>"
        + "".join(rows)
        + "</tbody></table>"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--original",
        type=Path,
        default=DEFAULT_ORIGINAL,
        help="path to the original self-made-glossary.json export (default: $GLOSSARY_POC_ORIGINAL or ./self-made-glossary.json)",
    )
    args = parser.parse_args()
    originals = load_json(args.original)
    originals_by_id = original_by_id(originals)
    summaries = [summarize(label, path, originals) for label, path in RESULTS if path.exists()]
    best = max(summaries, key=lambda item: (item["covered"], -item["extraIds"], -item["totalTokens"]))

    examples: list[tuple[str, list[dict[str, Any]]]] = [
        ("成功例: 深層学習 + Deep Learning のペアリング", find_items(best["canonical"], "深層学習", "Deep Learning")[:3]),
        ("成功例: 最適化アルゴリズム + Optimizer のcategory修正", find_items(best["canonical"], "最適化アルゴリズム", "Optimizer")[:3]),
        ("成功例: 見出し・弱い句のdrop", find_items(best["canonical"] + best["dropped"], "深層学習と画像認識", "実践的な方法論", "heading", "weak_phrase")[:6]),
        ("失敗/要改善例: Transformer基礎がreviewに残る", find_items(best["canonical"], "Transformer基礎", "Transformer")[:5]),
        ("要注意例: 英語用語の扱い", find_items(best["canonical"], "Optimizer", "Dropout", "RMSProp", "Early Stopping")[:8]),
    ]

    summary_rows = []
    for item in summaries:
        summary_rows.append(
            "<tr>"
            f"<td>{esc(item['label'])}</td>"
            f"<td class='num'>{esc(item['batchSize'])}</td>"
            f"<td class='num'>{item['batches']}</td>"
            f"<td class='num'>{item['canonicalCount']}</td>"
            f"<td class='num'>{item['droppedCount']}</td>"
            f"<td class='num'>{item['covered']}/{len(originals)}</td>"
            f"<td class='num'>{item['missing']}</td>"
            f"<td class='num'>{item['extraIds']}</td>"
            f"<td class='num'>{item['inputTokens']:,}</td>"
            f"<td class='num'>{item['outputTokens']:,}</td>"
            f"<td class='num'>{item['reasoningTokens']:,}</td>"
            f"<td class='num'>{item['totalTokens']:,}</td>"
            "</tr>"
        )

    html_text = f"""<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>Glossary Consolidation PoC Report</title>
  <style>
    body {{ margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f7f9; color: #20242a; }}
    header {{ background: #1f2933; color: white; padding: 24px 32px; }}
    main {{ padding: 24px 32px 48px; max-width: 1280px; margin: 0 auto; }}
    h1 {{ margin: 0 0 8px; font-size: 24px; }}
    h2 {{ margin: 28px 0 12px; font-size: 18px; }}
    .lead {{ color: #d8dee8; margin: 0; }}
    .grid {{ display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }}
    .metric {{ background: white; border: 1px solid #d7dde5; border-radius: 8px; padding: 14px; }}
    .metric .label {{ color: #657181; font-size: 12px; }}
    .metric .value {{ font-size: 24px; font-weight: 700; margin-top: 4px; }}
    table {{ width: 100%; border-collapse: collapse; background: white; border: 1px solid #d7dde5; border-radius: 8px; overflow: hidden; }}
    th, td {{ border-bottom: 1px solid #e4e8ee; padding: 8px 10px; text-align: left; vertical-align: top; font-size: 13px; }}
    th {{ background: #eef2f6; color: #3d4652; font-size: 12px; }}
    .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    .cards {{ display: grid; gap: 10px; }}
    .entry {{ background: white; border: 1px solid #d7dde5; border-radius: 8px; padding: 12px; }}
    .line {{ display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }}
    .pill, .use {{ border: 1px solid #cbd4df; border-radius: 999px; padding: 2px 8px; font-size: 12px; background: #f3f6f9; color: #3d4652; }}
    .target {{ color: #0f766e; }}
    .arrow {{ color: #7b8794; }}
    .meta {{ margin: 6px 0 8px; color: #657181; font-size: 12px; }}
    .note {{ background: #fff8e6; border: 1px solid #f0d98c; border-radius: 8px; padding: 12px; line-height: 1.6; }}
    .cols {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }}
    .muted {{ color: #657181; }}
  </style>
</head>
<body>
  <header>
    <h1>Glossary Consolidation PoC Report</h1>
    <p class="lead">既存 self-made glossary 401件を C2 統合専用パスで再整理できるかの検証</p>
  </header>
  <main>
    <div class="grid">
      <div class="metric"><div class="label">入力候補</div><div class="value">{len(originals)}</div></div>
      <div class="metric"><div class="label">最良coverage</div><div class="value">{best['covered']}/{len(originals)}</div></div>
      <div class="metric"><div class="label">最良canonical</div><div class="value">{best['canonicalCount']}</div></div>
      <div class="metric"><div class="label">最良dropped</div><div class="value">{best['droppedCount']}</div></div>
    </div>

    <h2>結論</h2>
    <div class="note">
      例示を入れると統合品質は明確に改善した。特に <b>深層学習 + Deep Learning</b> と
      <b>最適化アルゴリズム + Optimizer</b> は期待に近い形へ統合できた。
      一方でどの方式も coverage 制約を完全には守りきれていない。
      mini は出力トークンを大きく抑えたが、17件漏れと7件の変形IDが残った。
      nano reasoning low は coverage が最も高いが、出力トークン・実行時間・変形IDリスクが増えた。
      short id + risk-groups は coverage 396/401、変形ID 0 まで改善し、ID追跡の問題には最も効いた。
      本番投入するなら、<b>50件前後のwindow + coverage検査 + 未処理候補の再試行 + final reduce</b> が必要。
      全件一括は「入る」が、処理漏れが大きく不採用。
    </div>

    <h2>実行比較</h2>
    <table>
      <thead><tr><th>方式</th><th>batch size</th><th>batches</th><th>canonical</th><th>dropped</th><th>covered</th><th>missing</th><th>extra id</th><th>input tok</th><th>output tok</th><th>reasoning tok</th><th>total tok</th></tr></thead>
      <tbody>{''.join(summary_rows)}</tbody>
    </table>

    <h2>推論ログ</h2>
    <div class="note">
      API上の指定は <b>reasoning_effort=low</b>。ユーザー指定の「small」はPoCスクリプト内で low に正規化している。
      reasoning token は usage.completion_tokens_details.reasoning_tokens から集計する。
    </div>
    {''.join(f"<h3>{esc(item['label'])}</h3>{render_batch_log(item)}" for item in summaries if item['reasoningTokens'] or item['label'].endswith('reasoning low'))}

    <h2>50件分割の内訳</h2>
    <div class="cols">
      <div><h3>use</h3>{render_count_table(best['useCounts'])}</div>
      <div><h3>category</h3>{render_count_table(best['catCounts'])}</div>
      <div><h3>dropped reason</h3>{render_count_table(best['dropCounts'])}</div>
    </div>

    <h2>具体例</h2>
    {''.join(f"<h3>{esc(title)}</h3><div class='cards'>{''.join(render_card(item, originals_by_id) for item in items) or '<div class=\"muted\">該当なし</div>'}</div>" for title, items in examples)}

    <h2>最良方式の全結果</h2>
    <div class="note">
      選定: <b>{esc(best['label'])}</b>。
      coverage {best['covered']}/{len(originals)}、extra id {best['extraIds']}、total tokens {best['totalTokens']:,}。
      下表は canonical と dropped をすべて表示する。
    </div>
    {render_full_result_table(best, originals_by_id)}

    <h2>本番実装への示唆</h2>
    <div class="note">
      <b>採用案:</b> short id 化したうえで、50件前後の risk-group window で C2 を実行し、各windowごとに全入力IDが canonical/dropped のどちらかに入ったか検査する。
      漏れたIDだけを再試行し、最後に canonical 同士を final reduce で再統合する。
      <br><br>
      <b>非採用:</b> 全件一括。19k tokens 程度で入力は可能だが、出力側で候補を大量に無視するため実用不可。
      <br><br>
      <b>要改善:</b> short id + risk-groups でも見出し・章題を review に残す例はある。
      C2 は coverage validator と retry に加えて、見出し/弱い句の deterministic drop ルールも併用する。
    </div>
  </main>
</body>
</html>
"""
    OUT.write_text(html_text, encoding="utf-8")
    print(OUT)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
