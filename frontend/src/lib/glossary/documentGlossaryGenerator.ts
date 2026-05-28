/**
 * 自作辞書生成パイプライン
 *
 * 詳細設計は docs/glossary_pipeline_design.md を参照。
 *
 * 本ファイルが担う範囲:
 *   - 処理 0: extractDocumentTheme (講義主題の事前把握)
 *   - 処理 A+B: requestCandidateChunk / requestDetailBatch (PDF テキスト + 画像から候補抽出)
 *   - 処理 C: normalizeEntry / compactSelfMadeEntries 側の正規化・統合
 *   - 処理 B2: requestFormulaMiniReview (必要ページだけ mini で数式・画像文字を追加確認)
 *   - 処理 D: verifyEntryAgainstPdf / applyPromptPolicy (用途別の deterministic policy)
 */

import type {
  SelfMadeGlossaryCategory,
  SelfMadeGlossaryChildSource,
  SelfMadeGlossaryDecisionReason,
  SelfMadeGlossaryDocumentMatch,
  SelfMadeGlossaryEntry,
  SelfMadeGlossaryLlmClaimedSource,
  SelfMadeGlossaryPromptPolicy,
  SelfMadeGlossaryValueSource,
} from '@/context/GlossaryContext'
import { requireAiConnection, requireChatModelForProvider, resolveChatCompletionTokenLimitForProvider, resolveJsonResponseFormatForProvider } from '@/lib/pipeline/aiProvider'
import { parseJsonObjectFromLlmContent } from '@/lib/pipeline/jsonResponse'
import { mapWithConcurrency, normalizeConcurrency } from '@/lib/concurrency'
import { tauriFetch } from '@/lib/tauriFetch'
import type { AdminSettings } from '@/types/adminSettings'

import type { ExtractedPdfDocument, ExtractedPdfPage } from './pdfExtractor'

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

type ChatMessageContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
>

/**
 * 抽出パス。
 * Step 1 では 'all' のみ。複雑なフォールバック分岐は次の Step (C/D 実装時) で見直す。
 */
type GlossaryExtractionPass = 'all' | 'formula_mini'

interface RawGlossaryEvidence {
  page?: unknown
  snippet?: unknown
}

interface RawGlossaryReference {
  page?: unknown
  url?: unknown
  label?: unknown
}

interface RawGlossaryEntry {
  category?: unknown
  llmClaimedSource?: unknown
  ja?: unknown
  jaSource?: unknown
  en?: unknown
  enSource?: unknown
  abbr?: unknown
  formula?: unknown
  latex?: unknown
  displayText?: unknown
  domain?: unknown
  note?: unknown
  desc?: unknown
  confidence?: unknown
  reviewReason?: unknown
  evidence?: unknown
  references?: unknown
}

interface RawGlossaryCandidate {
  text?: unknown
  category?: unknown
  llmClaimedSource?: unknown
  page?: unknown
  snippet?: unknown
  ja?: unknown
  en?: unknown
  formula?: unknown
  displayText?: unknown
}

interface NormalizedGlossaryCandidate {
  text: string
  category: SelfMadeGlossaryCategory
  llmClaimedSource?: SelfMadeGlossaryLlmClaimedSource
  page?: number
  snippet?: string
  ja?: string
  en?: string
  formula?: string
  displayText?: string
}

interface RawFormulaMiniReview {
  candidateId?: unknown
  formula?: unknown
  latex?: unknown
  displayText?: unknown
  confidence?: unknown
  reviewReason?: unknown
  evidence?: unknown
}

interface NormalizedFormulaMiniReview {
  candidateId?: string
  formula?: string
  latex?: string
  displayText?: string
  confidence: number
  reviewReason?: string
  evidence: SelfMadeGlossaryChildSource[]
}

interface DocumentTheme {
  /** 講義/資料の主題 (例: "ニューラルネットワークの最適化と正則化") */
  subject: string
  /** 関連分野 (例: "機械学習、深層学習") */
  domain: string
  /** 主要に扱われる概念のリスト (例: ["勾配降下法", "Adam", "過学習"]) */
  keyConcepts: string[]
  /** プロンプトに埋め込む整形済みテキスト */
  promptContext: string
}

const MAX_CHARS_PER_REQUEST = 12_000
const MAX_LOCAL_CHARS_PER_REQUEST = 7_000
const LOCAL_DETAIL_BATCH_SIZE = 5

const MIN_GLOSSARY_OUTPUT_TOKENS = 256
const MAX_GLOSSARY_OUTPUT_TOKENS = 16384

/** 講義主題把握で読み込む最大ページ数 (タイトル・目次・はじめに想定) */
const THEME_PROBE_MAX_PAGES = 5
const THEME_PROBE_MAX_CHARS_PER_PAGE = 2_000
const THEME_PROBE_MAX_OUTPUT_TOKENS = 512

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function resolveGlossaryMaxOutputTokens(settings: AdminSettings): number {
  return clamp(Math.trunc(settings.glossaryMaxOutputTokens), MIN_GLOSSARY_OUTPUT_TOKENS, MAX_GLOSSARY_OUTPUT_TOKENS)
}

function resolveGlossaryConcurrency(settings: AdminSettings): number {
  if (!settings.pdfExtractionParallel) return 1
  return normalizeConcurrency(settings.apiRequestConcurrency, 1)
}

export type GlossaryGenerationProgressEvent = {
  step: 'chunk_start' | 'api_response' | 'chunk_done' | 'theme_done'
  chunkIndex: number
  chunkCount: number
  pages: number[]
  pass: GlossaryExtractionPass | 'theme'
  message: string
}

export type GlossaryGenerationOptions = {
  onProgress?: (event: GlossaryGenerationProgressEvent) => void
  onEntries?: (entries: SelfMadeGlossaryEntry[]) => void
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asOptionalString(value: unknown): string | undefined {
  const text = asString(value)
  return text || undefined
}

function asConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.5
  return Math.max(0, Math.min(1, value))
}

function asPage(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return undefined
  return value
}

function chunkPages(pages: ExtractedPdfPage[], useVision: boolean, maxChars: number): ExtractedPdfPage[][] {
  if (useVision) return pages.map(page => [page])

  const chunks: ExtractedPdfPage[][] = []
  let current: ExtractedPdfPage[] = []
  let currentChars = 0

  for (const page of pages) {
    const pageChars = page.text.length
    if (current.length > 0 && currentChars + pageChars > maxChars) {
      chunks.push(current)
      current = []
      currentChars = 0
    }
    current.push(page)
    currentChars += pageChars
  }

  if (current.length > 0) chunks.push(current)
  return chunks
}

