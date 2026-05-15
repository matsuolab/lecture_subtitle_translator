import type {
  SelfMadeGlossaryChildSource,
  SelfMadeGlossaryEntry,
  SelfMadeGlossaryEntryClass,
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

type GlossaryExtractionPass =
  | 'all'
  | 'formal_terms'
  | 'formal_bilingual_terms'
  | 'formal_names_only'
  | 'assistive_notations'
  | 'references_and_noise'

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
  kind?: unknown
  entryClass?: unknown
  formalEligible?: unknown
  assistiveEligible?: unknown
  ja?: unknown
  jaSource?: unknown
  en?: unknown
  enSource?: unknown
  abbr?: unknown
  formula?: unknown
  latex?: unknown
  displayText?: unknown
  spokenJa?: unknown
  spokenEn?: unknown
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
  kind?: unknown
  entryClass?: unknown
  page?: unknown
  snippet?: unknown
  ja?: unknown
  en?: unknown
  formula?: unknown
  displayText?: unknown
}

interface NormalizedGlossaryCandidate {
  text: string
  kind: SelfMadeGlossaryEntry['kind']
  entryClass: SelfMadeGlossaryEntryClass
  page?: number
  snippet?: string
  ja?: string
  en?: string
  formula?: string
  displayText?: string
}

const MAX_CHARS_PER_REQUEST = 12_000
const MAX_LOCAL_CHARS_PER_REQUEST = 7_000
const LOCAL_DETAIL_BATCH_SIZE = 5
const LOCAL_TWO_STAGE_CONCURRENCY = 2
const VISION_TWO_STAGE_CONCURRENCY = 3

