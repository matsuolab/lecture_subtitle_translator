"""
パイプライン全体のオーケストレーター。
動画ファイルと（任意で）スライド PDF を受け取り、
SRT ファイルと品質レポートを出力する。

使い方:
    python -m poc.step2_pipeline.pipeline \
        --video lecture.mp4 \
        --pdf slides.pdf \
        --output ./output
"""

from __future__ import annotations

import argparse
import asyncio
import os
from collections.abc import Callable
from pathlib import Path

from dotenv import load_dotenv

from .config import Providers, build_providers, load_config
from .constraints import ConstraintsConfig, SubtitleConstraints, apply_overrides, load_constraints
from .metrics import LLMUsage, PipelineMetrics, step_timer
from .models.segment import PipelineResult
from .steps.aligner import align_blocks
from .steps.audio_extractor import extract_audio
from .steps.corrector import correct_segments
from .steps.pdf_extractor import extract_slide_context
from .steps.splitter import split_into_blocks
from .steps.srt_exporter import export_report, export_srt
from .steps.transcriber import transcribe
from .steps.translator import translate_segments


def load_glossary_json(glossary_path: str) -> tuple[str, ...]:
    """
    フロントエンドが書き出した glossary.json を読み込み、
    補正・翻訳プロンプトに渡せる文字列タプルに変換する。

    Args:
        glossary_path: glossary.json のパス
                       デフォルト: %APPDATA%/subtitle-editor/glossary.json (Windows)
                                   ~/Library/Application Support/subtitle-editor/glossary.json (Mac)
                                   ~/.config/subtitle-editor/glossary.json (Linux)

    Returns:
        "ja → en" 形式の文字列タプル（空の場合は空タプル）
    """
    import json
    path = Path(glossary_path)
    if not path.exists():
        print(f"      ℹ 用語辞書ファイルが見つかりません（スキップ）: {glossary_path}")
        return ()
    with open(path, encoding="utf-8") as f:
        entries = json.load(f)
    result = []
    for e in entries:
        ja = (e.get("ja") or "").strip()
        en = (e.get("en") or "").strip()
        if ja and en:
            result.append(f"{ja} → {en}")
        elif ja:
            result.append(ja)
    print(f"      → 用語辞書 {len(result)} 件読み込み")
    return tuple(result)


def _default_glossary_path() -> str:
    """OS に応じたデフォルトの glossary.json パスを返す。"""
    import sys
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")
    return str(Path(base) / "subtitle-editor" / "glossary.json")


