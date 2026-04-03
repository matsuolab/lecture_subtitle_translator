# 用語集・翻訳メモリ 設計ドキュメント

> 作成: 2026-03-29
> 最終更新: 2026-04-03
> ステータス: **Sprint 1 実装完了 / Sprint 2 設計確定・実装待ち**
> 決定者: 梶屋（PO）+ Claude（設計サポート）

---

## 概要

字幕エディタ（V2S-AIE）に用語集（Glossary）と翻訳メモリ（TM）を追加する。
この2機能は独立したファイルとして管理し、翻訳品質の向上・一貫性確保に使う。

---

## 1. 用語集（Glossary）

### 役割

- 日本語技術用語 → 英語訳の対応表
- バックエンド翻訳時（Gemini等）のプロンプトに注入し「この用語は必ずこう訳せ」と指示する
- 静的・手動管理（翻訳のたびに自動追加はしない）

### カノニカルフォーマット：CSV

```csv
ja,en,abbreviation,domain,note
機械学習,Machine Learning,ML,基礎,
強化学習,Reinforcement Learning,RL,基礎,
アテンション機構,Attention Mechanism,,Transformer,
```

| 列 | 必須 | 説明 |
|----|------|------|
| `ja` | ✅ | 日本語の元用語 |
| `en` | ✅ | 英語の翻訳 |
| `abbreviation` | ─ | 略語（ML, RL等） |
| `domain` | ─ | 用語のドメイン（講義別絞り込み用、将来対応） |
| `note` | ─ | 備考・コメント |

### 保存場所

- **独立CSVファイル**（プロジェクトJSONには内包しない）
- D&D またはファイル選択で読み込む
- localStorage に自動保存（セッション間永続化）
- 複数プロジェクト・複数講義で共有できる設計

### インポートアーキテクチャ（実装済み）

```
外部ファイル ──→ Converter ──→ GlossaryContext（メモリ + localStorage）
                    ↑
        ├── csvParser.ts      カノニカルCSV（ja, en, abbreviation, domain, note）
        ├── xlsxConverter.ts  松尾研用語集（DL基礎講座用語集.xlsx）
        │     列マッピング確認済み: col[2]=ja, col[3]=en, col[4]=abbreviation
        └── （将来）tbxConverter  業界標準TBX
```

実装場所: `frontend/src/lib/glossary/`

#### 松尾研XLSXの列構造（実測値・確認済み 2026-03-29）

| 列 | 内容 |
|----|------|
| 0 | 講義番号 |
| 1 | ページ番号 |
| 2 | **日本語（ja）** |
| 3 | **英語（en）** |
| 4 | **略語（abbreviation）** |
| 5+ | メモ等（変換時は無視） |

行数: 990エントリ（ヘッダー除く）

### TypeScript型定義（実装済み）

```typescript
interface GlossaryEntry {
  id: string
  ja: string
  en: string
  abbr?: string
  domain?: string
  note?: string
  desc?: string         // 詳細説明（手動入力・初期データ用）
  source?: string       // 出典（論文・スライド等）
  sourceUrl?: string | null
  confirmed: boolean    // 将来のワークフロー用（現在UIには非表示）
}
```

### 確認済みステータスの扱い方針（2026-03-30 決定）

- `confirmed` フィールドはデータ型に保持するが、**UIには現在表示しない**
- インポートされた用語はすべて `confirmed: true` として全ブロックへの適用対象にする
- 確認済み/未確認の運用ルール・イシュー連携は用語集運用方針が決まってから実装する
- 将来の自動抽出機能と組み合わせて設計を再検討する

---

## 2. 字幕ブロックへの用語ハイライト（実装済み）

### 仕組み

ブロック表示時に、ライブの用語集コンテキストからマッチする用語をリアルタイム計算して表示する。

```
GlossaryContext（用語集）
        ↓
matchGlossaryToSource(block.source, glossary)
  └── 単語境界regex + 大文字小文字無視 + 単純複数形対応
        ↓
TermHighlight（アンダーライン + ホバーツールチップ: ja → en）
```

- `useMemo` で `block.source` または `glossary` 変更時のみ再計算
- 静的な `block.glossaryTerms`（旧設計）は不使用になった

### マッチング精度について（2026-03-30 検討済み）

**現在の手法（regex）で十分なケース:**
- 大文字小文字の揺れ: "transformer" → "Transformer" ✅
- 単純複数形: "Transformers" → "Transformer" ✅
- 所有格: "Transformer's" → "Transformer" ✅

**ベクトル近似マッチングを検討した結果:**
- 用語集ハイライト用途（単語・フレーズレベル）: **不採用**
  - 技術用語は固有で曖昧性が低く、regexで実用上カバー可能
  - ベクトル化のコストに見合わない（Transformers.js で990件: ~20〜50秒）
  - 必要になれば `fuse.js`（軽量fuzzy）を中間選択肢として検討する
- **TM（セグメントレベル）: ベクトル必須** → セクション3参照

### TMとの流用設計

`matchGlossaryToSource` と同じパターンを TM にも適用できる：

```typescript
// 用語集（実装済み）
matchGlossaryToSource(source: string, entries: GlossaryEntry[]): GlossaryTerm[]

// TM（Sprint 2 で追加予定）
matchTMToSource(source: string, tmEntries: TMEntry[]): TMSuggestion[]
```

`TermHighlight` コンポーネントはすでに汎用設計なので、TM の結果もそのまま渡せる。

---

