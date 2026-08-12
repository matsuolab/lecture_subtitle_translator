import { describe, expect, it } from 'vitest'

import { compareSplitTimingPolicies, measureSplitTimingDrift } from './splitTimingDiagnostics'
import type { TranscriptSegment } from './types'

declare const require: (id: string) => { readFileSync: (path: string, encoding: string) => string }
declare const process: { cwd: () => string }
const { readFileSync } = require('fs')

function loadWhisperXFixture(): TranscriptSegment[] {
  const path = `${process.cwd()}/src/lib/pipeline/__fixtures__/asrAlignment.seg6seg7.json`
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { segments: TranscriptSegment[] }
  return parsed.segments
}

describe('measureSplitTimingDrift', () => {
  it('英語文字数比で前倒しされた分割境界をWhisperXの発話境界との差として測る', () => {
    const segments: TranscriptSegment[] = [
      {
        id: 1,
        start: 0,
        end: 4,
        text: '前半です後半です',
        words: Array.from('前半です後半です').map((word, index) => ({
          word,
          start: index * 0.5,
          end: (index + 1) * 0.5,
          score: 1,
        })),
      },
    ]

    const report = measureSplitTimingDrift({
      transcriptSegments: segments,
      cues: [
        { id: 10, start: 0, end: 1, transcriptText: '前半です' },
        { id: 10002, start: 1.08, end: 4, transcriptText: '後半です' },
      ],
      splitGroups: [{ sourceBlockId: 10, cueIds: [10, 10002] }],
    })

    expect(report.groupCount).toBe(1)
    expect(report.boundaryCount).toBe(1)
    expect(report.resolvableBoundaryCount).toBe(1)
    expect(report.boundaries[0]).toEqual(expect.objectContaining({
      sourceBlockId: 10,
      leftCueId: 10,
      rightCueId: 10002,
      assignedBoundarySec: 1.04,
      spokenBoundarySec: 2,
      deltaSec: -0.96,
      absDeltaSec: 0.96,
      assignedLeftEndSec: 1,
      assignedRightStartSec: 1.08,
      spokenLeftEndSec: 2,
      spokenRightStartSec: 2,
      leftEndDeltaSec: -1,
      rightStartDeltaSec: -0.92,
      resolvable: true,
    }))
    expect(report.overThresholdSec).toEqual({
      '0.3': 1,
      '0.5': 1,
      '1': 0,
    })
  })

  it('保存済みWhisperX実出力でも日本語unitの発話境界を復元できる', () => {
    const report = measureSplitTimingDrift({
      transcriptSegments: loadWhisperXFixture(),
      cues: [
        {
          id: 20,
          start: 163.688,
          end: 168.443,
          transcriptText: '松尾研講座の継続受講や実践経験を積めます。',
        },
        {
          id: 20002,
          start: 168.523,
          end: 173.553,
          transcriptText: '企業との共同研究プロジェクトやインターンもあります。',
        },
      ],
      splitGroups: [{ sourceBlockId: 20, cueIds: [20, 20002] }],
    })

    expect(report.resolvableBoundaryCount).toBe(1)
    expect(report.boundaries[0].leftConfidence).toBe('exact')
    expect(report.boundaries[0].rightConfidence).toBe('partial')
    expect(report.boundaries[0].spokenBoundarySec).toBeCloseTo(168.09, 2)
    expect(report.boundaries[0].deltaSec).toBeCloseTo(0.393, 2)
  })

  it('同じ発話が離れた位置に反復しても親cueの時間区間内へ対応する', () => {
    const repeated = '前半です後半です'
    const toWords = (offset: number) => Array.from(repeated).map((word, index) => ({
      word,
      start: offset + index * 0.5,
      end: offset + (index + 1) * 0.5,
      score: 1,
    }))
    const report = measureSplitTimingDrift({
      transcriptSegments: [
        { id: 1, start: 0, end: 4, text: repeated, words: toWords(0) },
        { id: 2, start: 100, end: 104, text: repeated, words: toWords(100) },
      ],
      cues: [
        { id: 30, start: 100, end: 101, transcriptText: '前半です' },
        { id: 30002, start: 101.08, end: 104, transcriptText: '後半です' },
      ],
      splitGroups: [{ sourceBlockId: 30, cueIds: [30, 30002] }],
    })

    expect(report.boundaries[0].spokenBoundarySec).toBe(102)
    expect(report.boundaries[0].deltaSec).toBe(-0.96)
  })

  it('WhisperXに対応できないunitは時刻差を推測せず観測不能にする', () => {
    const report = measureSplitTimingDrift({
      transcriptSegments: [{
        id: 1,
        start: 0,
        end: 1,
        text: '元音声',
        words: [{ word: '元音声', start: 0, end: 1, score: 1 }],
      }],
      cues: [
        { id: 40, start: 0, end: 0.4, transcriptText: '一致しない長い文章です' },
        { id: 40002, start: 0.48, end: 1, transcriptText: 'こちらも対応できません' },
      ],
      splitGroups: [{ sourceBlockId: 40, cueIds: [40, 40002] }],
    })

    expect(report.resolvableBoundaryCount).toBe(0)
    expect(report.boundaries[0]).toEqual(expect.objectContaining({
      resolvable: false,
      spokenBoundarySec: null,
      deltaSec: null,
      absDeltaSec: null,
    }))
  })
})

