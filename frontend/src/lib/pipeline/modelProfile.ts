import type { AdminSettings } from '@/types/adminSettings'
import type { ModelProfile, ModelProfilePresetId, SamplingParams } from '@/types/modelProfile'
import { resolveAiProvider } from './aiProvider'

export const MODEL_PROFILE_PRESETS: Record<Exclude<ModelProfilePresetId, 'auto'>, ModelProfile> = {
  gemma: {
    id: 'gemma',
    label: 'Gemma thinking-token compatible',
    contextLength: 128000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'system_token', systemToken: '<|think|>' },
      output: { style: 'tag_delimited', openTag: '<|channel>thought', closeTag: '<channel|>' },
    },
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 64 },
      nonThinking: { temperature: 1.0, topP: 0.95, topK: 64 },
    },
  },
  qwen: {
    id: 'qwen',
    label: 'Qwen thinking compatible',
    contextLength: 262000,
    maxOutputTokens: 32768,
    supportsSystemRole: true,
    reasoning: {
      capability: 'toggleable',
      enable: { method: 'chat_template_kwarg', key: 'enable_thinking', onValue: true, offValue: false },
      output: { style: 'tag_delimited', openTag: '<think>', closeTag: '</think>' },
    },
    sampling: {
      thinking: { temperature: 1.0, topP: 0.95, topK: 20, minP: 0 },
      nonThinking: { temperature: 0.7, topP: 0.8, topK: 20, presencePenalty: 1.5 },
    },
  },
}

export type LlmReasoningMode = 'thinking' | 'nonThinking'

