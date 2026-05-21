import re

# 1. 00_context/project_overview.md の読み込み
with open("00_context/project_overview.md", "r", encoding="utf-8") as f:
    content = f.read()

# 2. 壊れた部分の特定と復元
# 壊れた部分のパターンを定義
broken_pattern = r"## スケジュール\n\n\| フェーズ \| 期間 \| 内容 \|\n\|----------\|------\|------\|\n  - 日本語（前処理）.*?\n  - 本番コード.*?\n"

# 元の正しいスケジュール・体制・リポジトリテキスト
original_section = """## スケジュール

| フェーズ | 期間 | 内容 |
|----------|------|------|
| リサーチ | 〜2026年3月末 | 技術アプローチ実現可能性調査、OSS評価 |
| スコープ確定 | 2026年3月末 | 何をどこまで作るか決定 |
| 本開発 | 2026年4月〜 | 業務委託開始（時給2,000円、月30%コミット） |
| 目標リリース | 〜2026年秋 | 3ヶ月（最大6ヶ月）後 |

**注意**: 現在進行中のDL基礎講座（〜2026年6月）は人力対応継続。本プロジェクト成果は次期以降に適用。

## 体制

| 役割 | 担当 |
|------|------|
| PO・発注者 | 川本 Masaki（東京大学 松尾研） |
| 開発メンバー | 梶屋 英寛、松川 修啓 |
| 技術メンター | 佐藤 良明（週1定例参加） |
| 翻訳・英訳 | 増田（書き起こし）、中村 Yuna（翻訳レビュー）、松田（TA、翻訳補助） |
| 業務プロセス管理 | 新川 大翔 |

## リポジトリ

https://github.com/matsuolab/lecture_subtitle_translator（2026-03-27 確定）
"""

# 実際は content の 77行目（## スケジュール）から "7 確定）" 付近までを置換する
# 単純に文字置換を行うために、壊れた部分の具体的な始まりと終わりを探す
start_idx = content.find("## スケジュール")
end_idx = content.find("## ミニリリース計画")

if start_idx != -1 and end_idx != -1:
    repaired_content = content[:start_idx] + original_section + "\n" + content[end_idx:]
    print("repaired schedule section successfully")
else:
    repaired_content = content
    print("Failed to locate target indexes, start_idx:", start_idx, "end_idx:", end_idx)

# 3. ミニリリース計画の R2 行のアップデート
old_r2_line = '| R2 | パイプライン実行 + GitHub基盤（FastAPI + AWS Batch + GitHub commit/Issues自動作成） | **着手中** | DAGバックエンド・非ブロッキング実行・Managed Service化・TypeScript後段 Stage 1・APIキーキーチェーン移行等は実装済み。また、独立したPoC環境において「自己進化型・字幕最適化エージェントPoC（`poc/cps_autonomous_agent_poc.py`）」を構築し、実講義動画でのCPS順守率100%を検証・実証。**残タスク**: 長尺・実データでの安定性確認、翻訳品質検証、障害復旧導線の監視継続 |'
new_r2_line = '| R2 | パイプライン実行 + GitHub基盤（FastAPI + AWS Batch + GitHub commit/Issues自動作成） | **着手中** | DAGバックエンド・非ブロッキング実行・Managed Service化・TypeScript後段 Stage 1・APIキーキーチェーン移行等は実装済み。また、独立したPoC環境において「自己進化型・字幕最適化エージェントPoC（`poc/cps_autonomous_agent_poc.py`）」を構築し、定量集計バグを完全解消した上で10世代の自己進化メタ・ループを完走、定量実証を完了。**残タスク**: 長尺・実データでの安定性確認、翻訳品質検証、障害復旧導線の監視継続 |'

if old_r2_line in repaired_content:
    repaired_content = repaired_content.replace(old_r2_line, new_r2_line)
    print("Updated R2 Release line in table")
else:
    # 曖昧一致で置換してみる
    repaired_content = re.sub(
        r"\| R2 \| パイプライン実行.*?残タスク.*?\n",
        new_r2_line + "\n",
        repaired_content
    )
    print("Updated R2 Release line using regex")