async def run_pipeline(
    video_path: str,
    pdf_path: str | None = None,
    output_dir: str | None = None,
    subtitle_lang: str = "en",
    constraints_cfg: ConstraintsConfig | None = None,
    glossary_path: str | None = None,
    progress_callback: Callable[[str], None] | None = None,
) -> PipelineResult:
    """
    動画ファイルから英語 SRT を生成するフルパイプライン。

    Args:
        video_path:      入力動画ファイルパス
        pdf_path:        スライド PDF パス（省略可）
        output_dir:      出力ディレクトリ（省略時は config.output_dir）
        subtitle_lang:   出力字幕言語コード（CPS/文字数制約に使用）
        constraints_cfg: 制約設定（省略時は constraints.yaml から自動読み込み）

    Returns:
        PipelineResult（SRT パス・品質レポートパス等を含む）
    """
    config = load_config()
    providers = build_providers(config)
    constraints_cfg = constraints_cfg or load_constraints()
    subtitle_constraints = constraints_cfg.get_subtitle(subtitle_lang)

    out_dir = output_dir or config.output_dir
    stem = Path(video_path).stem
    os.makedirs(out_dir, exist_ok=True)

    metrics = PipelineMetrics()

    # [1/9] 音声抽出
    print(f"[1/9] 音声抽出: {video_path}")
    if progress_callback:
        progress_callback("extract_audio")
    with step_timer(metrics, "audio_extract") as sm:
        wav_path = await extract_audio(video_path, output_dir=out_dir)

    # [2/9] 書き起こし
    print(f"[2/9] 書き起こし ({config.whisperx_backend})")
    if progress_callback:
        progress_callback("transcribe")
    with step_timer(metrics, "transcribe") as sm:
        segments = await transcribe(wav_path, provider=providers.transcribe)
    print(f"      → {len(segments)} セグメント取得")

    # [3/9] PDF 抽出 + 用語辞書読み込み
    print("[3/9] PDF 抽出 + 用語辞書読み込み")
    if progress_callback:
        progress_callback("pdf_extract")
    with step_timer(metrics, "pdf_extract") as sm:
        slide_context = extract_slide_context(pdf_path) if pdf_path else None
    if slide_context:
        print(f"      → PDF 専門用語 {len(slide_context.glossary)} 件抽出")
    else:
        print("      → PDF なし（スキップ）")

    # フロントエンドの用語辞書を読み込む（auto-save 済みの glossary.json）
    gpath = glossary_path if glossary_path is not None else _default_glossary_path()
    app_glossary = load_glossary_json(gpath)

    # slide_context の glossary と app_glossary をマージ
    merged_glossary = (slide_context.glossary if slide_context else ()) + app_glossary

    # [4/9] 日本語補正
    if progress_callback:
        progress_callback("correct")
    print(
        f"[4/9] 日本語補正"
        f" ({config.correction_llm.provider} / {config.correction_llm.effective_model()})"
    )
    with step_timer(metrics, "correction") as sm:
        corrected = await correct_segments(
            segments,
            slide_context=slide_context,
            app_glossary=merged_glossary,
            llm=providers.correction_llm,
            embed=providers.embed,
            flag_threshold=constraints_cfg.quality.correction,
            batch_size=config.llm_batch_size,
        )
        sm.usages = [
            LLMUsage(**u) for u in
            providers.correction_llm.flush_usage() + providers.embed.flush_usage()
        ]
    flagged_corrections = tuple(s for s in corrected if s.correction_flagged)
    print(f"      → 補正フラグ: {len(flagged_corrections)} 件")

    # [5/9] 英訳
    if progress_callback:
        progress_callback("translate")
    print(
        f"[5/9] 英訳"
        f" ({config.translation_llm.provider} / {config.translation_llm.effective_model()})"
    )
    with step_timer(metrics, "translation") as sm:
        translated = await translate_segments(
            corrected,
            llm=providers.translation_llm,
            embed=providers.embed,
            flag_threshold=constraints_cfg.quality.translation,
            batch_size=config.llm_batch_size,
            glossary=merged_glossary,
        )
        sm.usages = [
            LLMUsage(**u) for u in
            providers.translation_llm.flush_usage() + providers.embed.flush_usage()
        ]
    flagged_translations = tuple(s for s in translated if s.translation_flagged)
    print(f"      → 翻訳フラグ: {len(flagged_translations)} 件")

    # [6/9] 字幕分割 + CPS 検証ループ
    if progress_callback:
        progress_callback("split")
    print(
        f"[6/9] 字幕分割 + CPS 検証ループ"
        f" (lang={subtitle_lang},"
        f" max_chars={subtitle_constraints.max_chars},"
        f" max_cps={subtitle_constraints.max_cps})"
    )
    with step_timer(metrics, "split") as sm:
        blocks = await split_into_blocks(
            translated,
            llm=providers.split_llm,
            constraints=subtitle_constraints,
        )
        sm.usages = [LLMUsage(**u) for u in providers.split_llm.flush_usage()]
    print(f"      → {len(blocks)} ブロック生成")

    # [7/9] タイムスタンプアライメント
    if progress_callback:
        progress_callback("align")
    print("[7/9] タイムスタンプアライメント")
    with step_timer(metrics, "align"):
        aligned_blocks = align_blocks(blocks, original_segments=segments)

    # [8/9] SRT 出力
    if progress_callback:
        progress_callback("srt_export")
    print("[8/9] SRT 出力")
    with step_timer(metrics, "srt_export"):
        srt_path = export_srt(
            aligned_blocks,
            output_path=str(Path(out_dir) / f"{stem}.srt"),
        )
    print(f"      → {srt_path}")

    # [9/9] 品質レポート出力（計測サマリーを含む）
    if progress_callback:
        progress_callback("report")
    print("[9/9] 品質レポート出力")
    metrics.print_summary()

    result = PipelineResult(
        subtitle_blocks=tuple(aligned_blocks),
        flagged_corrections=flagged_corrections,
        flagged_translations=flagged_translations,
        srt_path=srt_path,
        report_path="",
    )
    report_path = export_report(
        result,
        report_path=str(Path(out_dir) / f"{stem}_report.json"),
        extra={"metrics": metrics.to_dict()},
    )
    final_result = PipelineResult(
        subtitle_blocks=result.subtitle_blocks,
        flagged_corrections=result.flagged_corrections,
        flagged_translations=result.flagged_translations,
        srt_path=srt_path,
        report_path=report_path,
    )
    print(f"      → {report_path}")
    print(f"\n完了: フラグ合計 {final_result.total_flagged} 件 / "
          f"CPS 違反 {len(final_result.cps_violations)} 件")

    return final_result


def main() -> None:
    load_dotenv()

    parser = argparse.ArgumentParser(
        description="講義動画 → 英語 SRT 自動生成パイプライン"
    )
    parser.add_argument("--video", required=True, help="入力動画ファイルパス")
    parser.add_argument("--pdf", default=None, help="スライド PDF パス（任意）")
    parser.add_argument("--output", default=None, help="出力ディレクトリ")
    parser.add_argument(
        "--glossary",
        default=None,
        metavar="PATH",
        help=f"glossary.json のパス（省略時は OS 標準の appConfigDir を使用: {_default_glossary_path()}）",
    )
    parser.add_argument(
        "--constraints",
        default=None,
        metavar="PATH",
        help="constraints.yaml のパス（省略時はデフォルト値を使用）",
    )
    parser.add_argument(
        "--lang",
        default="en",
        metavar="LANG",
        help="出力字幕言語コード（CPS/文字数制約に使用）: en / ja / zh / ko ... (default: en)",
    )

    # 数値のオーバーライド（constraints.yaml を書き換えずに一時的に変更する場合）
    parser.add_argument("--max-chars", type=int, default=None, help="1ブロック最大文字数")
    parser.add_argument("--max-cps", type=float, default=None, help="最大 CPS")
    parser.add_argument("--max-retry", type=int, default=None, help="CPS違反時の最大試行回数")
    parser.add_argument("--correction-threshold", type=float, default=None,
                        help="補正乖離フラグ閾値（コサイン距離）")
    parser.add_argument("--translation-threshold", type=float, default=None,
                        help="翻訳乖離フラグ閾値（コサイン距離）")
    args = parser.parse_args()

    constraints_cfg = load_constraints(args.constraints)
    # CLI から数値が指定された場合、設定ファイルの値を上書き
    constraints_cfg = apply_overrides(
        constraints_cfg,
        lang=args.lang,
        max_chars=args.max_chars,
        max_cps=args.max_cps,
        max_retry=args.max_retry,
        correction_threshold=args.correction_threshold,
        translation_threshold=args.translation_threshold,
    )

    asyncio.run(
        run_pipeline(
            video_path=args.video,
            pdf_path=args.pdf,
            output_dir=args.output,
            subtitle_lang=args.lang,
            constraints_cfg=constraints_cfg,
            glossary_path=args.glossary,
        )
    )


if __name__ == "__main__":
    main()
