import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import type { AdminSettings } from '@/types/adminSettings'
import type { ChatTextOptions, ChatTextResult, ChatVisionOptions } from '@/lib/aiGateway'
import type { ExtractedPdfDocument } from './pdfExtractor'

// createAiGateway をまるごとモックし、gateway.chatText / gateway.chatVision の
// レスポンスを完全に制御する。chatText.test.ts 等が使う `fetch` 差し替え方式は
// documentGlossaryGenerator.ts が createAiGateway(settings) を内部で構築して
// いて fetch 差し替えの余地が無いため使えない。gateway 自体を差し替えることで
// HTTP/JSON レイヤーを気にせず finish_reason / errorCode の組み合わせだけに
// 集中してテストできる。
const { chatTextMock, chatVisionMock } = vi.hoisted(() => ({
  chatTextMock: vi.fn<(options: ChatTextOptions) => Promise<ChatTextResult>>(),
  chatVisionMock: vi.fn<(options: ChatVisionOptions) => Promise<ChatTextResult>>(),
}))

vi.mock('@/lib/aiGateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/aiGateway')>()
  return {
    ...actual,
    createAiGateway: () => ({
      chatText: chatTextMock,
      chatVision: chatVisionMock,
      embeddings: vi.fn(),
      probeAll: vi.fn(),
    }),
  }
})

const { generateSelfMadeGlossaryFromPdf } = await import('./documentGlossaryGenerator')

function settings(overrides: Partial<AdminSettings> = {}): AdminSettings {
  return {
    ...getDefaultAdminSettings(),
    translationProvider: 'local_openai',
    openaiCompatibleBaseUrl: 'http://127.0.0.1:1234/v1',
    pdfExtractionUseVision: false,
    ...overrides,
  }
}

function makeDocument(pageCount: number): ExtractedPdfDocument {
  const pages = Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1
    return {
      page,
      text: `Physical AI lecture page ${page}. Term${page} appears here as a key concept.`,
      urls: [],
    }
  })
  return {
    source: { id: 'doc-1', kind: 'pdf' as const, name: 'lecture.pdf', importedAt: new Date().toISOString() },
    pages,
  }
}

function ok(content: string): ChatTextResult {
  return { content, finishReason: 'stop' }
}

function truncated(content: string): ChatTextResult {
  return {
    content,
    finishReason: 'length',
    errorMessage: `truncated_at_length_limit (content_preview=${content.slice(0, 80)})`,
    errorCode: 'truncated',
  }
}

function httpError(message: string): ChatTextResult {
  return { content: '', errorMessage: message, errorCode: 'http_error' }
}

function themeJson(): string {
  return JSON.stringify({ subject: 'Physical AI', domain: 'Robotics', keyConcepts: ['Physical AI'] })
}

function candidatesJson(items: Array<{
  text: string
  page: number
  category?: string
  en?: string
  formula?: string
  displayText?: string
}>): string {
  return JSON.stringify({
    candidates: items.map(item => ({
      text: item.text,
      category: item.category ?? 'term',
      llmClaimedSource: 'document_text',
      page: item.page,
      snippet: 'snippet',
      ja: '',
      en: item.en ?? item.text,
      formula: item.formula ?? '',
      displayText: item.displayText ?? '',
    })),
  })
}

function isThemeCall(options: ChatTextOptions | ChatVisionOptions): boolean {
  return options.nodeName === 'Glossary document theme API'
}

beforeEach(() => {
  chatTextMock.mockReset()
  chatVisionMock.mockReset()
})