export interface AdaptedChatRequest {
  body: Record<string, unknown>
  messages: Array<{ role: string; content: string }>
  profile?: ModelProfile
  reasoningMode: LlmReasoningMode
  /**
   * max_tokens / max_completion_tokens がコンテキスト長クランプによって削られた場合の詳細。
   * クランプが発生しなかった場合は undefined。デバッグ可視化のために公開する
   * （呼出元はログ・usage 記録等で「なぜ出力が短く切られたか」を判別できる）。
   */
  maxTokensClamp?: MaxTokensClampResult
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeSampling(value: unknown): SamplingParams | undefined {
  if (!isObject(value)) return undefined
  const out: SamplingParams = {}
  if (typeof value.temperature === 'number') out.temperature = value.temperature
  if (typeof value.topP === 'number') out.topP = value.topP
  if (typeof value.topK === 'number') out.topK = value.topK
  if (typeof value.minP === 'number') out.minP = value.minP
  if (typeof value.presencePenalty === 'number') out.presencePenalty = value.presencePenalty
  if (typeof value.repetitionPenalty === 'number') out.repetitionPenalty = value.repetitionPenalty
  return Object.keys(out).length ? out : undefined
}

export function normalizeModelProfile(value: unknown): ModelProfile | undefined {
  if (!isObject(value)) return undefined
  const reasoning = isObject(value.reasoning) ? value.reasoning : undefined
  const enable = reasoning && isObject(reasoning.enable) ? reasoning.enable : undefined
  const output = reasoning && isObject(reasoning.output) ? reasoning.output : undefined
  const sampling = isObject(value.sampling) ? value.sampling : {}
  const capability = reasoning?.capability
  const method = enable?.method
  const style = output?.style
  if (
    typeof value.contextLength !== 'number'
    || typeof value.maxOutputTokens !== 'number'
    || typeof value.supportsSystemRole !== 'boolean'
    || !enable
    || !output
    || (capability !== 'none' && capability !== 'always_on' && capability !== 'toggleable')
    || (method !== 'param' && method !== 'chat_template_kwarg' && method !== 'system_token' && method !== 'none')
    || (style !== 'reasoning_content_field' && style !== 'tag_delimited')
  ) {
    return undefined
  }

  return {
    id: typeof value.id === 'string' && value.id ? value.id : 'custom',
    label: typeof value.label === 'string' && value.label ? value.label : 'Custom model profile',
    contextLength: Math.max(1024, Math.trunc(value.contextLength)),
    maxOutputTokens: Math.max(256, Math.trunc(value.maxOutputTokens)),
    supportsSystemRole: value.supportsSystemRole,
    reasoning: {
      capability,
      enable: {
        method,
        key: typeof enable.key === 'string' ? enable.key : undefined,
        onValue: enable.onValue,
        offValue: enable.offValue,
        systemToken: typeof enable.systemToken === 'string' ? enable.systemToken : undefined,
      },
      output: {
        style,
        openTag: typeof output.openTag === 'string' ? output.openTag : undefined,
        closeTag: typeof output.closeTag === 'string' ? output.closeTag : undefined,
      },
    },
    sampling: {
      thinking: normalizeSampling(sampling.thinking),
      nonThinking: normalizeSampling(sampling.nonThinking),
    },
  }
}

export function resolveModelProfile(
  settings: Pick<AdminSettings,
    | 'translationProvider'
    | 'modelProfilePreset'
    | 'modelProfileJson'
    | 'chatTextProfilePreset'
    | 'chatTextProfileJson'
    | 'chatVisionProfilePreset'
    | 'chatVisionProfileJson'
    | 'embeddingProfilePreset'
    | 'embeddingProfileJson'
  >,
  model: string,
  capability: 'chatText' | 'chatVision' | 'embedding' = 'chatText',
): ModelProfile | undefined {
  const profileJson = capability === 'chatVision'
    ? settings.chatVisionProfileJson
    : capability === 'embedding'
      ? settings.embeddingProfileJson
      : settings.chatTextProfileJson
  const presetId = capability === 'chatVision'
    ? settings.chatVisionProfilePreset
    : capability === 'embedding'
      ? settings.embeddingProfilePreset
      : settings.chatTextProfilePreset
  const customJson = profileJson.trim() || settings.modelProfileJson.trim()
  if (customJson) {
    try {
      const custom = normalizeModelProfile(JSON.parse(customJson))
      if (custom) return custom
    } catch {
      // Invalid custom JSON should not break the pipeline; fall through to preset inference.
    }
  }

  const preset = presetId !== 'auto' ? presetId : settings.modelProfilePreset
  if (preset && preset !== 'auto') return MODEL_PROFILE_PRESETS[preset]

  const normalized = model.toLowerCase()
  if (normalized.includes('gemma')) return MODEL_PROFILE_PRESETS.gemma
  if (normalized.includes('qwen')) return MODEL_PROFILE_PRESETS.qwen
  return undefined
}

/**
 * プロンプト文字数からトークン数を見積もる際の割り算係数（文字数 / この値 = 見積りトークン数）。
 * このアプリの字幕パイプラインは日本語・英語混在テキストを扱う。日本語は概ね 1〜2 文字/トークン、
 * 英語は概ね 4 文字/トークンで、両者が混在する場合の実際のトークン数は文字数だけからは正確に
 * 求まらない。見積りが小さすぎる（＝実トークン数を過小評価する）と後続のクランプが効かず
 * http_400 (context_size_exceeded) を招くため、意図的に小さめの係数（＝見積りが大きめに出る、
 * 安全側の方向）を採用する。
 */
export const CONSERVATIVE_CHARS_PER_TOKEN = 2

/**
 * モデルプロファイルが宣言する contextLength（例: gemma プリセットは 128000）は「モデルが
 * カタログ上サポートする理論上の最大コンテキスト長」であり、実行時に実際に確保されている
 * コンテキスト長ではない。LM Studio では JIT ロード時のコンテキスト長の既定値が 8192 で
 * あることを実機で確認済みで、プロファイル宣言値との乖離が非常に大きい（128000 対 8192、
 * 15倍以上）。この乖離を無視してプロファイルの contextLength をそのままクランプ計算に使うと
 * クランプが事実上機能せず、実際のコンテキスト長を超える max_tokens を送ってしまう
 * （本番実行で prompt + max_tokens がコンテキストを超え、548 件の http_400 を引き起こした
 * 事故の原因）。
 *
 * 本来は実行時に実際のコンテキスト長を取得すべき（aiGateway/lmStudioContextLength.ts の
 * resolveLmStudioLoadedContextLength 参照。LM Studio 拡張 API `/api/v0/models` の
 * loaded_context_length を実測する）。この定数は、その実測が取得できなかった場合
 * （OpenAI / Gemini 等 `/api/v0` を持たない提供元、ネットワーク失敗、モデルが not-loaded 等）の
 * **フォールバック値**としての役割に位置付けが変わった。実測値が渡された場合は
 * adaptChatCompletionRequest の runtimeContextLengthTokens 引数がこの定数より優先される
 * （clampMaxTokensDetailed 参照）。
 *
 * 実測値が使えない場合、プロファイルが宣言する contextLength をそのまま信用せず、実機で確認した
 * この保守的な上限（8192）でキャップしてからクランプ計算に使う。プロファイル側でこれより
 * 小さい contextLength が明示的に宣言されている場合は、より保守的なそちらの値を優先する。
 */
export const CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS = 8192

function estimatePromptTokens(messages: Array<{ role: string; content: string }>): number {
  const chars = messages.reduce((sum, msg) => sum + msg.role.length + msg.content.length, 0)
  return Math.ceil(chars / CONSERVATIVE_CHARS_PER_TOKEN) + messages.length * 4
}

/**
 * max_tokens クランプの詳細結果。デバッグ可視化のために公開する
 * （クランプが効いて requested から削られた事実を呼出元が判別できるようにする）。
 */
export interface MaxTokensClampResult {
  /** 実際に採用する max_tokens */
  value: number
  /** requested からクランプによって値が削られたかどうか */
  wasClamped: boolean
  /** クランプ前に要求されていた値 */
  requested: number
  /** クランプ計算に使ったコンテキスト残量見積り */
  contextBudget: number
}

function clampMaxTokensDetailed(
  requested: unknown,
  profile: ModelProfile,
  messages: Array<{ role: string; content: string }>,
  contextLengthCeilingTokens: number = CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS,
): MaxTokensClampResult {
  const requestedNumber = Math.trunc(typeof requested === 'number' ? requested : profile.maxOutputTokens)
  const promptEstimate = estimatePromptTokens(messages)
  // 安全マージン。プロンプト見積りの誤差・特殊トークン・レスポンステンプレート分の余白として
  // 確保する。実機とプロファイル宣言値の contextLength 乖離を吸収する必要があるため、
  // 旧実装の 256 より大きい 512 を採用する。
  const reserve = 512
  const effectiveContextLength = Math.min(profile.contextLength, contextLengthCeilingTokens)
  const contextBudget = Math.max(256, effectiveContextLength - promptEstimate - reserve)
  const value = Math.max(256, Math.min(requestedNumber, profile.maxOutputTokens, contextBudget))
  return {
    value,
    wasClamped: value < requestedNumber,
    requested: requestedNumber,
    contextBudget,
  }
}

/**
 * runtimeContextLengthTokens（実行時に実測できたコンテキスト長）を、クランプ計算に使う
 * 実際の上限へ正規化する。不正値（非数・非有限・0以下）は無視して
 * CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS にフォールバックする
 * （呼出元がそのまま max_tokens に使う値の計算根拠になるため、0 やマイナスを混入させない）。
 */
function resolveContextLengthCeilingTokens(runtimeContextLengthTokens: number | undefined): number {
  if (typeof runtimeContextLengthTokens === 'number' && Number.isFinite(runtimeContextLengthTokens) && runtimeContextLengthTokens > 0) {
    return Math.trunc(runtimeContextLengthTokens)
  }
  return CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS
}

/**
 * openai / gemini 経路向けに max_tokens / max_completion_tokens を body から取り除く。
 * 新しいオブジェクトを返し、渡された body を破壊的に変更しない。
 *
 * なぜ削除するか（実測に基づく方針。adaptChatCompletionRequest 側のコメントも参照）:
 * 同一入力・同一プロンプトで max_tokens だけを変えて実測したところ、バッチ件数から見積もった
 * 376 のときだけ finishReason=length で本文 0 文字のまま切断され、1200 / 4096 / 送らない の
 * いずれでも消費量は 450 前後で安定して stop まで完走した。上限は消費量に影響せず、成功するか
 * どうかだけを左右していた。上限を「予測」しようとすること自体が破綻の原因だったため、
 * openai / gemini ではフィールドごと送らず、モデル自身に止まらせる。
 */
export function stripTokenLimitFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(body).filter(([key]) => key !== 'max_tokens' && key !== 'max_completion_tokens'),
  )
}