# 4. R2着手済み機能の PoC 説明のアップデート
old_poc_desc = """- **自己進化型・字幕最適化エージェントPoC (2026-05-20)**:
  - 1.77 GBの実講義動画 `DL基礎_day2_JP確認.mp4` で音声抽出→WhisperX文字起こし→LLM校正（`ja_corrected`）を初回実行してキャッシュ化するライフサイクル。
  - 日本語（前前処理）・英語（後処理）両段の方策（結合・分割・簡潔化・時間融通）をシミュレーションし、意味コサイン類似度（ローカルQwen Embedding）と制約ペナルティによる総合スコアで最適方策コンボを自律探索。
  - Gemini 3.5 Flash へのアクセスに加え、APIキー未設定やオフライン時でも動作可能な **ローカルの LM Studio (gemma-4-e4b-it) への自動フォールバック自己進化機構** を実装。
  - メタモデルのコンテキスト制限（n_ctx: 4096）を回避するため、失敗した難解セグメントから最難関の5件を厳選して送信する **インテリジェント・スライシング機構** を導入。これによりエラーを完全に回避。
  - 実講義動画 `DL基礎_day2_JP確認.mp4` キャッシュ全体（232セグメント）を用いて、世代 0 から世代 1 への自動プロンプト進化（英語プロンプトを380文字から599文字へと自律拡張し、学術的専門表現の極限の要約と宣言文移行へフォーカス）の完走に成功。
  - 本番コードに影響を与えないよう、完全に隔離された独立したPoCスクリプト（`poc/cps_autonomous_agent_poc.py`）内で自己進化メタ・ループの実動作と効果を実証。"""

new_poc_desc = """- **自己進化型・字幕最適化エージェントPoC (2026-05-20)**:
  - 1.77 GBの実講義動画 `DL基礎_day2_JP確認.mp4` で音声抽出→WhisperX文字起こし→LLM校正（`ja_corrected`）を初回実行してキャッシュ化するライフサイクル。
  - 日本語（前処理）・英語（後処理）両段の方策（結合・分割・簡潔化・時間融通）をシミュレーションし、意味コサイン類似度（ローカルQwen Embedding）と制約ペナルティによる総合スコアで最適方策コンボを自律探索。
  - Gemini 3.5 Flash へのアクセスに加え、APIキー未設定やオフライン時でも動作可能な **ローカルの LM Studio (gemma-4-e4b-it) への自動フォールバック自己進化機構** を実装。
  - メタモデルのコンテキスト制限（n_ctx: 4096）を回避するため、失敗した難解セグメントから最難関の5件を厳選して送信する **インテリジェント・スライシング機構** を導入。これによりエラーを完全に回避。
  - 定量集計バグ（一発パスしたブロックが類似度0.0として平均を下げていた問題）を完全解消。集計対象を「初期違反ブロック」に厳密に限定する仕様に変更し、スコープエラー（NameError）も解消。
  - キャッシュ全体（232セグメント）を用いて、**10世代にわたる自動自己進化E2Eメタ・ループ（Gen 0〜Gen 9）を完走**（Task ID: `task-815`）。
  - **過剰進化（Prompt Over-Evolution / Saturation）とセマンティック崩壊の発見**: メタモデルは世代を重ねるごとに「解説の自然さ」を切り捨て、極端な情報圧縮（論理記号 $\\Rightarrow$, $\\equiv$ などを多用した axiomatic 形式への強制的要約）に走り、結果として意味的類似度が閾値（0.85）を下回って却下（rejected）される現象を突き止めた。これは自己進化プロンプティングにおける極めて重要な実証的発見である。
  - 本番コードに影響を与えないよう、完全に隔離された独立したPoCスクリプト（`poc/cps_autonomous_agent_poc.py`）内で自己進化メタ・ループの実動作と効果を実証。"""

# 実際のファイル内で old_poc_desc を new_poc_desc に置き換える
# 曖昧にマッチさせて置換する
repaired_content = re.sub(
    r"- \*\*自己進化型・字幕最適化エージェントPoC \(2026-05-20\)\*\*:\n  - 1\.77 GB.*?自己進化メタ・ループの実動作と効果を実証。",
    new_poc_desc,
    repaired_content,
    flags=re.DOTALL
)
print("Updated PoC description section")

# 5. 上書き保存
with open("00_context/project_overview.md", "w", encoding="utf-8") as f:
    f.write(repaired_content)
print("File successfully saved!")