describe('generateSelfMadeGlossaryFromPdf resilience to truncated (length-limited) responses', () => {
  it('does not let a single truncated, unrescuable page abort the whole job (regression for the production incident)', async () => {
    // 本番事故の再現: 124ページ中1ページ (ここでは5ページ中の3ページ目) が
    // finish_reason=length で切り詰められ、救済も再試行後の救済も失敗しても、
    // ジョブ全体が0件保存で落ちてはいけない。他ページの候補は生き残ること。
    const document = makeDocument(5)
    let page3Calls = 0

    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      const match = options.nodeName.match(/pages (\d+)$/)
      const page = match ? Number(match[1]) : null
      if (page === 3) {
        page3Calls += 1
        // 最初の要素すら完成しないまま切れており、部分パース救済も不可能。
        return truncated('{"candidates":[{"text":"Unfinished')
      }
      if (page) {
        return ok(candidatesJson([{ text: `Term${page}`, page }]))
      }
      throw new Error(`unexpected nodeName: ${options.nodeName}`)
    })

    const progressMessages: string[] = []
    const entries = await generateSelfMadeGlossaryFromPdf(settings(), document, {
      onProgress: event => progressMessages.push(event.message),
    })

    expect(entries.map(entry => entry.en).sort()).toEqual(['Term1', 'Term2', 'Term4', 'Term5'])
    // 初回 + リトライ1回のみ (無限リトライしない)
    expect(page3Calls).toBe(2)
    expect(progressMessages.some(message => message.includes('skipped after retry still truncated (pages 3)'))).toBe(true)
  })

  it('rescues complete candidates from a truncated response without needing a retry', async () => {
    const document = makeDocument(1)
    let candidateCalls = 0
    const truncatedContent = '{"candidates":['
      + '{"text":"Physical AI","category":"term","llmClaimedSource":"document_text","page":1,'
      + '"snippet":"s","ja":"","en":"Physical AI","formula":"","displayText":""},'
      + '{"text":"Deep Lea'

    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      candidateCalls += 1
      return truncated(truncatedContent)
    })

    const entries = await generateSelfMadeGlossaryFromPdf(settings(), document, {})

    expect(entries).toHaveLength(1)
    expect(entries[0].en).toBe('Physical AI')
    expect(candidateCalls).toBe(1)
  })

  it('retries once with a doubled output limit when truncation cannot be rescued, then succeeds', async () => {
    const document = makeDocument(1)
    const calls: ChatTextOptions[] = []

    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      calls.push(options)
      if (calls.length === 1) {
        // 最初の要素すら完成しないまま切れており救済不能 -> リトライを誘発する。
        return truncated('{"candidates":[{"text":"Unfin')
      }
      return ok(candidatesJson([{ text: 'Physical AI', page: 1 }]))
    })

    const entries = await generateSelfMadeGlossaryFromPdf(settings(), document, {})

    expect(entries).toHaveLength(1)
    expect(entries[0].en).toBe('Physical AI')
    // リトライは1回だけ (=2回目の呼び出しで終わる。3回目は発生しない)
    expect(calls).toHaveLength(2)
    // glossaryMaxOutputTokens のデフォルトは 4096。translationModel が既定値
    // (gemma/qwen を含まない) の場合 withReasoningHeadroom は素通しなので、
    // 希望値の倍加がそのままリクエスト値の倍加として観測できる。
    expect(calls[0].maxTokens).toBe(4096)
    expect(calls[1].maxTokens).toBe(8192)
  })

  it('splits a length-limited detail batch (errorCode=truncated) into halves and retries — regression for the previously dead code path', async () => {
    // requestDetailBatchWithFallback の半分割リトライは、切り詰めが例外として
    // 投げられていた間はデッドコードだった (finishReason==='length' 分岐に
    // 到達できなかったため)。ここでは errorCode='truncated' が実際に
    // isLengthLimitError() を経由して分割リトライを起動することを確認する。
    const document = makeDocument(1)
    const detailCalls: ChatTextOptions[] = []
    let detailCallCount = 0

    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      if (options.nodeName.includes('candidate extraction')) {
        return ok(candidatesJson([{ text: 'Alpha', page: 1 }, { text: 'Beta', page: 1 }]))
      }
      if (options.nodeName.includes('detail generation')) {
        detailCalls.push(options)
        detailCallCount += 1
        if (detailCallCount === 1) {
          // 2 候補分の詳細展開が丸ごと切り詰められた想定。
          return truncated('{"entries":[{"category":"term"')
        }
        // 分割後、1 候補ずつの詳細展開はそれぞれ成功する。
        return ok(JSON.stringify({
          entries: [{
            category: 'term',
            llmClaimedSource: 'document_text',
            ja: '',
            jaSource: 'missing',
            en: `Entry${detailCallCount}`,
            enSource: 'llm_translation',
            abbr: '',
            formula: '',
            latex: '',
            displayText: '',
            evidence: [{ page: 1, snippet: 's' }],
          }],
        }))
      }
      throw new Error(`unexpected nodeName: ${options.nodeName}`)
    })

    const entries = await generateSelfMadeGlossaryFromPdf(
      settings({ translationProvider: 'openai', pdfExtractionUseVision: false }),
      document,
      {},
    )

    // 初回 (失敗・切り詰め) + 分割後の2回 = 3回
    expect(detailCallCount).toBe(3)
    expect(entries).toHaveLength(2)
    expect(detailCalls.every(call => call.jsonSchema?.name === 'glossary_entries')).toBe(true)
  })

  it('continues the whole pipeline when theme extraction fails (non-regression)', async () => {
    const document = makeDocument(1)
    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return httpError('http_error: theme boom')
      return ok(candidatesJson([{ text: 'Physical AI', page: 1 }]))
    })

    const progressMessages: string[] = []
    const entries = await generateSelfMadeGlossaryFromPdf(settings(), document, {
      onProgress: event => progressMessages.push(event.message),
    })

    expect(entries).toHaveLength(1)
    expect(progressMessages.some(message => message.includes('theme extraction failed'))).toBe(true)
  })
})

