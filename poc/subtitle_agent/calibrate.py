"""意味保持閾値 (SIMILARITY_THRESHOLD) の経験的較正スクリプト.

固定の正解ラベル付きデータセットが無いため、次の方法で良訳/悪訳ペアを構成する:

- 良訳ペア: (ja_i, en_i)   en_i = ja_i を翻訳したもの
- 悪訳ペア: (ja_i, en_j)   i != j のずらし対 (意味的に無関係)

良訳ペアと悪訳ペアの日英クロスリンガル類似度の分布を実測し、
両者を分離できる SIMILARITY_THRESHOLD をデータから決定する。

使用方法:
    .venv\\Scripts\\python -m poc.subtitle_agent.calibrate \\
        --cache "poc/cache/DL基礎_day2_JP確認_cache.json" --samples 25
"""

import argparse
import json
import statistics
import time
from pathlib import Path

from poc.subtitle_agent import constants
from poc.subtitle_agent.evaluate import cosine_similarity, get_embedding
from poc.subtitle_agent.llm import make_local_client, translate_ja_to_en

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"


def _percentile(values: list[float], pct: float) -> float:
    """0.0〜1.0 の分位点。"""
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round(pct * (len(ordered) - 1))))
    return ordered[idx]


def _summary(values: list[float]) -> dict[str, float]:
    return {
        "min": min(values),
        "p10": _percentile(values, 0.10),
        "median": statistics.median(values),
        "mean": statistics.fmean(values),
        "p90": _percentile(values, 0.90),
        "max": max(values),
    }


def calibrate(cache_path: str, samples: int) -> Path:
    """良訳/悪訳ペアの類似度分布を実測しレポートを出力する。"""
    with open(cache_path, "r", encoding="utf-8") as f:
        segments = json.load(f)

    # 再現性のため等間隔サンプリング (ランダムではなく決定的)
    step = max(1, len(segments) // samples)
    picked = segments[::step][:samples]
    print(f"[CALIBRATE] 全 {len(segments)} セグメントから {len(picked)} 件を抽出。")

    client = make_local_client()

    ja_texts: list[str] = []
    en_texts: list[str] = []
    for i, seg in enumerate(picked, start=1):
        ja = seg.get("ja_corrected") or seg.get("text") or seg.get("ja")
        en = translate_ja_to_en(ja, client)
        ja_texts.append(ja)
        en_texts.append(en)
        print(f"[CALIBRATE] 翻訳 {i}/{len(picked)} 完了")

    ja_vecs = [get_embedding(t, client) for t in ja_texts]
    en_vecs = [get_embedding(t, client) for t in en_texts]

    # 良訳ペア: (ja_i, en_i)
    good = [cosine_similarity(ja_vecs[i], en_vecs[i]) for i in range(len(picked))]
    # 悪訳ペア: (ja_i, en_{i+1}) のずらし対
    bad = [
        cosine_similarity(ja_vecs[i], en_vecs[(i + 1) % len(picked)])
        for i in range(len(picked))
    ]

    good_s = _summary(good)
    bad_s = _summary(bad)

    # 推奨閾値: 良訳の下側 (p10) と悪訳の上側 (p90) の中点。
    # 両分布が重ならなければ良い分離指標になる。
    suggested = round((good_s["p10"] + bad_s["p90"]) / 2, 4)
    overlap = bad_s["p90"] >= good_s["p10"]

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    report_file = RESULTS_DIR / f"threshold_calibration_{stamp}.md"

    lines = [
        "# 意味保持閾値 較正レポート",
        "",
        f"> 生成日時: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"> キャッシュ: {cache_path}",
        f"> サンプル数: {len(picked)}",
        f"> 埋め込みモデル: {constants.EMBEDDING_MODEL}",
        f"> instruction: {constants.EMBED_TASK_INSTRUCTION}",
        "",
        "## 類似度分布",
        "",
        "| ペア種別 | min | p10 | median | mean | p90 | max |",
        "|---------|-----|-----|--------|------|-----|-----|",
        f"| 良訳 (ja_i, en_i) | {good_s['min']:.4f} | {good_s['p10']:.4f} "
        f"| {good_s['median']:.4f} | {good_s['mean']:.4f} | {good_s['p90']:.4f} "
        f"| {good_s['max']:.4f} |",
        f"| 悪訳 (ja_i, en_j) | {bad_s['min']:.4f} | {bad_s['p10']:.4f} "
        f"| {bad_s['median']:.4f} | {bad_s['mean']:.4f} | {bad_s['p90']:.4f} "
        f"| {bad_s['max']:.4f} |",
        "",
        "## 判定",
        "",
        f"- 推奨 SIMILARITY_THRESHOLD: **{suggested}**",
        f"- 良訳p10 ({good_s['p10']:.4f}) と 悪訳p90 ({bad_s['p90']:.4f}) の"
        + ("重なりあり ⚠ — instruction やモデル設定の見直しが必要" if overlap
           else "分離良好 — クロスリンガル埋め込みは機能している"),
        "",
        "## 次アクション",
        "",
        f"- constants.py の SIMILARITY_THRESHOLD を {suggested} に更新する。"
        if not overlap
        else "- 分布が重なっている。pooling=last 設定の確認、instruction の"
        " 調整、または埋め込みモデルの見直しを行う。",
    ]
    report_file.write_text("\n".join(lines), encoding="utf-8")

    print("\n" + "=" * 50)
    print(f"[CALIBRATE] 良訳 median={good_s['median']:.4f} p10={good_s['p10']:.4f}")
    print(f"[CALIBRATE] 悪訳 median={bad_s['median']:.4f} p90={bad_s['p90']:.4f}")
    print(f"[CALIBRATE] 推奨閾値={suggested}  分離={'NG(重なり)' if overlap else 'OK'}")
    print(f"[CALIBRATE] レポート: {report_file}")
    print("=" * 50)
    return report_file


def main() -> None:
    parser = argparse.ArgumentParser(description="意味保持閾値の経験的較正")
    parser.add_argument(
        "--cache",
        default="poc/cache/DL基礎_day2_JP確認_cache.json",
        help="書き起こしキャッシュJSONのパス",
    )
    parser.add_argument("--samples", type=int, default=25, help="抽出サンプル数")
    args = parser.parse_args()
    calibrate(args.cache, args.samples)


if __name__ == "__main__":
    main()