function applySampling(body: Record<string, unknown>, sampling: SamplingParams | undefined): void {
  if (!sampling) return
  if (typeof body.temperature !== 'number' && typeof sampling.temperature === 'number') body.temperature = sampling.temperature
  if (typeof sampling.topP === 'number') body.top_p = sampling.topP
  if (typeof sampling.topK === 'number') body.top_k = sampling.topK
  if (typeof sampling.minP === 'number') body.min_p = sampling.minP
  if (typeof sampling.presencePenalty === 'number') body.presence_penalty = sampling.presencePenalty
  if (typeof sampling.repetitionPenalty === 'number') body.repetition_penalty = sampling.repetitionPenalty
}

function foldSystemMessages(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
  const systemContent = messages.filter(msg => msg.role === 'system').map(msg => msg.content).join('\n\n')
  const nonSystem = messages.filter(msg => msg.role !== 'system')
  if (!systemContent) return messages
  const firstUserIndex = nonSystem.findIndex(msg => msg.role === 'user')
  if (firstUserIndex >= 0) {
    return nonSystem.map((msg, index) => index === firstUserIndex
      ? { ...msg, content: `${systemContent}\n\n${msg.content}` }
      : msg)
  }
  return [{ role: 'user', content: systemContent }, ...nonSystem]
}

