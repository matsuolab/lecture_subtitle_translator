import { cn } from '@/lib/utils'
import { getCpsLevel, type SubtitleBlock } from '@/types/subtitle'

interface TimelineBlockProps {
  block: SubtitleBlock
  viewStart: number
  visibleDuration: number
  containerWidth: number
  currentTime: number
  isActive: boolean
  onClick: (e?: React.MouseEvent) => void
}

const cpsTrackColors = {
  ok: {
    base: 'bg-[#22C55E]/20 border-[#22C55E]/30 hover:bg-[#22C55E]/30',
    fill: 'bg-[#22C55E]/50',
    active: 'bg-[#22C55E]/30 border-[#22C55E]/60',
  },
  warn: {
    base: 'bg-[#F59E0B]/20 border-[#F59E0B]/30 hover:bg-[#F59E0B]/30',
    fill: 'bg-[#F59E0B]/50',
    active: 'bg-[#F59E0B]/30 border-[#F59E0B]/60',
  },
  error: {
    base: 'bg-[#EF4444]/20 border-[#EF4444]/30 hover:bg-[#EF4444]/30',
    fill: 'bg-[#EF4444]/50',
    active: 'bg-[#EF4444]/30 border-[#EF4444]/60',
  },
}

export function TimelineBlock({
  block,
  viewStart,
  visibleDuration,
  containerWidth,
  currentTime,
  isActive,
  onClick,
}: TimelineBlockProps) {
  const cpsLevel = getCpsLevel(block.cps)
  const colors = cpsTrackColors[cpsLevel]

  const left = visibleDuration > 0
    ? ((block.startTime - viewStart) / visibleDuration) * containerWidth
    : 0
  const width = visibleDuration > 0
    ? Math.max(((block.endTime - block.startTime) / visibleDuration) * containerWidth, 2)
    : 0

  const blockDuration = block.endTime - block.startTime
  const fillProgress = isActive && blockDuration > 0
    ? Math.min(((currentTime - block.startTime) / blockDuration) * 100, 100)
    : 0

  return (
    <div
      className={cn(
        'absolute top-2 bottom-2 rounded border cursor-pointer transition-colors group',
        isActive ? colors.active : colors.base,
      )}
      style={{ left, width: Math.max(width - 2, 2) }}
      onClick={onClick}
      title={`#${block.id}: ${block.source.slice(0, 40)}...`}
    >
      {/* fill animation */}
      {isActive && (
        <div
          className={cn('absolute inset-0 rounded', colors.fill)}
          style={{ width: `${fillProgress}%` }}
        />
      )}

      {/* ブロック番号（幅が十分な場合のみ表示）*/}
      {width > 24 && (
        <span className="absolute inset-0 flex items-center justify-center text-[9px] font-mono text-white/40 select-none pointer-events-none">
          {block.id}
        </span>
      )}
    </div>
  )
}