describe('generateSelfMadeGlossaryFromPdf JSON Schema (Structured Outputs) wiring', () => {
  it('sends the glossary_document_theme schema for theme extraction', async () => {
    const document = makeDocument(1)
    const themeCalls: ChatTextOptions[] = []
    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) {
        themeCalls.push(options)
        return ok(themeJson())
      }
      return ok(candidatesJson([{ text: 'Physical AI', page: 1 }]))
    })

    await generateSelfMadeGlossaryFromPdf(settings(), document, {})

    expect(themeCalls).toHaveLength(1)
    expect(themeCalls[0].jsonSchema?.name).toBe('glossary_document_theme')
    expect(themeCalls[0].jsonSchema?.schema).toMatchObject({
      required: ['subject', 'domain', 'keyConcepts'],
    })
  })

  it('sends the glossary_candidates schema for candidate extraction', async () => {
    const document = makeDocument(1)
    const candidateCalls: ChatTextOptions[] = []
    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      candidateCalls.push(options)
      return ok(candidatesJson([{ text: 'Physical AI', page: 1 }]))
    })

    await generateSelfMadeGlossaryFromPdf(settings(), document, {})

    expect(candidateCalls.length).toBeGreaterThan(0)
    expect(candidateCalls[0].jsonSchema?.name).toBe('glossary_candidates')
  })

  it('sends the glossary_candidates and glossary_formula_review schemas over chatVision for the vision path', async () => {
    const document: ExtractedPdfDocument = {
      source: { id: 'doc-vision', kind: 'pdf', name: 'vision.pdf', importedAt: new Date().toISOString() },
      pages: [{ page: 1, text: 'theta^(t+1) formula page', urls: [], imageDataUrl: 'data:image/png;base64,AAAA' }],
    }
    const visionCalls: ChatVisionOptions[] = []

    chatTextMock.mockImplementation(async (options) => {
      if (isThemeCall(options)) return ok(themeJson())
      throw new Error(`unexpected chatText call: ${options.nodeName}`)
    })
    chatVisionMock.mockImplementation(async (options) => {
      visionCalls.push(options)
      if (options.nodeName.includes('candidate extraction')) {
        return ok(candidatesJson([{ text: 'x^2', page: 1, category: 'formula', formula: 'x^2', displayText: 'x^2' }]))
      }
      if (options.nodeName.includes('formula mini review')) {
        return ok(JSON.stringify({ formulas: [] }))
      }
      throw new Error(`unexpected chatVision call: ${options.nodeName}`)
    })

    await generateSelfMadeGlossaryFromPdf(settings({ pdfExtractionUseVision: true }), document, {})

    const candidateCall = visionCalls.find(call => call.nodeName.includes('candidate extraction'))
    const formulaCall = visionCalls.find(call => call.nodeName.includes('formula mini review'))
    expect(candidateCall?.jsonSchema?.name).toBe('glossary_candidates')
    expect(formulaCall?.jsonSchema?.name).toBe('glossary_formula_review')
  })
})