function formatPagesForPrompt(pages: ExtractedPdfPage[], maxChars: number): string {
  return pages.map(page => [
    `--- page ${page.page} ---`,
    page.text.slice(0, maxChars),
    page.urls.length > 0 ? `URLs: ${page.urls.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

// ============================================================
// 処理 0: 講義主題の事前把握 (extractDocumentTheme)
// ============================================================

function buildThemePrompt(document: ExtractedPdfDocument, probePages: ExtractedPdfPage[]): string {
  return `以下は講義/技術資料の冒頭 (タイトル・目次・はじめになど) です。
この資料の主題と扱われる主要概念を短く把握してください。
後段の用語抽出タスクで「主題に関連する用語のみ抽出する」ためのコンテキストとして使います。

文書名: ${document.source.name}

制約:
- JSON のみを返す
- subject は 1 文 (50 字以内目安)
- domain は分野ラベルをカンマ区切りで 1〜3 個
- keyConcepts はこの資料で扱われる中心的な概念名を 3〜10 個、本文に実在する表記で
- 主観評価・所感は入れない

JSON 形式:
{
  "subject": "",
  "domain": "",
  "keyConcepts": [""]
}

本文:
${formatPagesForPrompt(probePages, THEME_PROBE_MAX_CHARS_PER_PAGE)}`
}

function formatThemeContext(theme: { subject: string; domain: string; keyConcepts: string[] }): string {
  const concepts = theme.keyConcepts.filter(Boolean).join(', ')
  return [
    `この資料の主題: ${theme.subject || '不明'}`,
    `関連分野: ${theme.domain || '不明'}`,
    concepts ? `主要に扱われる概念: ${concepts}` : '',
  ].filter(Boolean).join('\n')
}

export async function extractDocumentTheme(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<DocumentTheme> {
  const probePages = document.pages.slice(0, THEME_PROBE_MAX_PAGES)
  if (probePages.length === 0) {
    return { subject: '', domain: '', keyConcepts: [], promptContext: '' }
  }

  const connection = requireAiConnection(settings, 'glossary document theme extraction')
  const model = requireChatModelForProvider(settings, settings.translationModel, 'glossary document theme extraction')

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...resolveChatCompletionTokenLimitForProvider(settings, THEME_PROBE_MAX_OUTPUT_TOKENS),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You summarize the subject of a lecture/technical PDF in strict JSON. No commentary.',
        },
        {
          role: 'user',
          content: buildThemePrompt(document, probePages),
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Glossary document theme API failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  const json = JSON.parse(text) as ChatCompletionResponse
  const content = json.choices?.[0]?.message?.content
  if (!content) {
    return { subject: '', domain: '', keyConcepts: [], promptContext: '' }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = parseJsonObjectFromLlmContent(content, `Glossary document theme: ${document.source.name}`)
  } catch {
    return { subject: '', domain: '', keyConcepts: [], promptContext: '' }
  }

  const subject = asString(parsed.subject)
  const domain = asString(parsed.domain)
  const keyConcepts = Array.isArray(parsed.keyConcepts)
    ? parsed.keyConcepts.map(asString).filter(Boolean)
    : []

  const theme: DocumentTheme = {
    subject,
    domain,
    keyConcepts,
    promptContext: formatThemeContext({ subject, domain, keyConcepts }),
  }

  onProgress?.({
    step: 'theme_done',
    chunkIndex: 0,
    chunkCount: 1,
    pages: probePages.map(p => p.page),
    pass: 'theme',
    message: `theme: ${subject || '(不明)'} | domain: ${domain || '(不明)'} | concepts: ${keyConcepts.length}`,
  })

  return theme
}

// ============================================================
// 処理 A+B: 候補抽出プロンプト
// ============================================================

const CATEGORY_GUIDE = `分類タグ (category) は以下の 5 つのいずれか:
- "term":         専門用語 (この資料の主題に直結する技術用語)。例: 「最適化アルゴリズム」「過学習」「正則化」
- "proper_noun":  固有名詞 (人名・組織名・データセット名・モデル名・ライブラリ名)。例: MNIST, scikit-learn, LeNet
- "formula":      数式・記号・形状表記。例: 2×2, 6@14×14, ∂L/∂θ, f(x)
- "abbreviation": 略語 (展開先の正式名が存在するもの)。例: ML, CNN, DL
- "reference":    参照・引用元・URL (辞書化対象外、自動的に disabled になる)。例: https://..., Bengio+ 2007`

const EXTRACTION_RULES = `抽出する:
- この資料の主題に直結する技術用語・固有名詞・略語
- 字幕補正で読み間違えやすい数式・記号表記
- 主題で扱われる概念名

抽出しない:
- 一般動詞・形容詞 (「学ぶ」「単純」「複雑」「計算する」)
- 主題と無関係な一般名詞 (「人」「方法」「内容」「結果」)
- 教育用語一般 (「講義」「演習」「目次」「参考文献」)
- 講師名・大学名・組織名は reference として記録
- 単独では意味が分からない指示語 (「これ」「以下」「先程」)

判定に迷ったら:
- 「この語を字幕辞書から削除したら字幕品質が下がるか?」で判断
- 下がらないなら抽出しない`

const ABSOLUTE_RULES = `絶対に守ること:
- 翻訳はしない。PDF に存在しない訳語を補わない
- 推測で値を作らない。PDF に書かれていない情報は空欄にする
- ja は PDF に実在する日本語表記のみ、en は PDF に実在する英語表記のみ
- どちらか一方が PDF に書かれていない場合、そのフィールドは空文字、対応 Source は "missing"
- jaSource / enSource は "document" | "vision" | "llm_inferred" | "missing" のいずれかにする
- llmClaimedSource は監査用メタデータです。本文だけで確認したなら "document_text"、ページ画像で補ったなら "page_image"、不明なら "unknown"
- llmClaimedSource の判定のために候補品質を落とさない。本文と画像の両方を見て、正しい候補を優先する
- JSON のみを返す`

const FORMULA_NOTATION_RULES = `数式・記号 (category="formula") の表記ルール:
- displayText: 人間が見て分かる Unicode + ^/_ 記法
  - 上付きは ^x または ^(...) で表現
    例: θ^(t+1), x^2, e^(-x), x^(i,j)
  - 下付きは _x または _(...) で表現
    例: x_i, a_(i,j), L_train
  - ギリシャ文字・演算子はそのまま Unicode (θ, ∇, η, ε, Σ, ∂, ∈, ≤, ≥, ⋯)
  - 連続演算子・括弧は適切に保つ (= − + ⋅ / ( ) [ ] { })
- latex: 標準 LaTeX 記法 (整形・字幕生成用)
    例: "\\theta^{(t+1)} = \\theta^{(t)} - \\eta \\nabla E(\\theta^{(t)})"
- formula: 検索キー用の ASCII 互換シンプル表記。表現困難なら空欄

絶対禁止:
- PDF テキスト抽出で上付き・下付き・ギリシャ文字が崩れている場合に、その崩れた表記をそのまま displayText/latex に入れる
  (例: PDF テキスト抽出が "θ(t+1)" になっていても、本来 "θ^(t+1)" なら正しく上付きを復元する)
- 元の数式の意味を変える (項を入れ替える、新しい変数を導入する、係数を勝手に変える) ことは禁止`

function buildCandidatePrompt(
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
  themeContext: string,
): string {
  return `以下の PDF 資料から、字幕の書き起こし修正・英訳修正に使う専門用語の「候補名だけ」を抽出してください。

文書名: ${document.source.name}

${themeContext ? `${themeContext}\n` : ''}
${CATEGORY_GUIDE}

${EXTRACTION_RULES}

${ABSOLUTE_RULES}

${FORMULA_NOTATION_RULES}

候補抽出段の追加制約:
- 1 候補は text/category/page/snippet を基本とする
- ja/en/formula/displayText は PDF 上で明確に分かる場合のみ短く入れる
- llmClaimedSource は source 判定を厳密にするためではなく、あとで監査するために記録する
- desc, note, reviewReason, spokenJa, spokenEn, domain, evidence, references はこの段では出さない
- snippet は候補が出ている短い本文断片 (50 字以内)
- 同概念の正式用語と略語が同じ箇所に並ぶ場合は、正式用語側を 1 候補だけ出す
${useVision ? '- 添付ページ画像も同じ抽出対象として確認する。PDF テキストで崩れている数式・添字・上付き・ギリシャ文字・図表中の略語は画像で読める表記を入れる' : ''}

JSON 形式:
{
  "candidates": [
    {
      "text": "",
      "category": "term" | "proper_noun" | "formula" | "abbreviation" | "reference",
      "llmClaimedSource": "document_text" | "page_image" | "unknown",
      "page": 1,
      "snippet": "",
      "ja": "",
      "en": "",
      "formula": "",
      "displayText": ""
    }
  ]
}

本文:
${formatPagesForPrompt(pages, maxChars)}`
}

function buildCandidateUserContent(
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
  themeContext: string,
): ChatMessageContent {
  const prompt = buildCandidatePrompt(document, pages, useVision, maxChars, themeContext)
  if (!useVision) return prompt

  const content: Exclude<ChatMessageContent, string> = [{ type: 'text', text: prompt }]
  for (const page of pages) {
    if (!page.imageDataUrl) continue
    content.push({ type: 'image_url', image_url: { url: page.imageDataUrl, detail: 'high' } })
  }
  return content
}

function buildDetailPrompt(
  document: ExtractedPdfDocument,
  candidates: NormalizedGlossaryCandidate[],
  themeContext: string,
): string {
  return `以下の候補だけを、自作辞書へ保存する詳細 JSON に展開してください。

文書名: ${document.source.name}

${themeContext ? `${themeContext}\n` : ''}
${CATEGORY_GUIDE}

${ABSOLUTE_RULES}

${FORMULA_NOTATION_RULES}

詳細展開段の追加制約:
- 新しい候補を追加しない
- 入力候補にない用語を補完しない
- desc/note/reviewReason/snippet は短くする (50〜100 字)
- ja または en が不明な場合は空文字にし、対応 Source は "missing"
- llmClaimedSource は候補から引き継ぎ、判断できない場合は "unknown"
- 略語と正式名が同じ概念を指す場合、別 entry にせず正式名 entry の abbr に略語を入れる
- 既存 candidate の category を勝手に変えない (明らかな誤分類のときだけ訂正可)

JSON 形式:
{
  "entries": [
    {
      "category": "term" | "proper_noun" | "formula" | "abbreviation" | "reference",
      "llmClaimedSource": "document_text" | "page_image" | "unknown",
      "ja": "",
      "jaSource": "document" | "vision" | "llm_inferred" | "missing",
      "en": "",
      "enSource": "document" | "vision" | "llm_inferred" | "missing",
      "abbr": "",
      "formula": "",
      "latex": "",
      "displayText": "",
      "domain": "",
      "desc": "",
      "note": "",
      "reviewReason": "",
      "evidence": [{ "page": 1, "snippet": "" }],
      "references": [{ "page": 1, "url": "", "label": "" }]
    }
  ]
}

候補:
${JSON.stringify(candidates, null, 2)}`
}

function buildFormulaMiniPrompt(
  document: ExtractedPdfDocument,
  page: ExtractedPdfPage,
  entries: SelfMadeGlossaryEntry[],
  themeContext: string,
): string {
  const candidates = entries
    .filter(entry => entry.category === 'formula' || entry.formula || entry.latex || entry.displayText)
    .map(entry => ({
      candidateId: entry.id,
      category: entry.category,
      formula: entry.formula ?? '',
      latex: entry.latex ?? '',
      displayText: entry.displayText ?? '',
      snippet: entry.children.find(child => child.page === page.page)?.snippet ?? '',
    }))

  return `以下のPDFページ画像とPDF本文を照合し、字幕辞書に入れる数式・記号表記を正確に確認してください。

文書名: ${document.source.name}
ページ: ${page.page}

${themeContext ? `${themeContext}\n` : ''}
${FORMULA_NOTATION_RULES}

目的:
- nano候補で壊れやすい添字・上付き・ギリシャ文字・分数・max/exp/log等の式を、画像を見て正しい canonical 表記へ直す
- PDF text layer の崩れた表記ではなく、ページ画像上の見た目と意味に合う displayText / latex を返す
- 既存候補が間違っている場合は candidateId を付けたまま修正値を返す
- 画像上に明確な重要数式があり、既存候補に無い場合だけ candidateId を空にして追加する

禁止:
- 新しい専門用語の翻訳を作らない
- 数式でない通常語を formula として返さない
- \\text{...} だけの LaTeX を formula として返さない
- 値が読めない場合は無理に補完しない

JSON 形式:
{
  "formulas": [
    {
      "candidateId": "",
      "formula": "",
      "latex": "",
      "displayText": "",
      "confidence": 0.0,
      "reviewReason": "",
      "evidence": [{ "page": ${page.page}, "snippet": "" }]
    }
  ]
}

既存候補:
${JSON.stringify(candidates, null, 2)}

PDF本文:
${formatPagesForPrompt([page], MAX_LOCAL_CHARS_PER_REQUEST)}`
}

function buildFormulaMiniUserContent(
  document: ExtractedPdfDocument,
  page: ExtractedPdfPage,
  entries: SelfMadeGlossaryEntry[],
  themeContext: string,
): ChatMessageContent {
  const prompt = buildFormulaMiniPrompt(document, page, entries, themeContext)
  const content: Exclude<ChatMessageContent, string> = [{ type: 'text', text: prompt }]
  if (page.imageDataUrl) content.push({ type: 'image_url', image_url: { url: page.imageDataUrl, detail: 'high' } })
  return content
}

function batchCandidates(candidates: NormalizedGlossaryCandidate[], batchSize: number): NormalizedGlossaryCandidate[][] {
  const batches: NormalizedGlossaryCandidate[][] = []
  for (let i = 0; i < candidates.length; i += batchSize) {
    batches.push(candidates.slice(i, i + batchSize))
  }
  return batches
}

function rawEntries(parsed: Record<string, unknown>): RawGlossaryEntry[] {
  return Array.isArray(parsed.entries)
    ? parsed.entries.filter((entry): entry is RawGlossaryEntry => Boolean(entry) && typeof entry === 'object')
    : []
}

function rawCandidates(parsed: Record<string, unknown>): RawGlossaryCandidate[] {
  return Array.isArray(parsed.candidates)
    ? parsed.candidates.filter((candidate): candidate is RawGlossaryCandidate => Boolean(candidate) && typeof candidate === 'object')
    : []
}

function rawFormulaMiniReviews(parsed: Record<string, unknown>): RawFormulaMiniReview[] {
  return Array.isArray(parsed.formulas)
    ? parsed.formulas.filter((candidate): candidate is RawFormulaMiniReview => Boolean(candidate) && typeof candidate === 'object')
    : []
}

function formatUsage(json: ChatCompletionResponse): string {
  const usage = json.usage
  if (!usage) return ''
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const total = typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined
  if (prompt === undefined && completion === undefined && total === undefined) return ''
  return `, tokens=${prompt ?? '?'} in/${completion ?? '?'} out/${total ?? '?'} total`
}

function normalizeCategory(value: unknown): SelfMadeGlossaryCategory {
  if (
    value === 'term'
    || value === 'proper_noun'
    || value === 'formula'
    || value === 'abbreviation'
    || value === 'reference'
  ) {
    return value
  }
  return 'term'
}

function normalizeLlmClaimedSource(value: unknown): SelfMadeGlossaryLlmClaimedSource | undefined {
  if (value === 'document_text' || value === 'page_image' || value === 'unknown') return value
  return undefined
}

function looksLikeTextOnlyLatex(value: string | undefined): boolean {
  return /^\\text\{[^}]+\}$/.test((value ?? '').trim())
}

function hasFormulaSignal(value: string | undefined): boolean {
  return /[=+\-*/^_∂∇Σ∑Π∏√≤≥∞≈≠±×÷𝛼𝛽𝛾𝛿𝜃𝜂𝜀]|\b(exp|log|max|min|softmax|relu)\b/i.test(value ?? '')
}

function normalizeCandidate(raw: RawGlossaryCandidate): NormalizedGlossaryCandidate | null {
  const text = asString(raw.text)
  const ja = asOptionalString(raw.ja)
  const en = asOptionalString(raw.en)
  const formula = asOptionalString(raw.formula)
  const displayText = asOptionalString(raw.displayText)
  const fallbackText = text || ja || en || formula || displayText || ''
  if (!fallbackText) return null

  return {
    text: fallbackText,
    category: normalizeCategory(raw.category),
    llmClaimedSource: normalizeLlmClaimedSource(raw.llmClaimedSource),
    page: asPage(raw.page),
    snippet: asOptionalString(raw.snippet),
    ja,
    en,
    formula,
    displayText,
  }
}

function normalizeFormulaMiniReview(raw: RawFormulaMiniReview): NormalizedFormulaMiniReview | null {
  const formula = asOptionalString(raw.formula)
  const latex = asOptionalString(raw.latex)
  const displayText = asOptionalString(raw.displayText)
  if (!formula && !latex && !displayText) return null
  if (looksLikeTextOnlyLatex(latex) && !hasFormulaSignal(formula) && !hasFormulaSignal(displayText)) return null
  const evidence: SelfMadeGlossaryChildSource[] = []
  if (Array.isArray(raw.evidence)) {
    for (const item of raw.evidence as RawGlossaryEvidence[]) {
      const page = asPage(item.page)
      const snippet = asOptionalString(item.snippet)
      if (page || snippet) evidence.push({ type: 'page', page, snippet })
    }
  }
  return {
    candidateId: asOptionalString(raw.candidateId),
    formula,
    latex,
    displayText,
    confidence: asConfidence(raw.confidence),
    reviewReason: asOptionalString(raw.reviewReason),
    evidence,
  }
}

function dedupeCandidates(candidates: NormalizedGlossaryCandidate[]): NormalizedGlossaryCandidate[] {
  const seen = new Set<string>()
  const deduped: NormalizedGlossaryCandidate[] = []
  for (const candidate of candidates) {
    const key = [
      candidate.category,
      candidate.text.toLowerCase(),
      candidate.ja?.toLowerCase() ?? '',
      candidate.en?.toLowerCase() ?? '',
      candidate.formula ?? '',
      candidate.page ?? '',
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
  }
  return deduped
}

function normalizeValueSource(value: unknown, text: string): SelfMadeGlossaryValueSource {
  if (
    value === 'document'
    || value === 'vision'
    || value === 'llm_inferred'
    || value === 'llm_translation'
    || value === 'manual'
  ) {
    return value
  }
  return text.trim() ? 'llm_inferred' : 'missing'
}

function looksLikeUrlOrDomain(value: string): boolean {
  const text = value.trim().toLowerCase()
  return /^https?:\/\//.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/.test(text)
}

function looksLikeNoiseValue(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  if (/^(p\.?\s*)?\d+$|^第?\d+回$|^chapter\s*\d+$/i.test(text)) return true
  if (/^(copyright|all rights reserved|参考文献|references?|目次|講義|演習)$/i.test(text)) return true
  if (text.length <= 1 && !/[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/.test(text)) return true
  return false
}

function applyDeterministicClassification(
  category: SelfMadeGlossaryCategory,
  ja: string,
  en: string,
  formula: string,
  displayText: string,
): {
  category: SelfMadeGlossaryCategory
  formalEligible: boolean
  assistiveEligible: boolean
  disabled: boolean
  reviewReason?: string
} {
  const values = [ja, en, formula, displayText].filter(Boolean)

  // URL/ドメインらしき値は reference に強制
  if (values.some(looksLikeUrlOrDomain)) {
    return {
      category: 'reference',
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: 'URL または引用元ドメインのため正式辞書・補正利用から除外',
    }
  }

  if (values.some(looksLikeNoiseValue)) {
    return {
      category: 'reference',
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: 'ページ番号・章番号・参照見出し等のノイズ候補のため除外',
    }
  }

  switch (category) {
    case 'reference':
      return {
        category,
        formalEligible: false,
        assistiveEligible: false,
        disabled: true,
        reviewReason: '参照情報のため正式辞書・補正利用から除外',
      }
    case 'formula':
      return {
        category,
        formalEligible: false,
        assistiveEligible: true,
        disabled: false,
      }
    case 'abbreviation':
    case 'proper_noun':
    case 'term':
    default:
      return {
        category,
        formalEligible: true,
        assistiveEligible: true,
        disabled: false,
      }
  }
}

function buildDecisionReason(code: string, severity: SelfMadeGlossaryDecisionReason['severity'], message: string): SelfMadeGlossaryDecisionReason {
  return { code, severity, message }
}

function applyPromptPolicy(entry: SelfMadeGlossaryEntry, extraReasons: SelfMadeGlossaryDecisionReason[] = []): SelfMadeGlossaryEntry {
  const reasons: SelfMadeGlossaryDecisionReason[] = [...(entry.verificationReasons ?? []), ...extraReasons]
  const reasonCodes = new Set(reasons.map(reason => reason.code))
  const hasTermValue = Boolean(entry.ja || entry.en || entry.abbr || entry.formula || entry.displayText)
  const hasPair = Boolean(entry.ja && entry.en)
  const disabled = entry.disabled || entry.category === 'reference' || reasonCodes.has('dangerous_noise')
  const correctionEligible = !disabled && hasTermValue
  const translationEligible = !disabled && hasPair && entry.category !== 'formula'
  const formalEligible = !disabled && hasPair && entry.category !== 'formula' && entry.documentMatch?.ja !== false && entry.documentMatch?.en !== false
  const policyReasons = [
    disabled ? 'disabled_or_reference' : undefined,
    !hasPair ? 'missing_ja_en_pair' : undefined,
    entry.category === 'formula' ? 'formula_assistive_only' : undefined,
    entry.documentMatch?.ja === false || entry.documentMatch?.en === false ? 'document_match_warning' : undefined,
  ].filter((reason): reason is string => Boolean(reason))
  const promptPolicy: SelfMadeGlossaryPromptPolicy = {
    correction: correctionEligible ? 'include_canonical' : 'exclude',
    translation: translationEligible ? 'include_canonical' : 'exclude',
    formalExport: formalEligible ? 'include' : 'exclude',
    reasons: policyReasons.length > 0 ? policyReasons : ['ready'],
  }

  return {
    ...entry,
    disabled,
    correctionEligible,
    translationEligible,
    formalEligible,
    assistiveEligible: correctionEligible || translationEligible,
    promptPolicy,
    verificationReasons: reasons.length > 0 ? reasons : undefined,
  }
}

function normalizeChildren(raw: RawGlossaryEntry, pagesByNumber: Map<number, ExtractedPdfPage>): SelfMadeGlossaryChildSource[] {
  const children: SelfMadeGlossaryChildSource[] = []
  const evidence = Array.isArray(raw.evidence) ? raw.evidence as RawGlossaryEvidence[] : []
  for (const item of evidence) {
    const page = asPage(item.page)
    const snippet = asOptionalString(item.snippet)
    if (page || snippet) children.push({ type: 'page', page, snippet })
  }

  const references = Array.isArray(raw.references) ? raw.references as RawGlossaryReference[] : []
  for (const ref of references) {
    const page = asPage(ref.page)
    const url = asOptionalString(ref.url)
    if (url) children.push({ type: 'document_url', page, url, label: asOptionalString(ref.label) })
  }

  for (const child of [...children]) {
    if (!child.page) continue
    const page = pagesByNumber.get(child.page)
    if (!page) continue
    for (const url of page.urls) {
      if (!children.some(existing => existing.type === 'document_url' && existing.url === url)) {
        children.push({ type: 'document_url', page: child.page, url })
      }
    }
  }

  return children
}

function normalizeEntry(raw: RawGlossaryEntry, document: ExtractedPdfDocument, pagesByNumber: Map<number, ExtractedPdfPage>): SelfMadeGlossaryEntry | null {
  const now = new Date().toISOString()
  let initialCategory = normalizeCategory(raw.category)
  const ja = asString(raw.ja)
  const en = asString(raw.en)
  const formula = asString(raw.formula)
  const latex = asOptionalString(raw.latex)
  const displayText = asString(raw.displayText)
  const abbr = asOptionalString(raw.abbr)

  if (!ja && !en && !abbr && !formula && !displayText) return null
  const textOnlyLatexFormula = initialCategory === 'formula'
    && looksLikeTextOnlyLatex(latex)
    && !hasFormulaSignal(formula)
    && !hasFormulaSignal(displayText)
  if (textOnlyLatexFormula) initialCategory = ja || en ? 'term' : 'reference'

  const classification = applyDeterministicClassification(initialCategory, ja, en, formula, displayText)

  const entry: SelfMadeGlossaryEntry = {
    id: crypto.randomUUID(),
    category: classification.category,
    origin: 'document_generated',
    ja,
    en,
    jaSource: normalizeValueSource(raw.jaSource, ja),
    enSource: normalizeValueSource(raw.enSource, en),
    abbr,
    formula: formula || undefined,
    latex,
    displayText: displayText || undefined,
    llmClaimedSource: normalizeLlmClaimedSource(raw.llmClaimedSource),
    canonicalFormula: formula || latex || displayText
      ? {
          formula: formula || undefined,
          latex,
          displayText: displayText || undefined,
          sourcePass: 'candidate_nano',
          selectedReason: 'initial_candidate',
        }
      : undefined,
    formulaConsistency: classification.category === 'formula' ? 'nano_only' : undefined,
    domain: asOptionalString(raw.domain),
    note: asOptionalString(raw.note),
    desc: asOptionalString(raw.desc),
    confidence: asConfidence(raw.confidence),
    formalEligible: classification.formalEligible,
    assistiveEligible: classification.assistiveEligible,
    provisional: true,
    disabled: classification.disabled,
    reviewReason: classification.reviewReason
      ?? (textOnlyLatexFormula ? '\\text{...} のみのLaTeXをformula扱いしないため降格' : asOptionalString(raw.reviewReason)),
    jaConfirmed: false,
    enConfirmed: false,
    promoted: false,
    source: document.source,
    children: normalizeChildren(raw, pagesByNumber),
    createdAt: now,
    updatedAt: now,
  }

  return applyPromptPolicy(entry)
}

function rawEntryFromCandidate(candidate: NormalizedGlossaryCandidate): RawGlossaryEntry {
  const text = candidate.text
  return {
    category: candidate.category,
    llmClaimedSource: candidate.llmClaimedSource ?? 'unknown',
    ja: candidate.ja ?? '',
    jaSource: candidate.ja ? 'document' : 'missing',
    en: candidate.en ?? '',
    enSource: candidate.en ? 'document' : 'missing',
    formula: candidate.formula ?? (candidate.category === 'formula' ? text : ''),
    displayText: candidate.displayText ?? text,
    desc: '',
    note: '',
    reviewReason: '',
    evidence: [{ page: candidate.page, snippet: candidate.snippet ?? text }],
    references: [],
  }
}

// ============================================================
// 処理 D: 用途別 policy 生成 + document text 照合 (ルールベース)
//
// LLM の source 申告は監査メタデータとして保存し、品質判定には使いすぎない。
// PDF text layer に見つからない値も削除せず、documentMatch=false として
// reviewRequired 相当の理由を残し、prompt への利用可否は用途別 policy で決める。
//
// 検証ポリシー (jaSource/enSource ごと):
//   - document       : 完全一致または部分一致を要求。落ちたら missing 降格
//   - vision         : スキップ (画像でしか見えない可能性のため信用)
//   - llm_inferred   : スキップ (元から推測扱い)
//   - llm_translation: スキップ (Step E で別途生成される値)
//   - manual         : スキップ (ユーザー入力)
//   - missing        : 検証対象なし
// ============================================================

interface PdfHaystack {
  /** ページ結合済み生テキスト (デバッグ・ログ用) */
  raw: string
  /** NFKC、小文字化、空白圧縮した照合用テキスト */
  normalized: string
}

function buildPdfHaystack(document: ExtractedPdfDocument): PdfHaystack {
  const raw = document.pages.map(page => page.text).join('\n')
  const normalized = raw.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
  return { raw, normalized }
}

function normalizeNeedle(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function pdfContains(haystack: PdfHaystack, needle: string): boolean {
  const normalized = normalizeNeedle(needle)
  if (!normalized) return true
  return haystack.normalized.includes(normalized)
}

function shouldVerifySource(source: SelfMadeGlossaryValueSource): boolean {
  return source === 'document'
}

interface VerifiedValue {
  source: SelfMadeGlossaryValueSource
  documentMatch?: boolean
  changedSource: boolean
}

function verifyValue(value: string, source: SelfMadeGlossaryValueSource, haystack: PdfHaystack): VerifiedValue {
  if (!value) return { source, changedSource: false }
  const documentMatch = pdfContains(haystack, value)
  if (!shouldVerifySource(source)) return { source, documentMatch, changedSource: false }
  if (documentMatch) return { source, documentMatch, changedSource: false }
  return { source: 'llm_inferred', documentMatch, changedSource: true }
}

export interface GlossaryVerificationChange {
  id: string
  reasons: string[]
}

export interface GlossaryVerificationResult {
  entries: SelfMadeGlossaryEntry[]
  totalEntries: number
  totalChecked: number
  totalDocumentClaims: number
  totalRejected: number
  changes: GlossaryVerificationChange[]
}

export function verifyEntryAgainstPdf(entry: SelfMadeGlossaryEntry, haystack: PdfHaystack): {
  entry: SelfMadeGlossaryEntry
  changed: boolean
  reasons: string[]
  rejectedClaims: number
} {
  const reasons: string[] = []
  const decisionReasons: SelfMadeGlossaryDecisionReason[] = []
  let rejectedClaims = 0

  const ja = verifyValue(entry.ja, entry.jaSource, haystack)
  if (ja.changedSource) {
    reasons.push(`ja "${entry.ja}" not found in PDF text layer; source demoted document → llm_inferred`)
    decisionReasons.push(buildDecisionReason('ja_document_match_failed', 'warning', 'ja が PDF text layer に見つからないため要確認'))
    rejectedClaims += 1
  }

  const en = verifyValue(entry.en, entry.enSource, haystack)
  if (en.changedSource) {
    reasons.push(`en "${entry.en}" not found in PDF text layer; source demoted document → llm_inferred`)
    decisionReasons.push(buildDecisionReason('en_document_match_failed', 'warning', 'en が PDF text layer に見つからないため要確認'))
    rejectedClaims += 1
  }

  const documentMatch: SelfMadeGlossaryDocumentMatch = {
    ja: entry.ja ? ja.documentMatch : undefined,
    en: entry.en ? en.documentMatch : undefined,
    formula: entry.formula ? pdfContains(haystack, entry.formula) : undefined,
    displayText: entry.displayText ? pdfContains(haystack, entry.displayText) : undefined,
  }

  const existingReason = entry.reviewReason?.trim()
  const newReason = `ハルシネーション検証: ${reasons.join(' / ')}`
  const verifiedEntry = applyPromptPolicy({
    ...entry,
    jaSource: ja.source,
    enSource: en.source,
    documentMatch,
    reviewReason: reasons.length > 0 ? (existingReason ? `${existingReason} | ${newReason}` : newReason) : entry.reviewReason,
    updatedAt: new Date().toISOString(),
  }, decisionReasons)

  return {
    entry: verifiedEntry,
    changed: reasons.length > 0 || JSON.stringify(entry.documentMatch) !== JSON.stringify(documentMatch),
    reasons,
    rejectedClaims,
  }
}

function verifyEntriesWithHaystack(entries: SelfMadeGlossaryEntry[], haystack: PdfHaystack): GlossaryVerificationResult {
  const result: SelfMadeGlossaryEntry[] = []
  const changes: GlossaryVerificationChange[] = []
  let totalChecked = 0
  let totalDocumentClaims = 0
  let totalRejected = 0

  for (const entry of entries) {
    const hasDocumentClaim = shouldVerifySource(entry.jaSource) || shouldVerifySource(entry.enSource)
    if (hasDocumentClaim) {
      totalChecked += 1
      if (shouldVerifySource(entry.jaSource) && entry.ja) totalDocumentClaims += 1
      if (shouldVerifySource(entry.enSource) && entry.en) totalDocumentClaims += 1
    }

    const verification = verifyEntryAgainstPdf(entry, haystack)
    if (verification.changed) {
      changes.push({ id: entry.id, reasons: verification.reasons })
      totalRejected += verification.rejectedClaims
      result.push(verification.entry)
    } else {
      result.push(entry)
    }
  }

  return {
    entries: result,
    totalEntries: entries.length,
    totalChecked,
    totalDocumentClaims,
    totalRejected,
    changes,
  }
}

/**
 * 既存生成済み辞書を後付けで検証する公開 API。
 * (パイプライン内部はバッチごとに verifyEntriesWithHaystack を呼ぶ)
 */
export function verifyEntriesAgainstPdf(entries: SelfMadeGlossaryEntry[], document: ExtractedPdfDocument): GlossaryVerificationResult {
  return verifyEntriesWithHaystack(entries, buildPdfHaystack(document))
}

// ============================================================
// 処理 B2: mini による数式・画像文字の追加確認
// ============================================================

const MATH_RISK_PATTERN = /[∂∇Σ∑Π∏√≤≥≦≧∞≈≠±×÷→←↔𝛼𝛽𝛾𝛿𝜃𝜂𝜀𝑎𝑏𝑐𝑑𝑒𝑓𝑔𝑣𝑤𝑥𝑦𝑧𝒩]|\\(frac|sum|prod|nabla|partial|theta|alpha|beta|gamma|eta|epsilon)|\b(exp|log|max|min|softmax|relu|uniform|normal|gaussian|nadam|amsgrad)\b/i

function pageHasFormulaRisk(page: ExtractedPdfPage): boolean {
  return MATH_RISK_PATTERN.test(page.text)
}

function shouldRunFormulaMiniReview(page: ExtractedPdfPage, entries: SelfMadeGlossaryEntry[]): boolean {
  if (!page.imageDataUrl) return false
  if (entries.some(entry => entry.category === 'formula' || entry.formula || entry.latex || entry.displayText)) return true
  return pageHasFormulaRisk(page)
}

function resolveFormulaMiniModel(settings: AdminSettings): string {
  return settings.pdfFormulaMiniModel || settings.pdfExtractionVisionModel || settings.translationModel
}

function formulaKey(value: string | undefined): string {
  return (value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')
}

function formulaReviewDiffers(entry: SelfMadeGlossaryEntry, review: NormalizedFormulaMiniReview): boolean {
  return formulaKey(entry.formula) !== formulaKey(review.formula)
    || formulaKey(entry.latex) !== formulaKey(review.latex)
    || formulaKey(entry.displayText) !== formulaKey(review.displayText)
}

function applyFormulaMiniReviewToEntry(entry: SelfMadeGlossaryEntry, review: NormalizedFormulaMiniReview): SelfMadeGlossaryEntry {
  const differs = formulaReviewDiffers(entry, review)
  const previousCanonical = entry.canonicalFormula ?? (
    entry.formula || entry.latex || entry.displayText
      ? {
          formula: entry.formula,
          latex: entry.latex,
          displayText: entry.displayText,
          sourcePass: 'candidate_nano' as const,
          selectedReason: 'pre_formula_mini',
        }
      : undefined
  )
  const alternativeFormulaCandidates = [
    ...(entry.alternativeFormulaCandidates ?? []),
    ...(previousCanonical && differs
      ? [{
          ...previousCanonical,
          sourcePass: previousCanonical.sourcePass ?? 'candidate_nano',
        }]
      : []),
  ]
  const reviewReason = review.reviewReason
    ? `${entry.reviewReason ? `${entry.reviewReason} | ` : ''}mini数式確認: ${review.reviewReason}`
    : entry.reviewReason

  return applyPromptPolicy({
    ...entry,
    category: 'formula',
    formula: review.formula ?? entry.formula,
    latex: review.latex ?? entry.latex,
    displayText: review.displayText ?? entry.displayText,
    confidence: Math.max(entry.confidence, review.confidence),
    llmClaimedSource: 'page_image',
    canonicalFormula: {
      formula: review.formula ?? entry.formula,
      latex: review.latex ?? entry.latex,
      displayText: review.displayText ?? entry.displayText,
      sourcePass: 'formula_mini',
      selectedReason: differs ? 'formula_mini_overrode_nano' : 'formula_mini_confirmed',
    },
    alternativeFormulaCandidates,
    formulaMiniChecked: true,
    formulaConsistency: differs ? 'formula_mini_overrode_nano' : 'formula_agree',
    reviewReason,
    children: [...entry.children, ...review.evidence],
    updatedAt: new Date().toISOString(),
  })
}

function createFormulaEntryFromMiniReview(
  review: NormalizedFormulaMiniReview,
  document: ExtractedPdfDocument,
  page: ExtractedPdfPage,
): SelfMadeGlossaryEntry {
  const now = new Date().toISOString()
  return applyPromptPolicy({
    id: crypto.randomUUID(),
    category: 'formula',
    origin: 'document_generated',
    ja: '',
    en: '',
    jaSource: 'missing',
    enSource: 'missing',
    formula: review.formula,
    latex: review.latex,
    displayText: review.displayText,
    llmClaimedSource: 'page_image',
    canonicalFormula: {
      formula: review.formula,
      latex: review.latex,
      displayText: review.displayText,
      sourcePass: 'formula_mini',
      selectedReason: 'formula_mini_added',
    },
    formulaMiniChecked: true,
    formulaConsistency: 'mini_only',
    confidence: review.confidence,
    formalEligible: false,
    assistiveEligible: true,
    provisional: true,
    disabled: false,
    reviewReason: review.reviewReason ? `mini数式確認: ${review.reviewReason}` : undefined,
    jaConfirmed: false,
    enConfirmed: false,
    promoted: false,
    source: document.source,
    children: review.evidence.length > 0 ? review.evidence : [{ type: 'page', page: page.page }],
    createdAt: now,
    updatedAt: now,
  })
}

async function requestFormulaMiniReview(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  page: ExtractedPdfPage,
  entries: SelfMadeGlossaryEntry[],
  themeContext: string,
  chunkIndex: number,
  chunkCount: number,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<NormalizedFormulaMiniReview[]> {
  const connection = requireAiConnection(settings, 'self-made glossary formula mini review')
  const model = requireChatModelForProvider(settings, resolveFormulaMiniModel(settings), 'self-made glossary formula mini review')
  const pass: GlossaryExtractionPass = 'formula_mini'
  onProgress?.({
    step: 'chunk_start',
    chunkIndex,
    chunkCount,
    pages: [page.page],
    pass,
    message: `${pass}: page ${page.page} mini review started (${entries.length} entries)`,
  })

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...resolveChatCompletionTokenLimitForProvider(settings, resolveGlossaryMaxOutputTokens(settings)),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You verify formulas and image-visible mathematical notation from a PDF page image. Return strict JSON only.',
        },
        {
          role: 'user',
          content: buildFormulaMiniUserContent(document, page, entries, themeContext),
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Glossary formula mini review API failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  let json: ChatCompletionResponse
  try {
    json = JSON.parse(text) as ChatCompletionResponse
  } catch (err) {
    throw new Error(`Glossary formula mini review response JSON parse failed at page ${page.page}: ${err instanceof Error ? err.message : String(err)} / body=${text.slice(0, 500)}`)
  }

  const choice = json.choices?.[0]
  const finishReason = choice?.finish_reason ?? 'unknown'
  const content = choice?.message?.content
  onProgress?.({
    step: 'api_response',
    chunkIndex,
    chunkCount,
    pages: [page.page],
    pass,
    message: `${pass}: page ${page.page} finish_reason=${finishReason}, content_chars=${content?.length ?? 0}${formatUsage(json)}`,
  })
  if (finishReason === 'length') {
    const err = new Error(`Glossary formula mini review stopped by length limit at page ${page.page}.`)
    ;(err as Error & { glossaryFinishReason?: string }).glossaryFinishReason = finishReason
    throw err
  }
  if (!content) throw new Error('Glossary formula mini review response did not include message content')

  const reviews = rawFormulaMiniReviews(parseJsonObjectFromLlmContent(content, `Glossary formula mini review page ${page.page}`))
    .map(normalizeFormulaMiniReview)
    .filter((review): review is NormalizedFormulaMiniReview => Boolean(review))
  onProgress?.({
    step: 'chunk_done',
    chunkIndex,
    chunkCount,
    pages: [page.page],
    pass,
    message: `${pass}: page ${page.page} ${reviews.length} formula reviews`,
  })
  return reviews
}

async function applyFormulaMiniReviewIfNeeded(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  page: ExtractedPdfPage,
  entries: SelfMadeGlossaryEntry[],
  themeContext: string,
  chunkIndex: number,
  chunkCount: number,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<SelfMadeGlossaryEntry[]> {
  if (!settings.pdfExtractionUseVision || !shouldRunFormulaMiniReview(page, entries)) return entries
  try {
    const reviews = await requestFormulaMiniReview(settings, document, page, entries, themeContext, chunkIndex, chunkCount, onProgress)
    if (reviews.length === 0) return entries
    const result = [...entries]
    const indexById = new Map(result.map((entry, index) => [entry.id, index]))
    for (const review of reviews) {
      const idx = review.candidateId ? indexById.get(review.candidateId) : undefined
      if (idx !== undefined) {
        result[idx] = applyFormulaMiniReviewToEntry(result[idx], review)
      } else {
        result.push(createFormulaEntryFromMiniReview(review, document, page))
      }
    }
    return result
  } catch (error) {
    onProgress?.({
      step: 'chunk_done',
      chunkIndex,
      chunkCount,
      pages: [page.page],
      pass: 'formula_mini',
      message: `formula_mini: page ${page.page} skipped after failure (${error instanceof Error ? error.message : String(error)})`,
    })
    return entries
  }
}

// ============================================================
// LLM 呼び出し
// ============================================================

async function requestCandidateChunk(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
  themeContext: string,
  chunkIndex: number,
  chunkCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<NormalizedGlossaryCandidate[]> {
  const connection = requireAiConnection(settings, 'self-made glossary candidate extraction')
  const requestedModel = useVision ? settings.pdfExtractionVisionModel : settings.translationModel
  const model = requireChatModelForProvider(settings, requestedModel, 'self-made glossary candidate extraction')
  const pageNumbers = pages.map(page => page.page)
  onProgress?.({
    step: 'chunk_start',
    chunkIndex,
    chunkCount,
    pages: pageNumbers,
    pass,
    message: `${pass} candidate chunk ${chunkIndex + 1}/${chunkCount}: pages ${pageNumbers.join(', ')}`,
  })

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...resolveChatCompletionTokenLimitForProvider(settings, resolveGlossaryMaxOutputTokens(settings)),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You extract glossary candidates strictly from given PDF text/images. Never translate or invent values. Return strict JSON only.',
        },
        {
          role: 'user',
          content: buildCandidateUserContent(document, pages, useVision, maxChars, themeContext),
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Glossary candidate extraction API failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  let json: ChatCompletionResponse
  try {
    json = JSON.parse(text) as ChatCompletionResponse
  } catch (err) {
    throw new Error(`Glossary candidate response JSON parse failed at pages ${pageNumbers.join(', ')}: ${err instanceof Error ? err.message : String(err)} / body=${text.slice(0, 500)}`)
  }

  const choice = json.choices?.[0]
  const finishReason = choice?.finish_reason ?? 'unknown'
  const content = choice?.message?.content
  onProgress?.({
    step: 'api_response',
    chunkIndex,
    chunkCount,
    pages: pageNumbers,
    pass,
    message: `${pass} candidate chunk ${chunkIndex + 1}/${chunkCount}: finish_reason=${finishReason}, content_chars=${content?.length ?? 0}${formatUsage(json)}`,
  })
  if (finishReason === 'length') {
    const err = new Error(`Glossary candidate extraction stopped by length limit at pass=${pass}, pages ${pageNumbers.join(', ')}.`)
    ;(err as Error & { glossaryFinishReason?: string }).glossaryFinishReason = finishReason
    throw err
  }
  if (!content) throw new Error('Glossary candidate extraction response did not include message content')

  let candidates: NormalizedGlossaryCandidate[]
  try {
    candidates = dedupeCandidates(
      rawCandidates(parseJsonObjectFromLlmContent(content, `Glossary candidates ${pass} pages ${pageNumbers.join(', ')}`))
        .map(normalizeCandidate)
        .filter((candidate): candidate is NormalizedGlossaryCandidate => Boolean(candidate)),
    )
  } catch (error) {
    onProgress?.({
      step: 'chunk_done',
      chunkIndex,
      chunkCount,
      pages: pageNumbers,
      pass,
      message: `${pass} candidate chunk ${chunkIndex + 1}/${chunkCount}: invalid JSON; skipped (${error instanceof Error ? error.message : String(error)})`,
    })
    return []
  }
  onProgress?.({
    step: 'chunk_done',
    chunkIndex,
    chunkCount,
    pages: pageNumbers,
    pass,
    message: `${pass} candidate chunk ${chunkIndex + 1}/${chunkCount}: ${candidates.length} candidates`,
  })
  return candidates
}

async function requestDetailBatch(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  candidates: NormalizedGlossaryCandidate[],
  themeContext: string,
  chunkIndex: number,
  chunkCount: number,
  batchIndex: number,
  batchCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<RawGlossaryEntry[]> {
  const connection = requireAiConnection(settings, 'self-made glossary detail generation')
  const model = requireChatModelForProvider(settings, settings.translationModel, 'self-made glossary detail generation')
  const pages = Array.from(new Set(candidates.map(candidate => candidate.page).filter((page): page is number => typeof page === 'number')))
  onProgress?.({
    step: 'chunk_start',
    chunkIndex,
    chunkCount,
    pages,
    pass,
    message: `${pass} detail batch ${batchIndex + 1}/${batchCount}: ${candidates.length} candidates`,
  })

  const response = await tauriFetch(`${connection.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      ...resolveChatCompletionTokenLimitForProvider(settings, resolveGlossaryMaxOutputTokens(settings)),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You expand a fixed small list of glossary candidates into strict JSON entries. Do not translate or invent new values.',
        },
        {
          role: 'user',
          content: buildDetailPrompt(document, candidates, themeContext),
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Glossary detail generation API failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  let json: ChatCompletionResponse
  try {
    json = JSON.parse(text) as ChatCompletionResponse
  } catch (err) {
    throw new Error(`Glossary detail response JSON parse failed at batch ${batchIndex + 1}/${batchCount}: ${err instanceof Error ? err.message : String(err)} / body=${text.slice(0, 500)}`)
  }

  const choice = json.choices?.[0]
  const finishReason = choice?.finish_reason ?? 'unknown'
  const content = choice?.message?.content
  onProgress?.({
    step: 'api_response',
    chunkIndex,
    chunkCount,
    pages,
    pass,
    message: `${pass} detail batch ${batchIndex + 1}/${batchCount}: finish_reason=${finishReason}, content_chars=${content?.length ?? 0}${formatUsage(json)}`,
  })
  if (finishReason === 'length') {
    const err = new Error(`Glossary detail generation stopped by length limit at pass=${pass}, batch ${batchIndex + 1}/${batchCount}.`)
    ;(err as Error & { glossaryFinishReason?: string }).glossaryFinishReason = finishReason
    throw err
  }
  if (!content) throw new Error('Glossary detail generation response did not include message content')

  try {
    return rawEntries(parseJsonObjectFromLlmContent(content, `Glossary detail ${pass} batch ${batchIndex + 1}/${batchCount}`))
  } catch (error) {
    const err = new Error(`Glossary detail JSON parse failed at pass=${pass}, batch ${batchIndex + 1}/${batchCount}: ${error instanceof Error ? error.message : String(error)}`)
    ;(err as Error & { glossaryParseError?: boolean }).glossaryParseError = true
    throw err
  }
}

function isLengthLimitError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { glossaryFinishReason?: unknown }).glossaryFinishReason === 'length')
}

async function requestDetailBatchWithFallback(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  candidates: NormalizedGlossaryCandidate[],
  themeContext: string,
  chunkIndex: number,
  chunkCount: number,
  batchIndex: number,
  batchCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<RawGlossaryEntry[]> {
  try {
    return await requestDetailBatch(settings, document, candidates, themeContext, chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
  } catch (error) {
    const shouldSplit = isLengthLimitError(error) || Boolean(error && typeof error === 'object' && (error as { glossaryParseError?: unknown }).glossaryParseError)
    if (!shouldSplit) throw error
    if (candidates.length <= 1) {
      onProgress?.({
        step: 'chunk_done',
        chunkIndex,
        chunkCount,
        pages: candidates.map(candidate => candidate.page).filter((page): page is number => typeof page === 'number'),
        pass,
        message: `${pass} detail batch ${batchIndex + 1}/${batchCount}: skipped 1 candidate after JSON failure (${error instanceof Error ? error.message : String(error)})`,
      })
      return []
    }

    const midpoint = Math.ceil(candidates.length / 2)
    onProgress?.({
      step: 'chunk_start',
      chunkIndex,
      chunkCount,
      pages: candidates.map(candidate => candidate.page).filter((page): page is number => typeof page === 'number'),
      pass,
      message: `${pass} detail batch ${batchIndex + 1}/${batchCount}: retrying split for ${candidates.length} candidates (${error instanceof Error ? error.message : String(error)})`,
    })

    const first = await requestDetailBatchWithFallback(settings, document, candidates.slice(0, midpoint), themeContext, chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
    const second = await requestDetailBatchWithFallback(settings, document, candidates.slice(midpoint), themeContext, chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
    return [...first, ...second]
  }
}

// ============================================================
// パイプライン本体
// ============================================================

function emitVerificationLog(
  result: GlossaryVerificationResult,
  pages: number[],
  pass: GlossaryExtractionPass,
  chunkIndex: number,
  chunkCount: number,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): void {
  if (result.totalRejected === 0) return
  onProgress?.({
    step: 'api_response',
    chunkIndex,
    chunkCount,
    pages,
    pass,
    message: `${pass} verification: ${result.totalRejected} document claims warned across ${result.changes.length} entries (PDF text 照合で落ちた値は削除せず llm_inferred に降格)`,
  })
}

async function generateTwoStageSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions,
  themeContext: string,
  haystack: PdfHaystack,
  lightweightAssistive: boolean,
  concurrency: number,
): Promise<SelfMadeGlossaryEntry[]> {
  const useVision = settings.pdfExtractionUseVision
  const pagesByNumber = new Map(document.pages.map(page => [page.page, page]))
  const entries: SelfMadeGlossaryEntry[] = []
  const chunks = document.pages.map(page => [page])
  const pass: GlossaryExtractionPass = 'all'

  options.onProgress?.({
    step: 'chunk_start',
    chunkIndex: 0,
    chunkCount: chunks.length,
    pages: [],
    pass,
    message: `${pass}: pass started (${chunks.length} pages, concurrency=${concurrency})`,
  })

  const passEntries = await mapWithConcurrency(chunks.length, concurrency, async (i) => {
    const pages = chunks[i]
    const pageNumbers = pages.map(p => p.page)
    const candidates = await requestCandidateChunk(
      settings,
      document,
      pages,
      useVision,
      MAX_LOCAL_CHARS_PER_REQUEST,
      themeContext,
      i,
      chunks.length,
      pass,
      options.onProgress,
    )
    if (candidates.length === 0) return []

    if (lightweightAssistive) {
      const normalizedBatch = candidates
        .map(candidate => normalizeEntry(rawEntryFromCandidate(candidate), document, pagesByNumber))
        .filter((entry): entry is SelfMadeGlossaryEntry => Boolean(entry))
      if (normalizedBatch.length > 0) {
        const formulaCheckedBatch = await applyFormulaMiniReviewIfNeeded(
          settings,
          document,
          pages[0],
          normalizedBatch,
          themeContext,
          i,
          chunks.length,
          options.onProgress,
        )
        const verification = verifyEntriesWithHaystack(formulaCheckedBatch, haystack)
        emitVerificationLog(verification, pageNumbers, pass, i, chunks.length, options.onProgress)
        options.onEntries?.(verification.entries)
        return verification.entries
      }
      return []
    }

    const pageEntries: SelfMadeGlossaryEntry[] = []
    const batches = batchCandidates(candidates, LOCAL_DETAIL_BATCH_SIZE)
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const raw = await requestDetailBatchWithFallback(
        settings,
        document,
        batches[batchIndex],
        themeContext,
        i,
        chunks.length,
        batchIndex,
        batches.length,
        pass,
        options.onProgress,
      )
      const normalizedBatch = raw
        .map(entry => normalizeEntry(entry, document, pagesByNumber))
        .filter((entry): entry is SelfMadeGlossaryEntry => Boolean(entry))
      if (normalizedBatch.length > 0) {
        pageEntries.push(...normalizedBatch)
      }
    }
    if (pageEntries.length === 0) return pageEntries
    const formulaCheckedEntries = await applyFormulaMiniReviewIfNeeded(
      settings,
      document,
      pages[0],
      pageEntries,
      themeContext,
      i,
      chunks.length,
      options.onProgress,
    )
    const verification = verifyEntriesWithHaystack(formulaCheckedEntries, haystack)
    emitVerificationLog(verification, pageNumbers, pass, i, chunks.length, options.onProgress)
    options.onEntries?.(verification.entries)
    return verification.entries
  })

  entries.push(...passEntries.flat())
  options.onProgress?.({
    step: 'chunk_done',
    chunkIndex: chunks.length - 1,
    chunkCount: chunks.length,
    pages: [],
    pass,
    message: `${pass}: pass completed (${entries.length} entries)`,
  })

  return entries
}

async function generateLocalSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions,
  themeContext: string,
  haystack: PdfHaystack,
): Promise<SelfMadeGlossaryEntry[]> {
  return generateTwoStageSelfMadeGlossaryFromPdf(
    settings,
    document,
    options,
    themeContext,
    haystack,
    true,
    resolveGlossaryConcurrency(settings),
  )
}

async function generateNonVisionSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions,
  themeContext: string,
  haystack: PdfHaystack,
): Promise<SelfMadeGlossaryEntry[]> {
  const pagesByNumber = new Map(document.pages.map(page => [page.page, page]))
  const chunks = chunkPages(document.pages, false, MAX_CHARS_PER_REQUEST)
  const entries: SelfMadeGlossaryEntry[] = []
  const pass: GlossaryExtractionPass = 'all'

  options.onProgress?.({
    step: 'chunk_start',
    chunkIndex: 0,
    chunkCount: chunks.length,
    pages: [],
    pass,
    message: `${pass}: pass started (${chunks.length} chunks)`,
  })

  for (let i = 0; i < chunks.length; i += 1) {
    const pages = chunks[i]
    const pageNumbers = pages.map(p => p.page)
    const candidates = await requestCandidateChunk(
      settings,
      document,
      pages,
      false,
      MAX_CHARS_PER_REQUEST,
      themeContext,
      i,
      chunks.length,
      pass,
      options.onProgress,
    )
    if (candidates.length === 0) continue

    const batches = batchCandidates(candidates, LOCAL_DETAIL_BATCH_SIZE)
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const raw = await requestDetailBatchWithFallback(
        settings,
        document,
        batches[batchIndex],
        themeContext,
        i,
        chunks.length,
        batchIndex,
        batches.length,
        pass,
        options.onProgress,
      )
      const normalizedBatch = raw
        .map(entry => normalizeEntry(entry, document, pagesByNumber))
        .filter((entry): entry is SelfMadeGlossaryEntry => Boolean(entry))
      if (normalizedBatch.length > 0) {
        const verification = verifyEntriesWithHaystack(normalizedBatch, haystack)
        emitVerificationLog(verification, pageNumbers, pass, i, chunks.length, options.onProgress)
        entries.push(...verification.entries)
        options.onEntries?.(verification.entries)
      }
    }
  }

  options.onProgress?.({
    step: 'chunk_done',
    chunkIndex: chunks.length - 1,
    chunkCount: chunks.length,
    pages: [],
    pass,
    message: `${pass}: pass completed (${entries.length} entries)`,
  })
  return entries
}

export async function generateSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions = {},
): Promise<SelfMadeGlossaryEntry[]> {
  // 処理 0: 講義主題の事前把握
  let themeContext = ''
  try {
    const theme = await extractDocumentTheme(settings, document, options.onProgress)
    themeContext = theme.promptContext
  } catch (error) {
    options.onProgress?.({
      step: 'theme_done',
      chunkIndex: 0,
      chunkCount: 1,
      pages: [],
      pass: 'theme',
      message: `theme extraction failed; continuing without context: ${error instanceof Error ? error.message : String(error)}`,
    })
  }

  // 処理 D 用に PDF 全文ハイ・スタックを一度だけ作る
  const haystack = buildPdfHaystack(document)

  const useVision = settings.pdfExtractionUseVision
  const isLocal = settings.translationProvider === 'local_openai'

  if (isLocal) {
    return generateLocalSelfMadeGlossaryFromPdf(settings, document, options, themeContext, haystack)
  }
  if (useVision) {
    return generateTwoStageSelfMadeGlossaryFromPdf(
      settings,
      document,
      options,
      themeContext,
      haystack,
      false,
      resolveGlossaryConcurrency(settings),
    )
  }
  return generateNonVisionSelfMadeGlossaryFromPdf(settings, document, options, themeContext, haystack)
}