function prependSystemToken(messages: Array<{ role: string; content: string }>, token: string): Array<{ role: string; content: string }> {
  const systemIndex = messages.findIndex(msg => msg.role === 'system')
  if (systemIndex >= 0) {
    return messages.map((msg, index) => {
      if (index !== systemIndex || msg.content.trimStart().startsWith(token)) return msg
      return { ...msg, content: `${token}\n${msg.content}` }
    })
  }
  return [{ role: 'system', content: token }, ...messages]
}

function applyReasoningEnable(
  body: Record<string, unknown>,
  messages: Array<{ role: string; content: string }>,
  profile: ModelProfile,
  mode: LlmReasoningMode,
): Array<{ role: string; content: string }> {
  const enable = profile.reasoning.enable
  const shouldThink = profile.reasoning.capability === 'always_on' || mode === 'thinking'
  if (enable.method === 'none') return messages
  if (enable.method === 'param' && enable.key) {
    const value = shouldThink ? enable.onValue : enable.offValue
    if (value !== undefined && body[enable.key] === undefined) body[enable.key] = value
    return messages
  }
  if (enable.method === 'chat_template_kwarg' && enable.key) {
    body.chat_template_kwargs = {
      ...(isObject(body.chat_template_kwargs) ? body.chat_template_kwargs : {}),
      [enable.key]: shouldThink ? enable.onValue : enable.offValue,
    }
    return messages
  }
  if (enable.method === 'system_token' && shouldThink && enable.systemToken) {
    return prependSystemToken(messages, enable.systemToken)
  }
  return messages
}

