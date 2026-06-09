import { describe, expect, it } from 'vitest'
import { getDefaultAdminSettings } from '@/api/adminSettings'
import { createAiGateway } from './index'

declare const process: { env: Record<string, string | undefined> }

const shouldRun = process.env.RUN_OPENAI_SMOKE === '1' && Boolean(process.env.OPENAI_API_KEY?.trim())

describe.skipIf(!shouldRun)('AI Gateway OpenAI smoke test', () => {
  it('passes connection, chat text, embeddings, and chat vision probes against the real OpenAI API', async () => {
    const base = getDefaultAdminSettings()
    const settings = {
      ...base,
      translationProvider: 'openai' as const,
      openaiApiKey: process.env.OPENAI_API_KEY?.trim() ?? '',
      openaiCompatibleBaseUrl: process.env.OPENAI_BASE_URL?.trim() ?? '',
      translationModel: process.env.OPENAI_CHAT_MODEL?.trim() || base.translationModel,
      pdfExtractionVisionModel: process.env.OPENAI_VISION_MODEL?.trim() || base.pdfExtractionVisionModel,
      embeddingModel: process.env.OPENAI_EMBEDDING_MODEL?.trim() || base.embeddingModel,
    }

    const results = await createAiGateway(settings, { fetch: globalThis.fetch }).probeAll()

    expect(results).toEqual([
      expect.objectContaining({ name: 'Connection', status: 'success' }),
      expect.objectContaining({ name: 'Chat Text', status: 'success' }),
      expect.objectContaining({ name: 'Embeddings', status: 'success' }),
      expect.objectContaining({ name: 'Chat Vision', status: 'success' }),
    ])
  }, 60_000)
})
