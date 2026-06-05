import type { AdminSettings } from '@/types/adminSettings'
import { requireAiConnection, type AiConnection } from '@/lib/pipeline/aiProvider'
import { tauriFetch, type TauriFetchOptions, type TauriFetchResponse } from '@/lib/tauriFetch'

export type AiGatewayFetch = (
  input: string,
  init?: TauriFetchOptions,
) => Promise<Response | TauriFetchResponse>

export interface AiGatewayOptions {
  fetch?: AiGatewayFetch
}

export interface AiGatewayContext {
  settings: AdminSettings
  fetch: AiGatewayFetch
}

export function createAiGatewayContext(
  settings: AdminSettings,
  options: AiGatewayOptions = {},
): AiGatewayContext {
  return {
    settings,
    fetch: options.fetch ?? tauriFetch,
  }
}

export function requireGatewayConnection(
  context: AiGatewayContext,
  purpose: string,
): AiConnection {
  return requireAiConnection(context.settings, purpose)
}
