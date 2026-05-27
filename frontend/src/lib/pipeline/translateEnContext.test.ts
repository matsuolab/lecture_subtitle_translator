import { describe, expect, it } from 'vitest'
import { __testing } from './translateEn'

describe('translateEn context payload', () => {
  it('passes context groups as reference-only metadata alongside cue segments', () => {
    const payload = __testing.buildTranslationUserPayload([
      {
        text: '今回の目的としては、',
        start: 0,
        end: 2,
        contextGroupId: 'cg-1-2',
        contextGroupText: '今回の目的としては、 最適化を理解することです。',
        contextGroupRole: 'lead',
        contextGroupIndex: 0,
        contextGroupSize: 2,
        contextGroupReason: 'incomplete_end_context_group',
      },
      {
        text: '最適化を理解することです。',
        start: 2,
        end: 5,
        contextGroupId: 'cg-1-2',
        contextGroupText: '今回の目的としては、 最適化を理解することです。',
        contextGroupRole: 'tail',
        contextGroupIndex: 1,
        contextGroupSize: 2,
        contextGroupReason: 'incomplete_end_context_group',
      },
    ])

    expect(payload.segments).toEqual(['今回の目的としては、', '最適化を理解することです。'])
    expect(payload.context_groups).toEqual([
      {
        id: 'cg-1-2',
        text: '今回の目的としては、 最適化を理解することです。',
        item_indices: [0, 1],
        roles: ['lead', 'tail'],
      },
    ])
  })

  it('builds group-allocation payloads only for incomplete multi-cue groups', () => {
    const drafts = __testing.buildContextGroupTranslationDrafts([
      {
        text: 'それを防ぐために、',
        start: 0,
        end: 3,
        contextGroupId: 'cg-1-2',
        contextGroupText: 'それを防ぐために、 L2正則化を使います。',
        contextGroupRole: 'lead',
        contextGroupIndex: 0,
        contextGroupSize: 2,
        contextGroupReason: 'incomplete_end_context_group',
      },
      {
        text: 'L2正則化を使います。',
        start: 3,
        end: 6,
        contextGroupId: 'cg-1-2',
        contextGroupText: 'それを防ぐために、 L2正則化を使います。',
        contextGroupRole: 'tail',
        contextGroupIndex: 1,
        contextGroupSize: 2,
        contextGroupReason: 'incomplete_end_context_group',
      },
      {
        text: '単独です。',
        start: 6,
        end: 8,
        contextGroupId: 'cg-3',
        contextGroupText: '単独です。',
        contextGroupRole: 'single',
        contextGroupIndex: 0,
        contextGroupSize: 1,
        contextGroupReason: 'single_cue_context_group',
      },
    ])

    expect(drafts).toHaveLength(1)
    expect(__testing.buildContextGroupTranslationPayload(drafts)).toEqual({
      context_groups: [
        {
          id: 'cg-1-2',
          text: 'それを防ぐために、 L2正則化を使います。',
          items: [
            {
              index: 0,
              text: 'それを防ぐために、',
              role: 'lead',
              duration_sec: 3,
            },
            {
              index: 1,
              text: 'L2正則化を使います。',
              role: 'tail',
              duration_sec: 3,
            },
          ],
        },
      ],
    })
  })
})
