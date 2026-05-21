"""日本語→英語 文字数膨張率 k の実測スクリプト.

再分割の制約採点 (cue.score_candidate) は翻訳前に行うため、英語字幕の文字数を
`ja長 × k` で見積もる。この k を既知の日英ペアから実測して決定する。

良訳ペア (ja_i, en_i) を作り、各ペアの k_i = len(en_i) / len(ja_i) の分布を出す。
推奨値は median (外れ値に強い代表値) とする。

使用方法:
    .venv\\Scripts\\python -m poc.subtitle_agent.measure_expansion \\
        --cache "poc/cache/DL基礎_day2_JP確認_cache.json" --samples 30
"""

import argparse
import json
import statistics
import time
from pathlib import Path

from poc.subtitle_agent import constants
from poc.subtitle_agent.llm import make_local_client, translate_ja_to_en

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"


def _percentile(values: list[float], pct: float) -> float:
    """0.0〜1.0 の分位点。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return ordered[idx]


def _char_count(text: str) -> int:
    """改行・空白を除いた表示文字数。"""
    return len(text.replace("\n", "").replace(" ", ""))


def measure(cache_path: str, samples: int) -> Path:
    """日英ペアの文字数膨張率を実測しレポートを出力する。"""
    with open(cache_path, "r", encoding="utf-8") as f:
        segments = json.load(f)

    # 再現性のため等間隔サンプリング (決定的)
    step = max(1, len(segments) // samples)
    picked = segments[::step][:samples]
    print(f"[MEASURE] 全 {len(segments)} セグメントから {len(picked)} 件を抽出。")

    client = make_local_client()

    ratios: list[float] = []
    for i, seg in enumerate(picked, start=1):
        ja = seg.get("ja_corrected") or seg.get("text") or seg.get("ja") or ""
        ja_len = len(ja.replace("\n", "").replace(" ", ""))
        if ja_len == 0:
            continue
        en = translate_ja_to_en(ja, client)
        en_len = _char_count(en)
        ratios.append(en_len / ja_len)
        print(f"[MEASURE] {i}/{len(picked)}  ja={ja_len}字 -> en={en_len}字  "
              f"k={en_len / ja_len:.3f}")

    if not ratios:
        raise SystemExit("有効な日英ペアが得られませんでした。")

    median = round(statistics.median(ratios), 3)
    mean = round(statistics.fmean(ratios), 3)
    p10 = round(_percentile(ratios, 0.10), 3)
    p90 = round(_percentile(ratios, 0.90), 3)

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    report_file = RESULTS_DIR / f"expansion_ratio_{stamp}.md"
    report_file.write_text(
        "\n".join(
            [
                "# 日本語→英語 文字数膨張率 実測レポート",
                "",
                f"> 生成日時: {time.strftime('%Y-%m-%d %H:%M:%S')}",
                f"> キャッシュ: {cache_path}",
                f"> サンプル数: {len(ratios)}",
                f"> 翻訳モデル: {constants.CHAT_MODEL}",
                "",
                "## 膨張率 k = len(en) / len(ja) の分布",
                "",
                "| min | p10 | median | mean | p90 | max |",
                "|-----|-----|--------|------|-----|-----|",
                f"| {min(ratios):.3f} | {p10:.3f} | {median:.3f} | {mean:.3f} "
                f"| {p90:.3f} | {max(ratios):.3f} |",
                "",
                "## 判定",
                "",
                f"- 推奨 JA_EN_EXPANSION_K (median): **{median}**",
                f"- constants.py の JA_EN_EXPANSION_K を {median} に更新する。",
                "",
                "median を採用する理由: 外れ値 (極端に短い/長い訳) に強く、"
                "再分割採点の CPS 見積りに安定した代表値を与えるため。",
            ]
        ),
        encoding="utf-8",
    )

    print("\n" + "=" * 50)
    print(f"[MEASURE] k 分布  median={median}  mean={mean}  "
          f"p10={p10}  p90={p90}")
    print(f"[MEASURE] 推奨 JA_EN_EXPANSION_K = {median}")
    print(f"[MEASURE] レポート: {report_file}")
    print("=" * 50)
    return report_file


def main() -> None:
    parser = argparse.ArgumentParser(description="日英文字数膨張率の実測")
    parser.add_argument(
        "--cache",
        default="poc/cache/DL基礎_day2_JP確認_cache.json",
        help="書き起こしキャッシュJSONのパス",
    )
    parser.add_argument("--samples", type=int, default=30, help="抽出サンプル数")
    args = parser.parse_args()
    measure(args.cache, args.samples)


if __name__ == "__main__":
    main()
