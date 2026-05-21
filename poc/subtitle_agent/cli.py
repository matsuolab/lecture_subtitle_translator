"""字幕最適化エージェント — エントリポイント.

使用方法:
    .venv\\Scripts\\python -m poc.subtitle_agent.cli \\
        --video "00_context/files/.../DL基礎_day2_JP確認.mp4"
    .venv\\Scripts\\python -m poc.subtitle_agent.cli \\
        --cache "poc/cache/DL基礎_day2_JP確認_cache.json" --limit 30
"""

import argparse
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from poc.subtitle_agent import constants
from poc.subtitle_agent.cache import load_or_build_cache
from poc.subtitle_agent.cost import format_cost_report
from poc.subtitle_agent.evaluate import get_embedding
from poc.subtitle_agent.evolution import run_evolution
from poc.subtitle_agent.llm import make_local_client
from poc.subtitle_agent.llm_backend import CachingBackend, OpenAICompatibleBackend
from poc.subtitle_agent.optimizer import optimize
from poc.subtitle_agent.report import write_evolution_report, write_report

# poc/.env から OPENAI_API_KEY 等を読み込む (cwd に依存しないよう絶対パス指定)。
load_dotenv(Path(__file__).resolve().parent.parent / ".env")


def _load_segments(video: str | None, cache: str | None, force: bool) -> tuple[list[dict], str]:
    """動画 or キャッシュからASRセグメントをロードする。"""
    if cache:
        import json

        with open(cache, "r", encoding="utf-8") as f:
            return json.load(f), Path(cache).stem
    if video:
        return load_or_build_cache(video, force), Path(video).name
    raise SystemExit("--video または --cache のいずれかを指定してください。")


def main() -> None:
    parser = argparse.ArgumentParser(description="字幕最適化エージェント (パイプライン A)")
    parser.add_argument("--video", help="講義動画ファイルのパス")
    parser.add_argument("--cache", help="書き起こしキャッシュJSONのパス (動画より優先)")
    parser.add_argument("--force", action="store_true", help="キャッシュを強制再作成")
    parser.add_argument("--limit", type=int, help="先頭Nキューのみ処理 (動作確認用)")
    parser.add_argument(
        "--generations",
        type=int,
        default=1,
        help="自己進化の世代数 (2以上で進化モード。既定1=単発実行)",
    )
    args = parser.parse_args()

    client = make_local_client()
    print(f"[INIT] LM Studio 接続テスト ({constants.LM_STUDIO_BASE_URL})...")
    get_embedding("接続テスト", client)
    print("[INIT] ローカル Embedding サーバー接続成功。")

    segments, name = _load_segments(args.video, args.cache, args.force)
    print(f"[INIT] ASRセグメント {len(segments)} 件をロードしました。")

    # 役割を分けた2つの強モデル (本番モデル, OpenAI互換)。
    #   segment_backend : 文章整理 (再分割の候補提案・日本語校正) — 高頻度
    #   meta_backend    : 改善を考える (メタ進化のプロンプト改善) — 低頻度
    # 応答はそれぞれ別ファイルにディスクキャッシュし世代・再実行をまたいで再利用。
    cache_dir = Path(__file__).resolve().parent.parent / "cache"
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    # inner (OpenAICompatibleBackend) はトークン利用量を保持するため参照を残す。
    seg_inner = meta_inner = None
    if api_key:
        seg_inner = OpenAICompatibleBackend(
            constants.STRONG_BASE_URL, api_key, constants.STRONG_MODEL
        )
        meta_inner = OpenAICompatibleBackend(
            constants.STRONG_BASE_URL, api_key, constants.META_MODEL
        )
        segment_backend = CachingBackend(
            seg_inner, cache_dir / "llm_cache_segment.json"
        )
        meta_backend = CachingBackend(
            meta_inner, cache_dir / "llm_cache_meta.json"
        )
        print(
            f"[INIT] 文章整理モデル: {constants.STRONG_MODEL} / "
            f"改善モデル: {constants.META_MODEL}"
        )
    else:
        segment_backend = None
        meta_backend = None
        print("[INIT] 警告: OPENAI_API_KEY が未設定です (poc/.env)。"
              "再分割は均等分割にフォールバックします。")

    def _print_cost() -> None:
        """LLM API のトークン利用量とコストを表示する。"""
        usages = [b.token_usage for b in (seg_inner, meta_inner) if b is not None]
        if usages:
            print("  --- LLM API コスト ---")
            for line in format_cost_report(usages):
                print(line)

    try:
        if args.generations > 1:
            if segment_backend is None or meta_backend is None:
                raise SystemExit(
                    "自己進化には強モデルが必要です。poc/.env に "
                    "OPENAI_API_KEY を設定してください。"
                )
            history = run_evolution(
                segments,
                client,
                args.generations,
                segment_backend,
                meta_backend,
                limit=args.limit,
            )
            report_file = write_evolution_report(history, name)
            print("\n" + "=" * 50)
            print(f"  実行世代数        : {len(history)}")
            for g in history:
                r = g.result
                print(
                    f"  Gen {g.generation}: 遵守率 {r.compliance_rate:.1f}%  "
                    f"類似度 {r.avg_similarity:.4f}  スコア {r.avg_score:.4f}"
                )
            seg_hit, seg_miss = segment_backend.stats
            meta_hit, meta_miss = meta_backend.stats
            print(f"  LLMキャッシュ     : 文章整理 {seg_hit} hit / {seg_miss} miss"
                  f"  改善 {meta_hit} hit / {meta_miss} miss")
            _print_cost()
            print(f"  世代比較レポート  : {report_file}")
            print("=" * 50)
            return

        result = optimize(
            segments, client, strong_backend=segment_backend, limit=args.limit
        )
    except Exception as e:
        print(f"\n[FATAL ERROR] 最適化中にエラー: {e}")
        sys.exit(1)

    report_file, srt_file = write_report(result, name)

    print("\n" + "=" * 50)
    print(f"  総キュー数        : {result.total}")
    print(f"  制約遵守率        : {result.compliance_rate:.1f}% "
          f"({result.compliant}/{result.total})")
    print(f"  平均コサイン類似度: {result.avg_similarity:.4f}")
    print(f"  平均総合スコア    : {result.avg_score:.4f}")
    print(f"  意味崩壊で却下    : {result.rejected}")
    if segment_backend is not None:
        hits, misses = segment_backend.stats
        print(f"  LLMキャッシュ      : {hits} hit / {misses} miss")
    _print_cost()
    print(f"  レポート          : {report_file}")
    print(f"  SRT               : {srt_file}")
    print("=" * 50)


if __name__ == "__main__":
    main()
