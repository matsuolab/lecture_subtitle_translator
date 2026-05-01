import type { AdminSettings } from '@/types/adminSettings'
import type { EnBlock, JaBlock, PipelineThresholds } from './blockTypes'
import { checkCpsViolations } from './checkCpsViolations'
import { formatLines } from './formatLines'
import { translateEn } from './translateEn'

type RunNode = <T>(nodeId: string, run: () => Promise<T> | T) => Promise<T>

export async function runPhase2(
  jaBlocks: JaBlock[],
  settings: AdminSettings,
  thresholds: PipelineThresholds,
  runNode: RunNode,
): Promise<EnBlock[]> {
  const translated = await runNode('translateEn', () => translateEn(jaBlocks, settings))
  const formatted = await runNode('formatLines', () => formatLines(translated, thresholds))
  return await runNode('checkCpsViolations', () => checkCpsViolations(formatted, thresholds))
}
