"""パイプライン A の実行結果レポート生成."""

import json
import time
from pathlib import Path

from poc.subtitle_agent.optimizer import OptimizeResult

RESULTS_DIR = Path(__file__).resolve().parent.parent / "results"


def _srt_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(result: OptimizeResult, path: Path) -> None:
    """最適化済みキューを SRT 字幕ファイルとして書き出す。"""
    lines: list[str] = []
    for i, r in enumerate(result.cue_results, start=1):
        c = r.cue
        lines.append(str(i))
        lines.append(f"{_srt_timestamp(c.start)} --> {_srt_timestamp(c.end)}")
        lines.append(c.en)
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_report(result: OptimizeResult, video_name: str) -> tuple[Path, Path]:
    """実行結果のサマリレポート (md) と SRT を出力する。"""
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    report_file = RESULTS_DIR / f"optimize_report_{stamp}.md"
    srt_file = RESULTS_DIR / f"optimize_{stamp}.srt"

    write_srt(result, srt_file)

    flagged = [r for r in result.cue_results if not r.evaluation.compliant]
    lines = [
        "# 字幕最適化パイプライン A 実行レポート",
        "",
        f"> 生成日時: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"> 対象: {video_name}",
        f"> プロンプトセット: {result.prompt_label}",
        "",
        "## 定量メトリクス (全キュー対象)",
        "",
        "| 指標 | 値 |",
        "|------|-----|",
        f"| 総キュー数 | {result.total} |",
        f"| 制約遵守キュー数 | {result.compliant} |",
        f"| 遵守率 | {result.compliance_rate:.1f}% |",
        f"| 平均コサイン類似度 | {result.avg_similarity:.4f} |",
        f"| 平均総合スコア | {result.avg_score:.4f} |",
        f"| 意味崩壊で却下 | {result.rejected} |",
        f"| 違反フラグ (要確認) | {len(flagged)} |",
        "",
        "## 違反フラグの付いたキュー (要確認)",
        "",
        "| キューID | 時間 | CPS | 行長 | セグ長 | 類似度 | en |",
        "|---------|------|-----|------|--------|--------|-----|",
    ]
    for r in flagged[:50]:
        c, e = r.cue, r.evaluation
        en_oneline = c.en.replace("\n", " / ")
        lines.append(
            f"| {c.id} | {c.start:.1f}-{c.end:.1f} | {e.cps:.1f} "
            f"| {e.line_chars_max} | {e.segment_chars} | {e.similarity:.3f} "
            f"| {en_oneline} |"
        )
    if len(flagged) > 50:
        lines.append(f"| ... | 他 {len(flagged) - 50} 件 | | | | | |")

    report_file.write_text("\n".join(lines), encoding="utf-8")
    return report_file, srt_file


def write_evolution_report(history: list, video_name: str) -> Path:
    """自己進化メタループの世代比較レポートを出力する。

    history は evolution.GenerationResult のリスト。
    """
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    report_file = RESULTS_DIR / f"evolution_report_{stamp}.md"

    lines = [
        "# 自己進化字幕最適化エージェント 世代比較レポート",
        "",
        f"> 生成日時: {time.strftime('%Y-%m-%d %H:%M:%S')}",
        f"> 対象: {video_name}",
        "> メタLLM: Claude (claude -p / サブスクリプション認証)",
        "",
        "## 定量メトリクス推移 (全キュー対象)",
        "",
        "| 世代 | プロンプト | 遵守率 | 平均類似度 | 平均スコア | 総キュー | 進化の焦点 |",
        "|------|-----------|--------|-----------|-----------|---------|-----------|",
    ]
    for g in history:
        r = g.result
        label = f"**Gen {g.generation}**" if g.generation == 0 else f"Gen {g.generation}"
        lines.append(
            f"| {label} | {g.prompt_set.label} | {r.compliance_rate:.1f}% "
            f"| {r.avg_similarity:.4f} | {r.avg_score:.4f} | {r.total} "
            f"| {g.focus} |"
        )

    lines += ["", "## 世代別プロンプトの進化史", ""]
    for g in history:
        ps = g.prompt_set
        lines += [
            f"### 世代 {g.generation} ({ps.label})",
            f"- 進化の焦点: {g.focus}",
            f"- プロンプト文字数: translate={len(ps.translate)} / "
            f"condense={len(ps.condense)}",
            "",
            "<details><summary>translate</summary>",
            "",
            "```",
            ps.translate,
            "```",
            "</details>",
            "",
            "<details><summary>condense</summary>",
            "",
            "```",
            ps.condense,
            "```",
            "</details>",
            "",
        ]

    report_file.write_text("\n".join(lines), encoding="utf-8")
    return report_file