## 3. 翻訳メモリ（TM）

> **ステータス: 設計確定・実装は Sprint 2**

### 役割

- 承認済み字幕ブロックの (日本語, 英語) ペアを自動蓄積
- 新しい字幕ブロック翻訳時に類似セグメントを検索・提案
- 動的・自動管理（ブロック承認のたびに追記）

### 類似度計算方針（2026-04-02 方針変更）

**OpenAI Embedding API + コサイン距離** を使う。

> ⚠️ 2026-04-02 変更: 翻訳本体をOpenAI統一方針に決定したため、GeminiからOpenAIに切り替え。
> 詳細調査は `docs/research/` にて別途実施予定（ongoing_issues #I）。

- セグメントレベル（文単位）の意味的類似度 → ベクトルが必須
- 候補モデル: `text-embedding-3-small`（$0.02/1M, 1536次元）or `text-embedding-3-large`（$0.13/1M, 3072次元）
- クライアントサイドの軽量モデル（Transformers.js）は品質・バンドルサイズの観点で不採用
- バックエンド側で処理し、フロントエンドは結果（候補リスト）を受け取るだけ
- APIキーは設定可能な設計にする（OSS対応）
- ベクトルDB: sqlite-vec との組み合わせを検討（R4 翻訳メモリ + 複数講座対応フェーズ）

### 保存フォーマット：JSON

```json
[
  {
    "id": "tm-001",
    "sourceSegment": "機械学習の基本的な考え方について説明します。",
    "targetSegment": "I will explain the basic concepts of machine learning.",
    "approvedAt": "2026-03-29T10:00:00Z",
    "blockId": 42,
    "projectFile": "lecture_02.srt"
  }
]
```

### TypeScript型定義（設計のみ）

```typescript
interface TMEntry {
  id: string
  sourceSegment: string   // 日本語（文レベル）
  targetSegment: string   // 英語（文レベル）
  approvedAt: string      // ISO8601
  blockId: number
  projectFile: string
}
```

### 用語集との比較

| | 用語集 (Glossary) | 翻訳メモリ (TM) |
|--|---|---|
| 粒度 | 単語・フレーズ | 文・セグメント |
| マッチ手法 | regex（単語境界） | ベクトル類似度（Gemini Embedding） |
| フィールド名 | `ja` / `en` | `sourceSegment` / `targetSegment` |
| ファイル | `glossary.csv` | `translation_memory.json` |
| 更新 | 手動インポート | 承認時に自動追記 |
| 処理場所 | フロントエンド | バックエンド（Embedding API） |

---

## 4. スプリント計画

### Sprint 0（完了）
- 字幕エディタ本体: SRT読み込み・表示・編集・承認・エクスポート
- Tauri v2 対応 / GitHub Actions リリースCI

### Sprint 1（完了 2026-03-30）

| タスク | ステータス |
|--------|-----------|
| `GlossaryEntry` 型定義 | ✅ |
| CSVパーサー / エクスポーター | ✅ `src/lib/glossary/csvParser.ts` |
| XLSXコンバーター（松尾研形式） | ✅ `src/lib/glossary/xlsxConverter.ts` |
| 用語集タブUI（インポート・エクスポート・全ブロック適用） | ✅ |
| D&DでCSV/XLSXインポート（タブ・右パネル両対応） | ✅ |
| localStorage永続化 | ✅ |
| ライブ用語ハイライト（matchGlossaryToSource） | ✅ |
| 確認済UIの簡素化（運用方針決定まで非表示） | ✅ |


### 2026-04-03 追記（パフォーマンス・Desktop安定化）

- 用語集インポート時の `importEntries` を map ベース更新に変更し、`findIndex` ループを排除（大量語彙時の取り込み時間を短縮）。
- `GlossaryTab` にインポート中状態（`読み込み中...`）を追加し、取り込み開始時に `requestAnimationFrame` で先にUIを描画してフリーズ感を緩和。
- `SubtitleBlock` では重い用語チェックを常時実行せず、アクティブブロック中心で評価する方針に変更（用語集読込後の一覧操作を改善）。
- Tauriビルド版のドラッグ&ドロップ互換性のため、HTML5 D&D に加えてネイティブ `onDragDropEvent` フォールバックを導入。
- EXEでローカル動画を再生できるよう、`tauri.conf.json` の `assetProtocol` を有効化。

### Sprint 2（次）: 翻訳メモリ

| タスク | 内容 |
|--------|------|
| 2-1 | `TMEntry` 型定義・JSONファイル管理 |
| 2-2 | ブロック承認時の自動TM追記 |
| 2-3 | 類似セグメント検索（Gemini Embedding + コサイン距離、バックエンド側） |
| 2-4 | TM提案UI（`matchTMToSource` → TermHighlight流用） |

### Sprint 3: バックエンド連携

- FastAPI + WhisperX + Gemini との統合
- 用語集をプロンプトに自動注入
- TM Embedding の Gemini API 処理をバックエンドに実装

---

## 5. OSSとの関係

- カノニカル形式（CSV: `ja,en,abbreviation,domain,note`）は普遍的で松尾研依存なし
- XLSXコンバーターは「松尾研用」として明示してリポジトリに含める
- 他機関が独自の用語集形式を持つ場合、コンバーターを追加するだけでOK
- TMの類似度計算はEmbedding API依存 → APIキー設定可能な設計にする
- `confirmed`ワークフロー・イシュー連携は組織のルールに応じてカスタマイズできる設計にする