describe('compareSplitTimingPolicies', () => {
  it('cue順序とASR境界順序が壊れた入力を並べ替えて隠さず拒否する', () => {
    expect(() => compareSplitTimingPolicies({
      cues: [
        { id: 2, start: 3, end: 6, enChars: 20 },
        { id: 1, start: 0, end: 3, enChars: 20 },
      ],
      spokenBoundarySec: [3],
      gapSec: 0.08,
      minDurationSec: 1.5,
      maxCps: 17,
    })).toThrow('cues must be valid and ordered')

    expect(() => compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 3, enChars: 20 },
        { id: 2, start: 3.08, end: 6, enChars: 20 },
        { id: 3, start: 6.08, end: 10, enChars: 20 },
      ],
      spokenBoundarySec: [5, 4],
      spokenBoundaryEdges: [
        { leftEndSec: 5, rightStartSec: 5 },
        { leftEndSec: 4, rightStartSec: 4 },
      ],
      gapSec: 0.08,
      minDurationSec: 1.5,
      maxCps: 17,
    })).toThrow('spokenBoundaryEdges must be monotonic')
  })

  it('ASR境界でCPS違反する場合はCPSと最低表示時間を守る最寄り境界へ制約する', () => {
    const result = compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 4, enChars: 51 },
        { id: 1002, start: 4.08, end: 8, enChars: 34 },
      ],
      spokenBoundarySec: [2],
      gapSec: 0.08,
      minDurationSec: 1.5,
      maxCps: 17,
    })

    expect(result.feasible).toBe(true)
    expect(result.speechAnchored.cues[0].cps).toBeGreaterThan(17)
    expect(result.constrained.cues[0]).toEqual(expect.objectContaining({
      start: 0,
      end: 3,
      duration: 3,
      cps: 17,
    }))
    expect(result.constrained.cues[1].start).toBe(3.08)
    expect(result.constrained.maxBoundaryAbsDeltaSec).toBe(1.08)
    expect(result.constrained.cpsViolationCount).toBe(0)
    expect(result.constrained.minDurationViolationCount).toBe(0)
  })

  it('総尺が読了必要時間より短い場合は無理に境界を作らずinfeasibleを返す', () => {
    const result = compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 1, enChars: 50 },
        { id: 1002, start: 1.08, end: 2, enChars: 50 },
      ],
      spokenBoundarySec: [1],
      gapSec: 0.08,
      minDurationSec: 1.5,
      maxCps: 17,
    })

    expect(result.feasible).toBe(false)
    expect(result.constrained.cues).toEqual([])
  })

  it('0.5秒を超えるASR無音は閉じずに子cue間へ保持する', () => {
    const result = compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 3, enChars: 20 },
        { id: 1002, start: 3.08, end: 7, enChars: 20 },
      ],
      spokenBoundarySec: [3.5],
      spokenBoundaryEdges: [{ leftEndSec: 3, rightStartSec: 4 }],
      gapSec: 0.08,
      maxClosableGapSec: 0.5,
      minDurationSec: 1.5,
      maxCps: 17,
    })

    expect(result.feasible).toBe(true)
    expect(result.constrained.cues[0].end).toBe(3)
    expect(result.constrained.cues[1].start).toBe(4)
    expect(result.constrained.maxBoundaryAbsDeltaSec).toBe(0)
  })

  it('短いASR gapは次cueの発話開始を保ち、前cue側だけを延長する', () => {
    const result = compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 3, enChars: 20 },
        { id: 1002, start: 3.08, end: 7, enChars: 20 },
      ],
      spokenBoundarySec: [3.2],
      spokenBoundaryEdges: [{ leftEndSec: 3, rightStartSec: 3.4 }],
      gapSec: 0.08,
      maxClosableGapSec: 0.5,
      minDurationSec: 1.5,
      maxCps: 17,
    })

    expect(result.constrained.cues[0].end).toBe(3.32)
    expect(result.constrained.cues[1].start).toBe(3.4)
    expect(result.constrained.maxBoundaryAbsDeltaSec).toBe(0.32)
  })

  it('3分割でも各gapとCPS制約を保ったまま境界を時系列順に投影する', () => {
    const result = compareSplitTimingPolicies({
      cues: [
        { id: 1, start: 0, end: 3, enChars: 34 },
        { id: 1002, start: 3.08, end: 6, enChars: 51 },
        { id: 1003, start: 6.08, end: 10, enChars: 34 },
      ],
      spokenBoundarySec: [2, 7],
      spokenBoundaryEdges: [
        { leftEndSec: 2, rightStartSec: 2 },
        { leftEndSec: 6.6, rightStartSec: 7.4 },
      ],
      gapSec: 0.08,
      maxClosableGapSec: 0.5,
      minDurationSec: 1.5,
      maxCps: 17,
    })

    expect(result.feasible).toBe(true)
    expect(result.constrained.cpsViolationCount).toBe(0)
    expect(result.constrained.minDurationViolationCount).toBe(0)
    expect(result.constrained.cues[1].start - result.constrained.cues[0].end).toBeCloseTo(0.08, 3)
    expect(result.constrained.cues[2].start - result.constrained.cues[1].end).toBeCloseTo(0.8, 3)
  })
})
