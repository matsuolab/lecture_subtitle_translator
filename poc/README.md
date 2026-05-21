# 30_poc — PoC・概念実証

技術アプローチの実現可能性を検証するための実験コード・メモを置く場所。

## ファイル命名規則

`YYYYMMDD_<検証テーマ>.{md,py,ipynb}`

例: `20260325_whisperx_japanese_timestamp.ipynb`

## 実装済みPoC

| パス | 内容 | 状態 |
|------|------|------|
| `subtitle_agent/` | 自己進化字幕最適化エージェント。ASRセグメントを字幕キューへ再分割し翻訳・凝縮・評価を行うパイプライン A と、自己進化ハーネス B。強モデルは `LLMBackend` 抽象で差し替え可（文章整理=`gpt-5.4-mini` / メタ進化=`gpt-5.5-2026-04-23`、APIキーは `poc/.env`）。応答キャッシュ・LLM APIコスト計測あり。 | 実装中（#107）。LLM抽象化・`re_segment` 候補提案＋制約採点・分割の進化ループ外分離・コスト計測を実装済み。破綻日本語の文脈修復と最終E2Eが残 |
| `cps_autonomous_agent_poc.py` | 旧・自己進化型字幕最適化PoC（単一ファイル） | 廃止（`subtitle_agent/` へ移行） |

実行例:
```
.venv\Scripts\python -m poc.subtitle_agent.cli --cache "poc/cache/<name>_cache.json" --generations 3
```

## 検証予定テーマ