export function adaptChatCompletionRequest(args: {
  body: Record<string, unknown>
  messages: Array<{ role: string; content: string }>
  settings: Pick<AdminSettings,
    | 'translationProvider'
    | 'modelProfilePreset'
    | 'modelProfileJson'
    | 'chatTextProfilePreset'
    | 'chatTextProfileJson'
    | 'chatVisionProfilePreset'
    | 'chatVisionProfileJson'
    | 'embeddingProfilePreset'
    | 'embeddingProfileJson'
  >
  model: string
  reasoningMode: LlmReasoningMode
  /**
   * 実行時に実測できたコンテキスト長（例: LM Studio /api/v0/models の loaded_context_length。
   * aiGateway/lmStudioContextLength.ts 参照）。指定があればクランプ計算の上限としてこちらを
   * 優先する。未指定・不正値（0以下・非有限）の場合は CONSERVATIVE_CONTEXT_LENGTH_CEILING_TOKENS
   * にフォールバックする。
   */
  runtimeContextLengthTokens?: number
}): AdaptedChatRequest {
  const profile = resolveModelProfile(args.settings, args.model)
  const provider = resolveAiProvider(args.settings)

  // プロファイルが解決できない（プリセット未一致・カスタム未設定）場合でも、トークン上限の
  // 扱いは provider だけで決まる。本番の openai/gemini 呼出はほとんどこの分岐を通る
  // （detectIncompleteEnds.ts / translateEn.ts 等が渡すモデルは通常 gemma/qwen プリセットに
  // 一致しないため）。ここで何もしないと、body に既に入っている max_tokens/max_completion_tokens
  // （chatText.ts の buildChatTextBody がクランプ前に設定済み）がそのまま素通りしてしまう。
  if (!profile) {
    return {
      body: provider === 'local_openai' ? args.body : stripTokenLimitFields(args.body),
      messages: args.messages,
      profile,
      reasoningMode: args.reasoningMode,
    }
  }

  const body = { ...args.body }
  let messages = profile.supportsSystemRole ? args.messages : foldSystemMessages(args.messages)
  messages = applyReasoningEnable(body, messages, profile, args.reasoningMode)
  applySampling(body, args.reasoningMode === 'thinking' ? profile.sampling.thinking : profile.sampling.nonThinking)
  let maxTokensClamp: MaxTokensClampResult | undefined

  /**
   * トークン上限の扱いは provider で分ける（実測に基づく方針）:
   *
   * - local_openai: 解答全体が小さいコンテキスト（LM Studio JIT ロードの既定 8192）を推論と
   *   本文で共有するため、上限が無いと推論だけでコンテキストを食い潰しかねない。上限は被害と
   *   実行時間を抑える装置として必要なため、既存のクランプ処理をそのまま維持する。
   * - openai / gemini: 同一入力・同一プロンプトで max_tokens だけを変えた実測で、バッチ件数から
   *   見積もった 376 のときだけ finishReason=length で本文 0 文字のまま切断され、1200 / 4096 /
   *   送らない のいずれでも消費量は 450 前後で安定して stop まで完走した（詳細は
   *   stripTokenLimitFields の JSDoc 参照）。上限を決めるには「どれだけ推論するか」を事前に
   *   知る必要があり、それ自体が破綻の原因だった。送らなければ知る必要がなくなる。
   *   加えて、truncated 時の半割リトライはバッチ件数から max_tokens を再計算するため、割るほど
   *   予算も一緒に減ってしまい逆効果だった（212 件が一度も救済されなかった原因）。
   */
  if (provider === 'local_openai') {
    const contextLengthCeilingTokens = resolveContextLengthCeilingTokens(args.runtimeContextLengthTokens)
    if (body.max_tokens !== undefined) {
      const clamp = clampMaxTokensDetailed(body.max_tokens, profile, messages, contextLengthCeilingTokens)
      body.max_tokens = clamp.value
      if (clamp.wasClamped) maxTokensClamp = clamp
    }
    if (body.max_completion_tokens !== undefined) {
      const clamp = clampMaxTokensDetailed(body.max_completion_tokens, profile, messages, contextLengthCeilingTokens)
      body.max_completion_tokens = clamp.value
      if (clamp.wasClamped) maxTokensClamp = clamp
    }
    return { body, messages, profile, reasoningMode: args.reasoningMode, maxTokensClamp }
  }

  return { body: stripTokenLimitFields(body), messages, profile, reasoningMode: args.reasoningMode, maxTokensClamp }
}

