import type { AdminSettings } from '@/types/adminSettings'
import { normalizeSpaces } from '../../textUtils'
import { parseJsonObjectFromLlmContent } from '../../jsonResponse'
import { llmCallWithMeta, isAbortableFailure } from '../../llmCallWithMeta'

/**
 * compress 系ツール（rephrase / trim / core / micro）共通の LLM 呼出ヘルパー。
 *
 * 各ツールは `{"text": "<rewritten subtitle>"}` 形式の応答を期待しているため、
 * このヘルパーで `llmCallWithMeta` を呼び出し → JSON パース → text 抽出 までを 1 箇所に集約する。
 *
 * 戻り値:
 *   - 成功時: { text: 正規化済み文字列, errorMessage: undefined, abortable: false }
 *   - 失敗時: { text: '', errorMessage: 失敗理由, abortable: 早期諦め可否 }
 *
 * 呼出元（tool.execute）は errorMessage を見て TimelinePatch の warning に詰めることで、
 * correctionEngine ループへ「ツール失敗」として伝搬する（throw しない）。
 */
export interface SubtitleLlmCallResult {
  text: string
  errorMessage?: string
  abortable: boolean
}

export interface SubtitleLlmCallOptions {
  model: string
  systemPrompt: string
  userContent: string
  nodeName: string
  temperature?: number
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high'
}

export async function callSubtitleLlm(
  options: SubtitleLlmCallOptions,
  settings: AdminSettings,
): Promise<SubtitleLlmCallResult> {
  const result = await llmCallWithMeta(
    {
      model: options.model,
      systemPrompt: options.systemPrompt,
      userContent: options.userContent,
      temperature: options.temperature,
      reasoningEffort: options.reasoningEffort,
      nodeName: options.nodeName,
      // text:string を JSON で返してもらうので json_object を要求（provider 側で対応）
    },
    settings,
  )

  if (result.errorMessage) {
    return {
      text: '',
      errorMessage: result.errorMessage,
      abortable: isAbortableFailure(result),
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(result.content, options.nodeName)
  } catch (error) {
    return {
      text: '',
      errorMessage: `parse_failed: ${error instanceof Error ? error.message : String(error)}. content=${result.content.slice(0, 200)}`,
      abortable: false,
    }
  }

  const text = typeof parsed.text === 'string' ? parsed.text : ''
  if (!text.trim()) {
    return {
      text: '',
      errorMessage: `empty_text_field. content=${result.content.slice(0, 200)}`,
      abortable: false,
    }
  }

  return {
    text: normalizeSpaces(text.trim()),
    abortable: false,
  }
}
