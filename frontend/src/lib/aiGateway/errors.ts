import type { AiGatewayContext } from './connection'
import { resolveApiCompatibilityProfile } from './apiCompatibilityProfile'

export function formatAiGatewayHttpError(args: {
  context: AiGatewayContext
  status: number
  detail: string
}): string {
  const raw = args.detail.slice(0, 200)
  if (/context size has been exceeded|context length|maximum context/i.test(args.detail)) {
    const profile = resolveApiCompatibilityProfile(args.context.settings)
    return [
      `http_${args.status}: context_size_exceeded`,
      `apiProfile=${profile.id}`,
      'LM Studio / local OpenAI-compatible server context length is too small for this request.',
      'Increase the loaded model context length, then rerun the pipeline.',
      `raw=${raw}`,
    ].join(' ')
  }
  return `http_${args.status}: ${raw}`
}