export type GlossaryGenerationProgressEvent = {
  step: 'chunk_start' | 'api_response' | 'chunk_done'
  chunkIndex: number
  chunkCount: number
  pages: number[]
  pass: GlossaryExtractionPass
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

function passInstruction(pass: GlossaryExtractionPass): string {
  if (pass === 'formal_terms') {
    return `今回の抽出対象は正式辞書候補だけ。
- formal_term になり得る専門用語・略語だけを漏れなく抽出する
- 数式、サイズ表記、URL、引用元、一般語、図中の単なる例示ラベルは出さない
- formalEligible=true, assistiveEligible=true にする`
  }
  if (pass === 'formal_bilingual_terms') {
    return `今回の抽出対象は正式辞書候補のうち、PDF内で日本語と英語が併記・近接している用語だけ。
- 括弧併記、同一行、同一図表内などで日英対応が強いものを抽出する
- 英語だけの固有名詞、データセット名、モデル名は出さない
- 数式、サイズ表記、URL、引用元、一般語は出さない
- formalEligible=true, assistiveEligible=true にする`
  }
  if (pass === 'formal_names_only') {
    return `今回の抽出対象は正式辞書候補のうち、英語だけで出ている固有名詞・略語・データセット名・モデル名だけ。
- MNIST, ImageNet, LeNet のような固有名詞・略語を抽出する
- 日本語訳がPDF内にない場合、jaは空文字、jaSource="missing" にする
- 日英併記の一般専門用語、数式、サイズ表記、URL、引用元、一般語は出さない
- formalEligible=true, assistiveEligible=true にする`
  }
  if (pass === 'assistive_notations') {
    return `今回の抽出対象は補正・読み支援候補だけ。
- 数式、数式読み、2×2や6@14×14のようなサイズ/特徴マップ表記、字幕で読み間違えやすい記号表現だけを抽出する
- 正式専門用語、URL、引用元、一般語は出さない
- formalEligible=false, assistiveEligible=true にする`
  }
  if (pass === 'references_and_noise') {
    return `今回の抽出対象は参考情報・除外候補だけ。
- URL、引用元、画像素材サイト、論文リンク、図表出典、一般語、ノイズ候補だけを分類する
- 正式専門用語や数式読み候補は出さない
- URL/引用元は entryClass="reference", formalEligible=false, assistiveEligible=false にする
- 一般語は entryClass="generic_word"、不要なものは entryClass="noise" にする`
  }
  return `今回の抽出対象は全カテゴリ。
- 正式専門用語、略語、数式読み、サイズ表記、参考情報を分類して抽出する`
}

function buildPrompt(document: ExtractedPdfDocument, pages: ExtractedPdfPage[], useVision: boolean, maxChars: number, pass: GlossaryExtractionPass): string {
  return `以下のPDF資料から、字幕の書き起こし修正・英訳修正に使う専門用語辞書候補を抽出してください。

文書名: ${document.source.name}

${passInstruction(pass)}

抽出対象:
- 固有の専門用語、プロジェクト固有表現、略語
- 日本語・英語の対応が推定できる表現
- 講義字幕で読み間違えや翻訳ぶれが起きやすい数式・記号表現
- 一般語すぎるもの、本文だけでは根拠が薄いものは除外

制約:
- JSONのみを返す
- ja または en が不明な場合は空文字にする
- 数式の場合は kind を "formula" にし、formula/displayText/spokenJa/spokenEn を可能な範囲で埋める
- evidence には根拠ページと短い本文抜粋を入れる
- references には本文中URLが根拠の場合だけ入れる。URL先はまだ読まない
${useVision ? '- 添付ページ画像も確認する。PDFテキスト抽出と画像が矛盾する場合、数式・添字・上付き・ギリシャ文字・図表中の略語は画像を優先する' : ''}
- URLドメイン、画像素材サイト、論文URL、引用元URLは正式辞書候補にしない。必要なら entryClass="reference", formalEligible=false, assistiveEligible=false にする
- 2×2, 5×5, 6@14×14 のようなサイズ・特徴マップ表記は正式用語ではない。entryClass="shape_notation", formalEligible=false, assistiveEligible=true にする
- row, column, red, green, image のような一般語は、講義固有の訳語管理が必要な場合だけ出す。通常は entryClass="generic_word" または "noise" にする
- PDF本文またはページ画像に日本語/英語が実在する場合は jaSource/enSource を "document" または "vision" にする。LLMが補った訳語は "llm_inferred" にする
- 正式辞書へ昇格してよい専門用語だけ formalEligible=true にする。補正や読み上げ支援にだけ有用な候補は assistiveEligible=true, formalEligible=false にする
- 指定された抽出対象カテゴリだけを出す。対象外カテゴリは出さない
- 各 description/note/reviewReason/snippet は短くする

JSON形式:
{
  "entries": [
    {
      "kind": "term" | "abbreviation" | "formula",
      "entryClass": "formal_term" | "assistive_notation" | "formula_reading" | "shape_notation" | "reference" | "generic_word" | "noise",
      "formalEligible": true,
      "assistiveEligible": true,
      "ja": "",
      "jaSource": "document" | "vision" | "llm_inferred" | "missing",
      "en": "",
      "enSource": "document" | "vision" | "llm_inferred" | "missing",
      "abbr": "",
      "formula": "",
      "latex": "",
      "displayText": "",
      "spokenJa": "",
      "spokenEn": "",
      "domain": "",
      "desc": "",
      "note": "",
      "reviewReason": "",
      "evidence": [{ "page": 1, "snippet": "" }],
      "references": [{ "page": 1, "url": "", "label": "" }]
    }
  ]
}

本文:
${formatPagesForPrompt(pages, maxChars)}`
}

function buildUserContent(document: ExtractedPdfDocument, pages: ExtractedPdfPage[], useVision: boolean, maxChars: number, pass: GlossaryExtractionPass): ChatMessageContent {
  const prompt = buildPrompt(document, pages, useVision, maxChars, pass)
  if (!useVision) return prompt

  const content: Exclude<ChatMessageContent, string> = [{ type: 'text', text: prompt }]
  for (const page of pages) {
    if (!page.imageDataUrl) continue
    content.push({ type: 'image_url', image_url: { url: page.imageDataUrl, detail: 'high' } })
  }
  return content
}

function buildCandidatePrompt(document: ExtractedPdfDocument, pages: ExtractedPdfPage[], useVision: boolean, maxChars: number, pass: GlossaryExtractionPass): string {
  return `以下のPDF資料から、辞書化する前の「候補名だけ」を抽出してください。

文書名: ${document.source.name}

${passInstruction(pass)}

目的:
- この段階では候補の列挙だけを行う
- 詳細説明、読み、根拠配列、参考URL配列は後段で作る
- 出力を短くし、ローカルLLMの出力上限に当たらないようにする

制約:
- JSONのみを返す
- entries は絶対に返さない
- desc, note, reviewReason, spokenJa, spokenEn, domain, evidence, references は絶対に出さない
- 1候補は text/kind/entryClass/page/snippet だけを基本にする
- ja/en/formula/displayText はPDF上で明確に分かる場合だけ短く入れてよい
- snippet は候補が出ている短い本文だけにする
- Machine Learning (ML) のように正式用語と略語が同じ箇所で出ている場合、別候補に分けず、正式用語側を1候補だけ出す
- 「人間」「機械」など単独では講義固有の訳語管理が不要な一般語は候補に出さない
${useVision ? '- 添付ページ画像もPDF本文と同じ抽出対象として確認する。PDFテキストに存在しないが画像上に見える数式・添字・上付き・ギリシャ文字・図表中の略語も新規候補として出す' : ''}
${useVision ? '- 画像上の数式がPDFテキストで壊れている、欠落している、順序が崩れている場合は、画像で読める表記を formula/displayText に入れる' : ''}
${useVision ? '- Visionは候補追加のために使う。既存テキスト候補の補正だけで終わらせない' : ''}

JSON形式:
{
  "candidates": [
    {
      "text": "",
      "kind": "term" | "abbreviation" | "formula",
      "entryClass": "formal_term" | "assistive_notation" | "formula_reading" | "shape_notation" | "reference" | "generic_word" | "noise",
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

function buildCandidateUserContent(document: ExtractedPdfDocument, pages: ExtractedPdfPage[], useVision: boolean, maxChars: number, pass: GlossaryExtractionPass): ChatMessageContent {
  const prompt = buildCandidatePrompt(document, pages, useVision, maxChars, pass)
  if (!useVision) return prompt

  const content: Exclude<ChatMessageContent, string> = [{ type: 'text', text: prompt }]
  for (const page of pages) {
    if (!page.imageDataUrl) continue
    content.push({ type: 'image_url', image_url: { url: page.imageDataUrl, detail: 'high' } })
  }
  return content
}

function buildDetailPrompt(document: ExtractedPdfDocument, candidates: NormalizedGlossaryCandidate[], pass: GlossaryExtractionPass): string {
  return `以下の候補だけを、自作辞書へ保存する詳細JSONに展開してください。

文書名: ${document.source.name}

${passInstruction(pass)}

制約:
- JSONのみを返す
- 新しい候補を追加しない
- 入力候補にない用語を補完しない
- desc/note/reviewReason/snippet は短くする
- ja または en が不明な場合は空文字にし、対応する Source は "missing" にする
- PDF本文またはページ画像に実在した日英表記は Source を "document" または "vision" にする
- LLMが補った訳語は Source を "llm_inferred" にする
- URLドメインや引用元は正式辞書候補にしない
- 2×2, 5×5, 6@14×14 のようなサイズ・特徴マップ表記は entryClass="shape_notation", formalEligible=false, assistiveEligible=true にする
- Machine Learning (ML) のように正式用語と略語が同じ概念を指す場合、別entryにせず正式用語entryの abbr に入れる
- Deep Learning (DL) のように日英どちらかが候補側で欠けていても、候補リスト内またはsnippet上で同じ概念だと明確な場合は1entryに統合する
- 「人間」「機械」などの一般語は entryClass="generic_word", formalEligible=false, assistiveEligible=false, disabled相当にする前提で出力し、迷う場合は出さない

JSON形式:
{
  "entries": [
    {
      "kind": "term" | "abbreviation" | "formula",
      "entryClass": "formal_term" | "assistive_notation" | "formula_reading" | "shape_notation" | "reference" | "generic_word" | "noise",
      "formalEligible": true,
      "assistiveEligible": true,
      "ja": "",
      "jaSource": "document" | "vision" | "llm_inferred" | "missing",
      "en": "",
      "enSource": "document" | "vision" | "llm_inferred" | "missing",
      "abbr": "",
      "formula": "",
      "latex": "",
      "displayText": "",
      "spokenJa": "",
      "spokenEn": "",
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

function normalizeKind(value: unknown): SelfMadeGlossaryEntry['kind'] {
  return value === 'abbreviation' || value === 'formula' ? value : 'term'
}

function normalizeEntryClass(value: unknown): SelfMadeGlossaryEntryClass {
  if (
    value === 'formal_term'
    || value === 'assistive_notation'
    || value === 'formula_reading'
    || value === 'shape_notation'
    || value === 'reference'
    || value === 'generic_word'
    || value === 'noise'
  ) {
    return value
  }
  return 'formal_term'
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
    kind: normalizeKind(raw.kind),
    entryClass: normalizeEntryClass(raw.entryClass),
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
      candidate.kind,
      candidate.entryClass,
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
  if (value === 'document' || value === 'vision' || value === 'llm_inferred' || value === 'manual') return value
  return text.trim() ? 'llm_inferred' : 'missing'
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

function looksLikeUrlOrDomain(value: string): boolean {
  const text = value.trim().toLowerCase()
  return /^https?:\/\//.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/.test(text)
}

function looksLikeShapeNotation(value: string): boolean {
  const text = value.trim()
  return /^\d+\s*[×x]\s*\d+(\s*[,、]\s*\d+\s*[×x]\s*\d+)*$/.test(text)
    || /^\d+\s*@\s*\d+\s*[×x]\s*\d+$/.test(text)
    || /^\d+\s*[×x]\s*\d+\s*[×x]\s*\d+$/.test(text)
}

function applyDeterministicClassification(
  entryClass: SelfMadeGlossaryEntryClass,
  kind: SelfMadeGlossaryEntry['kind'],
  ja: string,
  en: string,
  formula: string,
  displayText: string,
): {
  entryClass: SelfMadeGlossaryEntryClass
  formalEligible: boolean
  assistiveEligible: boolean
  disabled: boolean
  reviewReason?: string
} {
  const values = [ja, en, formula, displayText].filter(Boolean)
  if (values.some(looksLikeUrlOrDomain)) {
    return {
      entryClass: 'reference',
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: 'URLまたは引用元ドメインのため正式辞書・補正利用から除外',
    }
  }
  if (values.some(looksLikeShapeNotation)) {
    return {
      entryClass: 'shape_notation',
      formalEligible: false,
      assistiveEligible: true,
      disabled: false,
      reviewReason: 'サイズ・特徴マップ表記のため正式辞書ではなく補正支援候補',
    }
  }
  if (kind === 'formula' && entryClass === 'formal_term') {
    return {
      entryClass: 'formula_reading',
      formalEligible: false,
      assistiveEligible: true,
      disabled: false,
      reviewReason: '数式読み支援候補',
    }
  }
  if (entryClass === 'reference' || entryClass === 'noise') {
    return {
      entryClass,
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: entryClass === 'reference'
        ? '参考情報のため正式辞書・補正利用から除外'
        : 'ノイズ候補のため除外',
    }
  }
  if (kind === 'formula' && entryClass === 'shape_notation' && values.some(value => /^[A-Za-zΑ-Ωα-ω]$/.test(value.trim()))) {
    return {
      entryClass: 'formula_reading',
      formalEligible: false,
      assistiveEligible: true,
      disabled: false,
      reviewReason: '単独記号の読み支援候補',
    }
  }
  if (entryClass === 'generic_word') {
    return {
      entryClass,
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: '一般語のため既定では正式辞書・補正利用から除外',
    }
  }
  if (entryClass === 'assistive_notation' || entryClass === 'formula_reading' || entryClass === 'shape_notation') {
    return {
      entryClass,
      formalEligible: false,
      assistiveEligible: true,
      disabled: false,
    }
  }
  return {
    entryClass,
    formalEligible: true,
    assistiveEligible: true,
    disabled: false,
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
  const kind = normalizeKind(raw.kind)
  const initialEntryClass = normalizeEntryClass(raw.entryClass)
  const ja = asString(raw.ja)
  const en = asString(raw.en)
  const formula = asString(raw.formula)
  const displayText = asString(raw.displayText)
  const abbr = asOptionalString(raw.abbr)

  if (!ja && !en && !abbr && !formula && !displayText) return null

  const classification = applyDeterministicClassification(initialEntryClass, kind, ja, en, formula, displayText)

  return {
    id: crypto.randomUUID(),
    kind,
    entryClass: classification.entryClass,
    origin: 'document_generated',
    ja,
    en,
    jaSource: normalizeValueSource(raw.jaSource, ja),
    enSource: normalizeValueSource(raw.enSource, en),
    abbr,
    formula: formula || undefined,
    latex: asOptionalString(raw.latex),
    displayText: displayText || undefined,
    spokenJa: asOptionalString(raw.spokenJa),
    spokenEn: asOptionalString(raw.spokenEn),
    domain: asOptionalString(raw.domain),
    note: asOptionalString(raw.note),
    desc: asOptionalString(raw.desc),
    confidence: asConfidence(raw.confidence),
    formalEligible: isBoolean(raw.formalEligible) ? raw.formalEligible && classification.formalEligible : classification.formalEligible,
    assistiveEligible: isBoolean(raw.assistiveEligible) ? raw.assistiveEligible || classification.assistiveEligible : classification.assistiveEligible,
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
  const isAssistive = candidate.entryClass !== 'formal_term'
  const text = candidate.text
  return {
    kind: candidate.kind,
    entryClass: candidate.entryClass,
    formalEligible: !isAssistive,
    assistiveEligible: true,
    ja: candidate.ja ?? '',
    jaSource: candidate.ja ? 'document' : 'missing',
    en: candidate.en ?? '',
    enSource: candidate.en ? 'document' : 'missing',
    formula: candidate.formula ?? (candidate.kind === 'formula' ? text : ''),
    displayText: candidate.displayText ?? text,
    desc: '',
    note: '',
    reviewReason: isAssistive ? 'ローカルLLMの軽量候補抽出から作成した補正支援候補' : '',
    evidence: [{ page: candidate.page, snippet: candidate.snippet ?? text }],
    references: [],
  }
}

async function requestGlossaryChunk(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
  chunkIndex: number,
  chunkCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<RawGlossaryEntry[]> {
  const connection = requireAiConnection(settings, 'self-made glossary generation')
  const requestedModel = useVision ? settings.pdfExtractionVisionModel : settings.translationModel
  const model = requireChatModelForProvider(settings, requestedModel, 'self-made glossary generation')
  const pageNumbers = pages.map(page => page.page)
  onProgress?.({
    step: 'chunk_start',
    chunkIndex,
    chunkCount,
    pages: pageNumbers,
    pass,
    message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: pages ${pageNumbers.join(', ')}`,
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
      ...resolveChatCompletionTokenLimitForProvider(settings, 2048),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You extract high-value bilingual glossary candidates for subtitle correction. Return strict JSON only.',
        },
        {
          role: 'user',
          content: buildUserContent(document, pages, useVision, maxChars, pass),
        },
      ],
    }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Glossary generation API failed: HTTP ${response.status} ${text.slice(0, 500)}`)
  }

  let json: ChatCompletionResponse
  try {
    json = JSON.parse(text) as ChatCompletionResponse
  } catch (err) {
    throw new Error(`Glossary generation response JSON parse failed at pages ${pageNumbers.join(', ')}: ${err instanceof Error ? err.message : String(err)} / body=${text.slice(0, 500)}`)
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
    message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: finish_reason=${finishReason}, content_chars=${content?.length ?? 0}${formatUsage(json)}`,
  })
  if (finishReason === 'length') {
    const err = new Error(`Glossary generation stopped by length limit at pass=${pass}, pages ${pageNumbers.join(', ')}. Use a model with a larger output limit or reduce the page content.`)
    ;(err as Error & { glossaryFinishReason?: string }).glossaryFinishReason = finishReason
    throw err
  }
  if (!content) throw new Error('Glossary generation response did not include message content')
  const entries = rawEntries(parseJsonObjectFromLlmContent(content, `Glossary generation ${pass} pages ${pageNumbers.join(', ')}`))
  onProgress?.({
    step: 'chunk_done',
    chunkIndex,
    chunkCount,
    pages: pageNumbers,
    pass,
    message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: ${entries.length} candidates`,
  })
  return entries
}

async function requestCandidateChunk(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
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
      ...resolveChatCompletionTokenLimitForProvider(settings, 2048),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You extract only compact glossary candidate lists. Return strict JSON only.',
        },
        {
          role: 'user',
          content: buildCandidateUserContent(document, pages, useVision, maxChars, pass),
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
      ...resolveChatCompletionTokenLimitForProvider(settings, 2048),
      response_format: resolveJsonResponseFormatForProvider(settings),
      messages: [
        {
          role: 'system',
          content: 'You expand a fixed small list of glossary candidates into strict JSON entries. Do not add candidates.',
        },
        {
          role: 'user',
          content: buildDetailPrompt(document, candidates, pass),
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

async function requestDetailBatchWithFallback(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  candidates: NormalizedGlossaryCandidate[],
  chunkIndex: number,
  chunkCount: number,
  batchIndex: number,
  batchCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
): Promise<RawGlossaryEntry[]> {
  try {
    return await requestDetailBatch(settings, document, candidates, chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
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

    const first = await requestDetailBatchWithFallback(settings, document, candidates.slice(0, midpoint), chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
    const second = await requestDetailBatchWithFallback(settings, document, candidates.slice(midpoint), chunkIndex, chunkCount, batchIndex, batchCount, pass, onProgress)
    return [...first, ...second]
  }
}

function isLengthLimitError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { glossaryFinishReason?: unknown }).glossaryFinishReason === 'length')
}

function fallbackPassesFor(pass: GlossaryExtractionPass): GlossaryExtractionPass[] | null {
  if (pass === 'formal_terms') return ['formal_bilingual_terms', 'formal_names_only']
  return null
}

async function requestGlossaryWithFallback(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  pages: ExtractedPdfPage[],
  useVision: boolean,
  maxChars: number,
  chunkIndex: number,
  chunkCount: number,
  pass: GlossaryExtractionPass,
  onProgress?: GlossaryGenerationOptions['onProgress'],
  splitDepth = 0,
): Promise<RawGlossaryEntry[]> {
  try {
    return await requestGlossaryChunk(settings, document, pages, useVision, maxChars, chunkIndex, chunkCount, pass, onProgress)
  } catch (error) {
    if (isLengthLimitError(error) && splitDepth < 3 && pages.some(page => Boolean(page.imageDataUrl))) {
      const pageNumbers = pages.map(page => page.page)
      onProgress?.({
        step: 'chunk_start',
        chunkIndex,
        chunkCount,
        pages: pageNumbers,
        pass,
        message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: length limit; retrying without page image`,
      })
      return requestGlossaryWithFallback(
        settings,
        document,
        pages.map(page => ({ ...page, imageDataUrl: undefined })),
        false,
        maxChars,
        chunkIndex,
        chunkCount,
        pass,
        onProgress,
        splitDepth + 1,
      )
    }

    if (isLengthLimitError(error) && splitDepth < 3) {
      const splitPages = splitExtractedPages(pages)
      if (splitPages.length > 1) {
        const pageNumbers = pages.map(page => page.page)
        onProgress?.({
          step: 'chunk_start',
          chunkIndex,
          chunkCount,
          pages: pageNumbers,
          pass,
          message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: length limit; splitting page text into ${splitPages.length} parts`,
        })

        const results: RawGlossaryEntry[] = []
        for (const splitPage of splitPages) {
          const raw = await requestGlossaryWithFallback(
            settings,
            document,
            [splitPage],
            useVision,
            maxChars,
            chunkIndex,
            chunkCount,
            pass,
            onProgress,
            splitDepth + 1,
          )
          results.push(...raw)
        }
        return results
      }
    }

    const fallbackPasses = fallbackPassesFor(pass)
    if (!isLengthLimitError(error) || !fallbackPasses) throw error

    const pageNumbers = pages.map(page => page.page)
    onProgress?.({
      step: 'chunk_start',
      chunkIndex,
      chunkCount,
      pages: pageNumbers,
      pass,
      message: `${pass} chunk ${chunkIndex + 1}/${chunkCount}: length limit; retrying as ${fallbackPasses.join(' + ')}`,
    })

    const results: RawGlossaryEntry[] = []
    for (const fallbackPass of fallbackPasses) {
      const raw = await requestGlossaryWithFallback(settings, document, pages, useVision, maxChars, chunkIndex, chunkCount, fallbackPass, onProgress, splitDepth)
      results.push(...raw)
    }
    return results
  }
}

function splitTextIntoParts(text: string): string[] {
  const normalized = text.trim()
  if (normalized.length < 1200) return []
  const targetParts = normalized.length > 4200 ? 4 : 2
  const partSize = Math.ceil(normalized.length / targetParts)
  const parts: string[] = []

  for (let start = 0; start < normalized.length; start += partSize) {
    let end = Math.min(normalized.length, start + partSize)
    if (end < normalized.length) {
      const nextBreak = normalized.lastIndexOf(' ', end)
      if (nextBreak > start + Math.floor(partSize * 0.55)) end = nextBreak
    }
    parts.push(normalized.slice(start, end).trim())
  }

  return parts.filter(Boolean)
}

function splitExtractedPages(pages: ExtractedPdfPage[]): ExtractedPdfPage[] {
  if (pages.length > 1) return pages
  const page = pages[0]
  const textParts = splitTextIntoParts(page.text)
  if (textParts.length <= 1) return []
  return textParts.map((text, index) => ({
    ...page,
    text,
    imageDataUrl: index === 0 ? page.imageDataUrl : undefined,
  }))
}

async function generateTwoStageSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions,
  passes: GlossaryExtractionPass[],
  lightweightAssistive: boolean,
  concurrency: number,
): Promise<SelfMadeGlossaryEntry[]> {
  const useVision = settings.pdfExtractionUseVision
  const pagesByNumber = new Map(document.pages.map(page => [page.page, page]))
  const entries: SelfMadeGlossaryEntry[] = []
  const chunks = document.pages.map(page => [page])

  for (const pass of passes) {
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
      const candidates = await requestCandidateChunk(
        settings,
        document,
        pages,
        useVision,
        MAX_LOCAL_CHARS_PER_REQUEST,
        i,
        chunks.length,
        pass,
        options.onProgress,
      )
      if (candidates.length === 0) return []

      if (lightweightAssistive && pass === 'assistive_notations') {
        const normalizedBatch = candidates
          .map(candidate => normalizeEntry(rawEntryFromCandidate(candidate), document, pagesByNumber))
          .filter((entry): entry is SelfMadeGlossaryEntry => Boolean(entry))
        if (normalizedBatch.length > 0) {
          options.onEntries?.(normalizedBatch)
        }
        return normalizedBatch
      }

      const pageEntries: SelfMadeGlossaryEntry[] = []
      const batches = batchCandidates(candidates, LOCAL_DETAIL_BATCH_SIZE)
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const raw = await requestDetailBatchWithFallback(
          settings,
          document,
          batches[batchIndex],
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
          options.onEntries?.(normalizedBatch)
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
      message: `${pass}: pass completed`,
    })
  }

  options.onProgress?.({
    step: 'chunk_done',
    chunkIndex: chunks.length - 1,
    chunkCount: chunks.length,
    pages: [],
    pass: 'assistive_notations',
    message: `local glossary generation completed: ${entries.length} entries`,
  })
  return entries
}

async function generateLocalSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions,
): Promise<SelfMadeGlossaryEntry[]> {
  const concurrency = settings.pdfExtractionParallel ? LOCAL_TWO_STAGE_CONCURRENCY : 1
  return generateTwoStageSelfMadeGlossaryFromPdf(
    settings,
    document,
    options,
    ['formal_terms', 'assistive_notations'],
    true,
    concurrency,
  )
}

export async function generateSelfMadeGlossaryFromPdf(
  settings: AdminSettings,
  document: ExtractedPdfDocument,
  options: GlossaryGenerationOptions = {},
): Promise<SelfMadeGlossaryEntry[]> {
  const useVision = settings.pdfExtractionUseVision
  const isLocal = settings.translationProvider === 'local_openai'
  const maxChars = settings.translationProvider === 'local_openai' ? MAX_LOCAL_CHARS_PER_REQUEST : MAX_CHARS_PER_REQUEST
  const pagesByNumber = new Map(document.pages.map(page => [page.page, page]))
  const entries: SelfMadeGlossaryEntry[] = []
  if (isLocal) return generateLocalSelfMadeGlossaryFromPdf(settings, document, options)
  if (useVision) {
    const concurrency = settings.pdfExtractionParallel ? VISION_TWO_STAGE_CONCURRENCY : 1
    return generateTwoStageSelfMadeGlossaryFromPdf(
      settings,
      document,
      options,
      ['all'],
      false,
      concurrency,
    )
  }

  const chunks = isLocal
    ? document.pages.map(page => [page])
    : chunkPages(document.pages, useVision, maxChars)
  const passes: GlossaryExtractionPass[] = isLocal
    ? ['formal_terms', 'assistive_notations', 'references_and_noise']
    : ['all']

  for (const pass of passes) {
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
      const raw = await requestGlossaryWithFallback(settings, document, pages, useVision, maxChars, i, chunks.length, pass, options.onProgress)
      const normalizedBatch = raw
        .map(entry => normalizeEntry(entry, document, pagesByNumber))
        .filter((entry): entry is SelfMadeGlossaryEntry => Boolean(entry))
      if (normalizedBatch.length > 0) {
        entries.push(...normalizedBatch)
        options.onEntries?.(normalizedBatch)
      }
    }
    options.onProgress?.({
      step: 'chunk_done',
      chunkIndex: chunks.length - 1,
      chunkCount: chunks.length,
      pages: [],
      pass,
      message: `${pass}: pass completed`,
    })
  }

  options.onProgress?.({
    step: 'chunk_done',
    chunkIndex: chunks.length - 1,
    chunkCount: chunks.length,
    pages: [],
    pass: 'all',
    message: `glossary generation completed: ${entries.length} entries`,
  })
  return entries
}