export function stripDelimitedReasoning(content: string, openTag?: string, closeTag?: string): string {
  if (!content) return content
  let out = content
  if (openTag && closeTag) {
    let start = out.indexOf(openTag)
    while (start >= 0) {
      const end = out.indexOf(closeTag, start + openTag.length)
      if (end < 0) return out.slice(0, start).trim()
      out = `${out.slice(0, start)}${out.slice(end + closeTag.length)}`
      start = out.indexOf(openTag)
    }
    return out.trim()
  }
  if (closeTag) {
    const end = out.lastIndexOf(closeTag)
    if (end >= 0) return out.slice(end + closeTag.length).trim()
  }
  if (openTag) {
    const start = out.indexOf(openTag)
    if (start >= 0) return out.slice(0, start).trim()
  }
  return out.trim()
}

export function normalizeChatCompletionContent(content: string, profile?: ModelProfile): string {
  if (!profile || profile.reasoning.output.style !== 'tag_delimited') return content
  return stripDelimitedReasoning(
    content,
    profile.reasoning.output.openTag,
    profile.reasoning.output.closeTag,
  )
}

/**
 * thinking 系モデルの reasoning トークン消費量の実測値（LM Studio + gemma-4-e4b-it-qat）:
 *   - 翻訳1セグメント: 319
 *   - 辞書候補抽出: 326
 *   - 未完結判定5件: 565
 *   - テキストモード翻訳: 293
 *
 * これらの実測から分かる通り、**reasoning のコストは「本文として欲しい出力サイズ」に比例せず、
 * 300〜600 の範囲でほぼ一定**である。バッチ件数や本文の長さが変わっても reasoning 自体の
 * 消費量はさほど変わらない。
 *
 * 旧実装は desiredOutputTokens に固定係数（6倍）を掛ける乗算方式だったが、これは
 * 「reasoning コストが出力サイズに比例する」という誤った前提に基づいており、両方向に事故を
 * 起こした:
 *   - 小さい desired（例: 8件バッチの未完結判定 ≒ 112）では 6倍しても 672 にしかならず、
 *     実測の reasoning 消費（565）に対してほぼ余裕がない。実行結果では 1056 ブロック中 1014 件
 *     （96%）が判定失敗した。さらに、失敗時に半割してリトライすると desired がさらに小さくなり
 *     見積りもさらに小さくなるため、分割すればするほど悪化する悪循環になっていた。
 *   - 大きい desired（翻訳など）では 6倍が過剰になり、prompt + max_tokens がコンテキスト長を
 *     超えて http_400 (context_size_exceeded) を大量発生させた（実行結果で 548 件）。
 *
 * reasoning コストが出力サイズに比例せずほぼ一定である以上、正しいのは乗算ではなく
 * **固定の reasoning 予算を加算する**方式である。実測 293〜565 に安全率を見て 2048 とする。
 * 同じ設計ミスを繰り返さないよう、乗算方式に戻さないこと。
 *
 * 【2026-08 追記】adaptChatCompletionRequest が openai / gemini 向けには max_tokens /
 * max_completion_tokens を送らなくなったため（stripTokenLimitFields 参照）、この定数が実際に
 * API へ渡る値に反映されるのは local_openai 経路のみになった。openai / gemini でも
 * withReasoningHeadroom は変わらず呼ばれ続けるが、その戻り値は adaptChatCompletionRequest の
 * 手前で破棄される（呼出元 detectIncompleteEnds.ts / translateEn.ts /
 * documentGlossaryGenerator.ts のコードは意図的に変更していない）。定数自体は local_openai の
 * クランプ計算にまだ使うため削除しないこと。
 */
