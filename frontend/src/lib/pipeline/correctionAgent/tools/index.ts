import type { CorrectionStrategy, Tool } from '../types'
import { compressMicroTool } from './compressMicro'
import { compressRephraseTool } from './compressRephrase'
import { compressTrimTool } from './compressTrim'
import { compressCoreTool } from './compressCore'
import { splitBlockTool } from './splitBlock'
import { borrowGapTool } from './borrowGap'
import { offloadNeighborTool } from './offloadNeighbor'

export const toolRegistry: Record<CorrectionStrategy, Tool> = {
  compress_micro: compressMicroTool,
  compress_rephrase: compressRephraseTool,
  compress_trim: compressTrimTool,
  compress_core: compressCoreTool,
  split_block: splitBlockTool,
  borrow_gap: borrowGapTool,
  offload_neighbor: offloadNeighborTool,
}
