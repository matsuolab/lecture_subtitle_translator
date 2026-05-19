/**
 * 自作辞書生成パイプライン (Step 1 実装)
 *
 * 詳細設計は docs/glossary_pipeline_design.md を参照。
 *
 * 本ファイルが担う範囲:
 *   - 処理 0: extractDocumentTheme (講義主題の事前把握)
 *   - 処理 A+B: requestCandidateChunk / requestDetailBatch (PDF テキスト + 画像から候補抽出)
 *
 * 未実装 (今後 Step 2〜4 で追加):
 *   - 処理 C (LLM 整理・ペアリング)
 *   - 処理 D (ルールベース検証)
 *   - 処理 E (LLM 翻訳補完)
 */

import type {
  SelfMadeGlossaryCategory,
  SelfMadeGlossaryChildSource,
  SelfMadeGlossaryEntry,
  SelfMadeGlossaryValueSource,
} from '@/context/GlossaryContext'
import { requireAiConnection, requireChatModelForProvider, resolveChatCompletionTokenLimitForProvider, resolveJsonResponseFormatForProvider } from '@/lib/pipeline/aiProvider'
import { parseJsonObjectFromLlmContent } from '@/lib/pipeline/jsonResponse'
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
type GlossaryExtractionPass = 'all'

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
  page?: number
  snippet?: string
  ja?: string
  en?: string
  formula?: string
  displayText?: string
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
const MIN_GLOSSARY_CONCURRENCY = 1
const MAX_GLOSSARY_CONCURRENCY = 20

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
  return clamp(Math.trunc(settings.glossaryRequestConcurrency), MIN_GLOSSARY_CONCURRENCY, MAX_GLOSSARY_CONCURRENCY)
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

async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(concurrency, count))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < count) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await run(index)
    }
  }))

  return results
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
- jaSource / enSource は申告したら検証されます。PDF に実在しない値を "document" 申告すると後段で削除されます
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
- 略語と正式名が同じ概念を指す場合、別 entry にせず正式名 entry の abbr に略語を入れる
- 既存 candidate の category を勝手に変えない (明らかな誤分類のときだけ訂正可)

JSON 形式:
{
  "entries": [
    {
      "category": "term" | "proper_noun" | "formula" | "abbreviation" | "reference",
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
    page: asPage(raw.page),
    snippet: asOptionalString(raw.snippet),
    ja,
    en,
    formula,
    displayText,
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
  const initialCategory = normalizeCategory(raw.category)
  const ja = asString(raw.ja)
  const en = asString(raw.en)
  const formula = asString(raw.formula)
  const displayText = asString(raw.displayText)
  const abbr = asOptionalString(raw.abbr)

  if (!ja && !en && !abbr && !formula && !displayText) return null

  const classification = applyDeterministicClassification(initialCategory, ja, en, formula, displayText)

  return {
    id: crypto.randomUUID(),
    category: classification.category,
    origin: 'document_generated',
    ja,
    en,
    jaSource: normalizeValueSource(raw.jaSource, ja),
    enSource: normalizeValueSource(raw.enSource, en),
    abbr,
    formula: formula || undefined,
    latex: asOptionalString(raw.latex),
    displayText: displayText || undefined,
    domain: asOptionalString(raw.domain),
    note: asOptionalString(raw.note),
    desc: asOptionalString(raw.desc),
    confidence: asConfidence(raw.confidence),
    formalEligible: classification.formalEligible,
    assistiveEligible: classification.assistiveEligible,
    provisional: true,
    disabled: classification.disabled,
    reviewReason: classification.reviewReason ?? asOptionalString(raw.reviewReason),
    jaConfirmed: false,
    enConfirmed: false,
    promoted: false,
    source: document.source,
    children: normalizeChildren(raw, pagesByNumber),
    createdAt: now,
    updatedAt: now,
  }
}

function rawEntryFromCandidate(candidate: NormalizedGlossaryCandidate): RawGlossaryEntry {
  const text = candidate.text
  return {
    category: candidate.category,
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
// 処理 D: ハルシネーション検証 (ルールベース)
//
// LLM (A+B / C) が「PDF に書かれている」と申告した値が
// 本当に PDF テキストに存在するかを文字列照合で検証する。
// 存在しない値は空にし、対応 source を "missing" に降格する。
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
  /** 小文字化＋空白圧縮した照合用テキスト */
  normalized: string
}

function buildPdfHaystack(document: ExtractedPdfDocument): PdfHaystack {
  const raw = document.pages.map(page => page.text).join('\n')
  const normalized = raw.toLowerCase().replace(/\s+/g, ' ')
  return { raw, normalized }
}

function normalizeNeedle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
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
  value: string
  source: SelfMadeGlossaryValueSource
  changed: boolean
}

function verifyValue(value: string, source: SelfMadeGlossaryValueSource, haystack: PdfHaystack): VerifiedValue {
  if (!value) return { value, source, changed: false }
  if (!shouldVerifySource(source)) return { value, source, changed: false }
  if (pdfContains(haystack, value)) return { value, source, changed: false }
  return { value: '', source: 'missing', changed: true }
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
  let rejectedClaims = 0

  const ja = verifyValue(entry.ja, entry.jaSource, haystack)
  if (ja.changed) {
    reasons.push(`ja "${entry.ja}" not found in PDF; source demoted document → missing`)
    rejectedClaims += 1
  }

  const en = verifyValue(entry.en, entry.enSource, haystack)
  if (en.changed) {
    reasons.push(`en "${entry.en}" not found in PDF; source demoted document → missing`)
    rejectedClaims += 1
  }

  if (reasons.length === 0) {
    return { entry, changed: false, reasons: [], rejectedClaims: 0 }
  }

  const existingReason = entry.reviewReason?.trim()
  const newReason = `ハルシネーション検証: ${reasons.join(' / ')}`
  return {
    entry: {
      ...entry,
      ja: ja.value,
      en: en.value,
      jaSource: ja.source,
      enSource: en.source,
      reviewReason: existingReason ? `${existingReason} | ${newReason}` : newReason,
      updatedAt: new Date().toISOString(),
    },
    changed: true,
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
    message: `${pass} verification: ${result.totalRejected} claims rejected across ${result.changes.length} entries (PDF 照合で document 申告が落ちた値を missing に降格)`,
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
        const verification = verifyEntriesWithHaystack(normalizedBatch, haystack)
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
        const verification = verifyEntriesWithHaystack(normalizedBatch, haystack)
        emitVerificationLog(verification, pageNumbers, pass, i, chunks.length, options.onProgress)
        pageEntries.push(...verification.entries)
        options.onEntries?.(verification.entries)
      }
    }
    return pageEntries
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