export const REASONING_BUDGET_TOKENS = 2048

/**
 * withReasoningHeadroom の戻り値は呼出元でそのまま max_tokens に入る。
 * 0 はリクエストを破壊する最も危険な値であり「安全側」ではないため、
 * 不正入力時・クランプ後のどちらでもこの値を下回らせない。
 *
 * 【2026-08 追記】REASONING_BUDGET_TOKENS の追記コメントと同様、この下限が実際に API へ渡る
 * 値として意味を持つのは local_openai 経路のみ。openai / gemini では
 * adaptChatCompletionRequest がトークン上限フィールドごと削除するため、この値そのものは
 * リクエストに現れない。
 */
export const MIN_REASONING_HEADROOM_TOKENS = 256

/**
 * 「思考しうるモデルか」の判定基準:
 * capability が 'always_on'（常に思考する）または 'toggleable'（モードにより思考しうる）なら
 * reasoning ヘッドルームの割り増しが必要と判断する。'none' は思考しないため対象外。
 * profile が未解決（プリセット未一致・カスタム未設定）の場合は安全側として割り増ししない
 * （思考しないモデル宛に無駄な max_tokens を積み増さないため）。
 */
function isReasoningCapableProfile(profile?: ModelProfile): boolean {
  if (!profile) return false
  return profile.reasoning.capability === 'always_on' || profile.reasoning.capability === 'toggleable'
}

/**
 * thinking 系モデルは reasoning が固定的にトークンを消費する（REASONING_BUDGET_TOKENS の
 * JSDoc 参照: 出力サイズに比例せず 300〜600 でほぼ一定）。
 * 「本文として欲しいトークン数」に、この固定予算を加算して返す。
 *
 * - 思考しないモデル / profile 未解決 → desiredOutputTokens をそのまま返す
 * - 思考しうるモデル → REASONING_BUDGET_TOKENS を加算し、profile.maxOutputTokens があれば
 *   その値で上限クランプする
 * - 入力が有限な正の数でない場合は MIN_REASONING_HEADROOM_TOKENS を返す（NaN を返さない）。
 *   戻り値はそのまま呼出元で max_tokens に渡されるため、0 はリクエストを破壊する最も
 *   危険な値であり「安全側」ではない。クランプ後の値も同様にこの下限を下回らせない
 *   （profile.maxOutputTokens が極端に小さい設定でも 0 やマイナスにならないようにする）。
 *
 * 【2026-08 追記】この関数自体は provider に関わらず呼ばれ続けるが、戻り値が実際に API へ渡る
 * max_tokens / max_completion_tokens に反映されるのは local_openai 経路のみになった。
 * openai / gemini 経路では adaptChatCompletionRequest がトークン上限フィールドごと body から
 * 削除するため（stripTokenLimitFields 参照）、ここで計算した値は破棄される。呼出元
 * （detectIncompleteEnds.ts 等）のコードは意図的に変更していないため、この関数を呼ぶこと自体は
 * 無駄ではない（local_openai では今まで通り必要）が、openai / gemini では見積り値としての
 * 意味を失っている。
 */
export function withReasoningHeadroom(desiredOutputTokens: number, profile?: ModelProfile): number {
  if (typeof desiredOutputTokens !== 'number' || !Number.isFinite(desiredOutputTokens) || desiredOutputTokens <= 0) {
    return MIN_REASONING_HEADROOM_TOKENS
  }
  if (!isReasoningCapableProfile(profile)) return desiredOutputTokens

  const withHeadroom = desiredOutputTokens + REASONING_BUDGET_TOKENS
  const clamped = typeof profile?.maxOutputTokens === 'number'
    ? Math.min(withHeadroom, profile.maxOutputTokens)
    : withHeadroom
  return Math.max(clamped, MIN_REASONING_HEADROOM_TOKENS)
}
