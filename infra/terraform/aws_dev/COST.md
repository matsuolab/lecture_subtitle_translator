# AWSコスト管理ドキュメント

> 最終更新: 2026-05-12  
> 対象環境: `matsuo-subtitle-pipeline-dev`（ap-northeast-1）

---

## 適用済み設定（2026-05-12 実施）

`terraform apply` により以下の4リソースを本番環境に適用済み。

| リソース | 適用結果 |
|---------|---------|
| `aws_budgets_budget.monthly` | ✅ 作成完了 — $8（80%）・$10（100%）でメール通知 |
| `aws_ecr_lifecycle_policy.worker` | ✅ 作成完了 — untagged 1日後削除 / タグ付き5件保持 |
| `aws_s3_bucket_lifecycle_configuration.input` | ✅ 作成完了 — 1日で自動削除 |
| `aws_s3_bucket_lifecycle_configuration.result` | ✅ 作成完了 — 30日でIA移行 / 120日で削除 |

実コスト実績（AWS Cost Explorer より、2026-05-12 時点）:

| 月 | 合計 | 主要因 |
|----|------|-------|
| 3月 | ~$1.54 | Config のみ（Batch 未使用） |
| 4月 | ~$2.23 | ECR・EBS スナップショット発生 |
| 5月（月換算） | ~$5.9 | EBS スナップショット積み上がり（安定後 ~$3.6/月見込み） |

---

## 料金単価と公式ドキュメント

