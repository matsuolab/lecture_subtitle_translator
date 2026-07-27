import type { AdminSettings } from '@/types/adminSettings'
import { chatText, type ChatTextOptions } from './chatText'
import { chatVision, type ChatVisionOptions } from './chatVision'
import { createAiGatewayContext, type AiGatewayOptions } from './connection'
import { embeddings, type EmbeddingsOptions } from './embeddings'
import { probeAll } from './probe'

export function createAiGateway(settings: AdminSettings, options: AiGatewayOptions = {}) {
  const context = createAiGatewayContext(settings, options)
  return {
    chatText: (chatOptions: ChatTextOptions) => chatText(context, chatOptions),
    chatVision: (visionOptions: ChatVisionOptions) => chatVision(context, visionOptions),
    embeddings: (embeddingOptions: EmbeddingsOptions) => embeddings(context, embeddingOptions),
    probeAll: () => probeAll(context),
  }
}

export type { AiGatewayOptions } from './connection'
export type { ChatTextContent, ChatTextMessage, ChatTextOptions, ChatTextResult, LlmErrorCode } from './chatText'
export type { ChatVisionOptions } from './chatVision'
export type { EmbeddingsOptions } from './embeddings'
export type { AiGatewayProbeName, AiGatewayProbeResult, AiGatewayProbeStatus } from './probe'
export type { JsonSchemaSpec } from './apiCompatibilityProfile'
export { buildLlmFailureCode } from './errors'
