/**
 * 設定されたモデルが reasoning トークンを消費するか、そして未完判定のバッチが
 * 実行時にどの max_tokens で送られるかを、実際に1回だけAPIを叩いて確かめる診断スクリプト。
 *
 * 背景: モデルプロファイル（modelProfile.ts）は preset='auto' のときモデル名に
 * 'gemma' / 'qwen' が含まれるかでしか推定できず、それ以外は undefined を返す。
 * undefined だと detectIncompleteEnds のバッチクランプ（thinking系は8件）も
 * withReasoningHeadroom の割り増しも効かない。実行がこの状態に該当するのか、
 * そして該当した場合に本当に出力上限で切れるのかを、推測ではなく実測で確認する。
 *
 * 使い方（frontend ディレクトリで実行）:
 *   OPENAI_API_KEY_FILE=/path/to/key TSX_TSCONFIG_PATH="$(pwd)/tsconfig.app.json" node --import tsx \
 *     --import ./scripts/importMetaEnvShim.mjs scripts/probeModelReasoning.ts <project.json>
 */
import { readFileSync } from 'node:fs'

import { normalizeAdminSettings } from '../src/api/adminSettings'
import { resolveChatModelForProvider, requireChatModelForProvider } from '../src/lib/pipeline/aiProvider'
import { resolveModelProfile, withReasoningHeadroom } from '../src/lib/pipeline/modelProfile'
import { llmCallWithMeta } from '../src/lib/pipeline/llmCallWithMeta'
import { resolveApiKey } from './resolveApiKey'
import type { AdminSettings } from '../src/types/adminSettings'

// detectIncompleteEnds.ts の同名定数と同じ値。実行時に送られる max_tokens を再現するために使う。
const ESTIMATED_TOKENS_PER_RESULT_ITEM = 12
const RESPONSE_ENVELOPE_OVERHEAD_TOKENS = 16

const DETECTION_SYSTEM_PROMPT =
  'You are a fast subtitle-fragment classifier. '
  + 'For each input item, decide if it ENDS MID-SENTENCE (i.e., it is grammatically incomplete and continues into the next utterance). '
  + 'Be fast and approximate. Multi-language input is fine. '
  + 'Respond only with JSON: {"r":[{"i":<id>,"x":<true|false>}, ...]} where x=true means INCOMPLETE.'

function buildSettings(projectJson: unknown): AdminSettings {
  const session = (projectJson as Record<string, unknown>).session as Record<string, unknown> | undefined
  const normalized = normalizeAdminSettings(session?.adminSettings)
  const openaiApiKey = resolveApiKey()
  if (!openaiApiKey) throw new Error('APIキーが未設定です。OPENAI_API_KEY か OPENAI_API_KEY_FILE を指定してください')
  return { ...normalized, openaiApiKey, openaiCompatibleBaseUrl: '', translationProvider: 'openai' }
}

/** 実行時に未完判定へ渡される最初の30件を、保存済みプロジェクトから取り出す。 */
function loadItems(project: Record<string, unknown>, count: number): string[] {
  const session = (project.session ?? {}) as Record<string, unknown>
  const run = (session.pipelineRun ?? {}) as Record<string, unknown>
  const debug = (run.debug ?? {}) as Record<string, unknown>
  const stages = (debug.stageSnapshots ?? []) as Array<{ stage: string; items?: Array<{ transcriptText?: string }> }>
  const stage = stages.find(s => s.stage === 'semanticSplitJa')
  if (!stage?.items) throw new Error('semanticSplitJa スナップショットが見つかりません')
  return stage.items.slice(0, count).map(i => i.transcriptText ?? '')
}

async function main(): Promise<void> {
  const path = process.argv[2]
  if (!path) throw new Error('Usage: probeModelReasoning.ts <project.json>')
  const project = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  const settings = buildSettings(project)

  const requested = settings.incompleteEndDetectionModel || settings.splitJaModel
  const resolved = resolveChatModelForProvider(settings, requested)
  const profile = resolveModelProfile(settings, resolved)

  console.log('■ プロファイル解決')
  console.log(`  chatTextProfilePreset : ${settings.chatTextProfilePreset}`)
  console.log(`  modelProfilePreset    : ${settings.modelProfilePreset}`)
  console.log(`  モデル                : ${resolved}`)
  console.log(`  解決されたプロファイル  : ${profile ? `${profile.id} (reasoning=${profile.reasoning.capability})` : 'undefined ← 推定できていない'}`)

  const batchSize = Math.max(1, settings.incompleteEndDetectionBatchSize)
  const desired = batchSize * ESTIMATED_TOKENS_PER_RESULT_ITEM + RESPONSE_ENVELOPE_OVERHEAD_TOKENS
  // 第2引数で max_tokens を上書きできる。「上限を広げたとき、推論が上限まで膨らむのか
  // それとも必要な分で止まるのか」を実測するために使う（膨らむなら上限を広げる案はコスト増になる）。
  // 'none' を渡すと max_tokens 自体を送らない（applyChatRequestDialect は数値でなければ
  // フィールドを付けない）。API 側の大きいモデルでは上限を外す方が良いか、を実測するため。
  const arg = process.argv[3]
  const override = Number(arg)
  const maxTokens = arg === 'none'
    ? undefined
    : Number.isFinite(override) && override > 0
      ? Math.trunc(override)
      : withReasoningHeadroom(desired, profile)
  console.log('')
  console.log('■ 実行時にこのバッチへ渡される値')
  console.log(`  バッチサイズ  : ${batchSize} 件（thinking系と判定されれば 8 にクランプされる）`)
  console.log(`  希望出力      : ${desired} トークン`)
  console.log(`  max_tokens    : ${maxTokens}（プロファイル未解決なら割り増しなし＝希望値そのまま）`)

  const items = loadItems(project, batchSize)
  const userContent = JSON.stringify({ items: items.map((text, i) => ({ i, t: text })) })

  console.log('')
  console.log('■ 同じ条件で1回だけ実際に呼ぶ')
  const result = await llmCallWithMeta(
    {
      model: requireChatModelForProvider(settings, requested, 'probe'),
      systemPrompt: DETECTION_SYSTEM_PROMPT,
      userContent,
      maxTokens,
      nodeName: 'probe_detect_incomplete_ends',
    },
    settings,
  )
  console.log(`  finishReason      : ${result.finishReason}`)
  console.log(`  errorCode         : ${result.errorCode ?? '(なし)'}`)
  console.log(`  promptTokens      : ${result.promptTokens}`)
  console.log(`  completionTokens  : ${result.completionTokens}`)
  console.log(`  reasoningTokens   : ${result.reasoningTokens ?? '(記録なし)'}`)
  console.log(`  本文の長さ        : ${result.content.length} 文字`)
  if (result.errorMessage) console.log(`  errorMessage      : ${result.errorMessage.slice(0, 200)}`)

  const reasoning = result.reasoningTokens ?? 0
  console.log('')
  console.log('■ 判定')
  if (reasoning > 0) {
    const ratio = result.completionTokens ? (reasoning / result.completionTokens) * 100 : 0
    console.log(`  このモデルは reasoning トークンを消費する（completion の ${ratio.toFixed(0)}%）。`)
    console.log('  プロファイルが undefined だとバッチクランプも割り増しも効かないため、出力上限で切れる。')
  } else {
    console.log('  reasoning トークンの消費は記録されなかった。truncated の原因は別にある可能性が高い。')
  }
}

void main()