| サービス | 単価 | 公式ドキュメント |
|---------|------|----------------|
| g4dn.xlarge On-Demand | $0.71/hr | [EC2 オンデマンド料金](https://aws.amazon.com/jp/ec2/pricing/on-demand/) |
| g4dn.xlarge Spot | ~$0.245/hr（変動） | [EC2 Spot 料金](https://aws.amazon.com/jp/ec2/spot/pricing/) |
| EBS gp3 | $0.096/GB/月 | [EBS 料金](https://aws.amazon.com/jp/ebs/pricing/) |
| EBS スナップショット | $0.05/GB/月 | [EBS 料金](https://aws.amazon.com/jp/ebs/pricing/) |
| ECR ストレージ | $0.10/GB/月 | [ECR 料金](https://aws.amazon.com/jp/ecr/pricing/) |
| S3 Standard | $0.025/GB/月 | [S3 料金](https://aws.amazon.com/jp/s3/pricing/) |
| S3 Standard-IA | $0.0138/GB/月 | [S3 料金](https://aws.amazon.com/jp/s3/pricing/) |
| Secrets Manager | $0.40/シークレット/月 | [Secrets Manager 料金](https://aws.amazon.com/jp/secrets-manager/pricing/) |
| AWS Config | $0.003/設定項目 | [AWS Config 料金](https://aws.amazon.com/jp/config/pricing/) |
| Lambda | 100万リクエスト無料枠あり | [Lambda 料金](https://aws.amazon.com/jp/lambda/pricing/) |
| API Gateway (HTTP) | $1.00/100万リクエスト | [API Gateway 料金](https://aws.amazon.com/jp/api-gateway/pricing/) |
| AWS Budgets | 最初の2件無料 | [Budgets 料金](https://aws.amazon.com/jp/aws-cost-management/aws-budgets/pricing/) |

> 単価は AWS Pricing API より 2026-05-12 に取得。Spot 価格は市場変動あり。

---

## 月次コスト試算

### 固定費（ジョブ未実行時のインフラ維持費）

| 項目 | 根拠 | 月額（目安） |
|------|------|------------|
| AWS Config | ルール評価（実績値） | ~$1.2 |
| EBS スナップショット | カスタム AMI（実データ約 28.5 GB）× $0.05 | ~$1.5 |
| ECR | ワーカーイメージ保持（ライフサイクル適用後 ~4 GB）× $0.10 | ~$0.4 |
| Secrets Manager | bearer token 1 件（固定） | ~$0.4 |
| S3 / Lambda / API GW ほか | 実績値ベース | ~$0.1 |
| **固定合計** | | **~$3.6/月** |

### 変動費（ジョブ実行コスト）

処理時間の実測値（第4回講義データ）: **18.6 分/ジョブ**

| 課金形態 | 計算式 | 1 ジョブあたり |
|---------|--------|-------------|
| Spot | $0.245 × (18.6/60) hr | **~$0.076** |
| On-Demand | $0.71 × (18.6/60) hr | **~$0.22** |

| 月間ジョブ数 | Spot 想定 合計 |
|------------|--------------|
| 10 本 | ~$4.4/月 |
| 20 本 | ~$5.1/月 |
| 50 本 | ~$7.4/月 |

---

---

## 月次コスト予測

### 固定費（毎月必ずかかるインフラ維持費）

| 項目 | 計算根拠 | 月額予測 |
|------|---------|---------|
| AWS Config | 実績値 | $1.2 |
| EBS スナップショット | AMI 実データ 28.5 GB × $0.05 | $1.5 |
| ECR ストレージ | ライフサイクル適用後 ~4 GB × $0.10 | $0.4 |
| Secrets Manager | bearer token 1件 × $0.40 | $0.4 |
| S3 / Lambda / API GW | 実績値ベース（字幕ファイルはKB単位） | $0.1 |
| **固定合計** | | **$3.6/月** |

### 変動費（ジョブ実行コスト）

処理時間の実測値（第4回講義データ）: **18.6 分/ジョブ**

| 課金形態 | 単価 | 1ジョブ（18.6分） |
|---------|------|----------------|
| Spot（通常） | $0.245/hr | **$0.076** |
| On-Demand（Spot中断時） | $0.71/hr | **$0.22** |

### API コスト（翻訳・補正）

翻訳・補正処理に使用するLLM APIのコスト。WhisperXはGPU上でローカル実行のためAPI料金なし。

**料金テーブル（`poc/step2_pipeline/metrics.py` より、USD/1Mトークン）:**

| モデル | 入力 | 出力 | 公式ドキュメント |
|-------|------|------|----------------|
| gpt-4.1 | $2.00 | $8.00 | [OpenAI Pricing](https://openai.com/api/pricing/) |
| gpt-4.1-mini | $0.40 | $1.60 | [OpenAI Pricing](https://openai.com/api/pricing/) |
| gemini-2.5-flash | $0.30 | $2.50 | [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| gemini-2.5-flash-lite | $0.10 | $0.40 | [Gemini Pricing](https://ai.google.dev/gemini-api/docs/pricing) |

**1ジョブあたりAPI推定コスト（90分講義、約30,000入力トークン・15,000出力トークン想定）:**

| モデル | 推定コスト/ジョブ | 備考 |
|-------|----------------|------|
| gpt-4.1-mini | **~$0.04** | 通常翻訳 |
| gpt-4.1 | **~$0.18** | 高品質翻訳・再翻訳 |
| gemini-2.5-flash | **~$0.05** | 代替案 |

> ⚠️ トークン数は実測値なし。`poc/step2_pipeline/metrics.py` の計測機能で実ジョブのコストを取得後に更新すること。

### 運用シナリオ別月次予測

| シナリオ | ジョブ数 | AWS変動費 | API費（gpt-4.1-mini） | **月額合計** |
|---------|---------|----------|---------------------|------------|
| 開発・テスト期 | ~10本 | $0.8 | $0.4 | **~$4.8** |
| 講義運用期（通常） | ~20本 | $1.5 | $0.8 | **~$5.9** |
| 講義運用期（高負荷） | ~50本 | $3.8 | $2.0 | **~$9.4** |
| 異常検知ライン | — | — | — | **$8（アラート）** |
| 予算上限 | — | — | — | **$10（AWS分のみ。API費は別途）** |

> AWS Budgets の $10 上限は **AWSサービス費のみ**。OpenAI / Gemini API費は別途 OpenAI / Google の請求となる。

### 講座期間（2026年4〜7月）の総コスト試算

| 期間 | シナリオ | AWS月額 | API月額 | 月合計 | 期間合計 |
|------|---------|--------|--------|-------|---------|
| 4月（テスト） | 開発・テスト期 | $4.4 | $0.4 | $4.8 | $4.8 |
| 5月（移行） | 開発・テスト期 | $4.4 | $0.4 | $4.8 | $4.8 |
| 6〜7月（運用） | 講義運用期（通常） | $5.1 | $0.8 | $5.9 | $11.8 |
| **合計** | | | | | **~$21** |

> API コストは実測値取得後に更新予定。

---

## EBS スナップショットについて

カスタム AMI `ami-0c1d51ced451f9ec0`（2026-04-29 作成）に紐づくスナップショット 1 件が存在する。

**作成経緯**: WhisperX Docker イメージ（約 28 GB）を毎回 pull すると起動に 19 分以上かかるため、
イメージをあらかじめ焼き込んだカスタム AMI を作成した。これにより `batch_image_pull_behavior = "prefer-cached"` が機能し、ジョブ起動時間を大幅に短縮している。

**スナップショットは増えない**: AMI を新規作成しない限り増加しない。月 ~$1.5 の固定コストとして扱う。

**削除不可**: このスナップショットを削除すると AMI が破損し、Batch ジョブが起動できなくなる。

---

## コストアラート設定

| アラート種別 | しきい値 | 通知先 |
|------------|---------|-------|
| 早期警告 | $8（月次予算の 80%） | AIE-DXproject_3@weblab.t.u-tokyo.ac.jp |
| 超過警告 | $10（月次予算の 100%） | 同上 |

**$10 を上限とした理由**:
- 固定費ベースライン ~$3.6/月
- Spot ジョブ 50 本/月でも ~$7.4（上限内）
- $8 通知時点でジョブが急増していないか確認できる
- $10 超過 = ジョブ異常実行・想定外リソース起動など異常の可能性が高い

Terraform 変数での設定箇所: `terraform.tfvars.dev-default`

```hcl
budget_alert_email = "AIE-DXproject_3@weblab.t.u-tokyo.ac.jp"
monthly_budget_usd = 10
```

---

## S3 ライフサイクル設定

| バケット | 設定 | 理由 |
|---------|------|------|
| input | **1 日で削除** | 処理完了後は不要。サイズが大きい音声ファイルを残す意味がない |
| result | **30 日で Standard-IA 移行、120 日で削除** | 字幕ファイルは講義期間中（開講〜3〜4 ヶ月）参照できれば十分。中村さんの編集ワークフローを考慮して 120 日に設定 |

---

## ECR ライフサイクル設定

| ルール | 設定 | 理由 |
|-------|------|------|
| untagged イメージ | **1 日後に削除** | `latest` タグの上書き push のたびに untagged イメージが蓄積されるため |
| タグ付きイメージ | **5 件まで保持** | 直近 5 ビルド分あればロールバック対応に十分 |
