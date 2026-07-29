import { describe, expect, it } from 'vitest'
import type { AdminSettings } from '@/types/adminSettings'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import { runLocalPostPipeline } from './localPipeline'
import { resolveSubtitleQualityPreset } from './subtitleQualityPresets'
import { loadLanguageProfileConfig } from './languageProfileConfig'
import { WHISPERX_EN_TRANSCRIPT } from './enToJaLive.fixture'

declare const process: { env: Record<string, string | undefined> }

/**
 * 英語書きおこし → 日本語字幕 を実 API で通す動作確認テスト。
 *
 * 既定ではスキップされる。実行するには:
 *   RUN_EN_TO_JA_LIVE=1 OPENAI_API_KEY=... npx vitest run src/lib/pipeline/enToJaLive.test.ts
 *
 * OPENAI_CHAT_MODEL で使用モデルを上書きできる。
 */
const shouldRun = process.env.RUN_EN_TO_JA_LIVE === '1' && Boolean(process.env.OPENAI_API_KEY?.trim())

function buildEnToJaSettings(): AdminSettings {
  const base = getDefaultAdminSettings()
  const withLanguages: AdminSettings = {
    ...base,
    translationProvider: 'openai',
    openaiApiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
    subtitleLanguageLabel: 'Japanese',
    transcriptLanguageLabel: 'English',
    // 実 API 呼び出し回数を抑えるため、補助エージェントは切る（本筋は翻訳と整形）
    semanticCheckMode: 'off',
    coverageRepairEnabled: false,
    generalRepairEnabled: false,
    pipelineMergeContinuationEnabled: false,
  }
  const model = process.env.OPENAI_CHAT_MODEL?.trim()
  const withModel: AdminSettings = model
    ? {
        ...withLanguages,
        translationModel: model,
        correctionModel: model,
        compressModel: model,
        microModel: model,
        expandModel: model,
        contextMergeModel: model,
        splitJaModel: model,
      }
    : withLanguages

  // Phase2 の推奨プリセット（日本語字幕向けの行長・CPS・文字数比）を適用した状態で検証する
  const preset = resolveSubtitleQualityPreset(loadLanguageProfileConfig(withModel))
  return preset ? { ...withModel, ...preset.preset } : withModel
}

describe.skipIf(!shouldRun)('英→日パイプライン（実 API）', () => {
  it('英語書きおこしから日本語字幕を生成する', async () => {
    const settings = buildEnToJaSettings()
    const preset = resolveSubtitleQualityPreset(loadLanguageProfileConfig(settings))!.preset
    const steps: string[] = []
    const result = await runLocalPostPipeline(WHISPERX_EN_TRANSCRIPT, settings, (step) => { steps.push(step) })

    // 目視確認用の出力
    console.log('--- 実行ノード ---')
    console.log(steps.join(' -> '))
    console.log('--- 生成された字幕 ---')
    for (const block of result.blocks) {
      console.log(
        `[${block.startTime.toFixed(2)} -> ${block.endTime.toFixed(2)}] cps=${block.cps ?? '-'}\n` +
        `  transcript: ${block.transcript}\n` +
        `  subtitle  : ${JSON.stringify(block.subtitle)}\n` +
        `  violation : ${block.reviewSummary ?? '-'} (priority=${block.reviewPriority ?? '-'})\n` +
        `  chars=${block.subtitle.replace(/\s/g, '').length} 上限=${Math.floor(preset.enMaxCps * (block.endTime - block.startTime))}`,
      )
      for (const attempt of block.correctionAttempts ?? []) {
        console.log(
          `    試行: ${attempt.strategy} changed=${attempt.changed} ` +
          `${attempt.beforeChars}->${attempt.afterChars} ` +
          `violation ${attempt.beforeViolation}->${attempt.afterViolation}` +
          (attempt.rationale ? ` | ${attempt.rationale}` : ''),
        )
      }
    }
    console.log('--- レビュー項目 ---')
    for (const item of result.audit.reviewItems) {
      console.log(`  [${item.priority}] block=${item.blockId ?? '-'} ${item.reason}`)
    }
    console.log('--- 要確認 ---')
    console.log(`must=${result.audit.mustReviewCount} should=${result.audit.shouldReviewCount} auto=${result.audit.autoPassCount}`)

    expect(result.blocks.length).toBeGreaterThan(0)
    for (const block of result.blocks) {
      // 日本語へ翻訳されていること（かな・漢字を含む）
      expect(block.subtitle, `block ${block.id} が日本語でない`).toMatch(/[぀-ヿ㐀-䶿一-鿿]/)
      // 英語原文がそのまま残っていないこと
      expect(block.subtitle).not.toBe(block.transcript)
      // 日本語字幕の行結合で不要な空白が入っていないこと（英字用語の前後は除く）
      expect(block.subtitle, `block ${block.id} に全角前後の余分な空白`).not.toMatch(/[ぁ-んァ-ヶ一-龥]\s+[ぁ-んァ-ヶ一-龥]/)
      // 行数・行長が基準内であること
      const lines = block.subtitle.split('\n')
      expect(lines.length).toBeLessThanOrEqual(preset.enMaxLines)
      for (const line of lines) {
        expect(line.length, `行長超過: ${line}`).toBeLessThanOrEqual(preset.enMaxCharsPerLine)
      }
    }
  }, 300_000)
})
