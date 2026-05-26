import fs from 'node:fs'
import path from 'node:path'
import type { ChunkResult, FixtureFile } from './schema.js'
import type { RunLogger } from './logger.js'
import { addUsage, emptyUsage, estimateCost } from './usage.js'

function pct(numerator: number, denominator: number): number {
  if (denominator === 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

function srtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const sec = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  const min = totalMinutes % 60
  const hour = Math.floor(totalMinutes / 60)
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function csvEscape(value: string | number | boolean): string {
  const raw = String(value)
  if (!/[",\r\n]/.test(raw)) return raw
  return `"${raw.replace(/"/g, '""')}"`
}

export function writeReports(logger: RunLogger, fixture: FixtureFile, results: ChunkResult[]): void {
  const totalChunks = results.length
  const acceptedChunks = results.filter((result) => result.status === 'accepted').length
  const manualChunks = results.filter((result) => result.status === 'manual_review').length
  const invalidChunks = results.filter((result) => result.status === 'invalid_output').length
  const cueValidations = results.flatMap((result) => result.cue_validations)
  const totalCues = cueValidations.length
  const compliantCues = cueValidations.filter((validation) => validation.ok).length
  const avgMetric = (name: 'utilization' | 'constraintQualityScore' | 'durationComfortScore' | 'lineFillScore') => {
    if (cueValidations.length === 0) return 0
    return Math.round((cueValidations.reduce((sum, item) => sum + item.metrics[name], 0) / cueValidations.length) * 1000) / 1000
  }
  const issueCounts = new Map<string, number>()
  for (const result of results) {
    for (const issue of result.issues) {
      issueCounts.set(issue.code, (issueCounts.get(issue.code) ?? 0) + 1)
    }
  }
  const tokenUsage = results.reduce((sum, result) => addUsage(sum, result.token_usage), emptyUsage())
  const firstCost = results[0]?.cost_estimate
  const summedCost = results.reduce((sum, result) => sum + (result.cost_estimate.estimated_usd ?? 0), 0)
  const cost = firstCost
    ? {
      ...estimateCost(firstCost.model, tokenUsage),
      estimated_usd: Math.round(summedCost * 1_000_000) / 1_000_000,
      pricing_source: firstCost.pricing_source,
    }
    : null
  const qualityFlags = results.flatMap((result) => result.quality_flags)
  const oneWordRepairs = results.flatMap((result) => result.one_word_repairs)
  const oneWordTargetRepairs = oneWordRepairs.filter((check) => check.target_cue)
  const cueCandidateStats = results.map((result) => result.cue_candidate_stats).filter((item): item is NonNullable<typeof item> => Boolean(item))
  const mergeRewriteStats = results.map((result) => result.merge_rewrite_stats).filter((item): item is NonNullable<typeof item> => Boolean(item))
  const metrics = {
    source: fixture.source,
    chunks: {
      total: totalChunks,
      accepted: acceptedChunks,
      manual_review: manualChunks,
      invalid_output: invalidChunks,
      accepted_rate: pct(acceptedChunks, totalChunks),
      manual_review_rate: pct(manualChunks, totalChunks),
    },
    cues: {
      total: totalCues,
      hard_constraint_pass: compliantCues,
      hard_constraint_pass_rate: pct(compliantCues, totalCues),
      avg_capacity_utilization: avgMetric('utilization'),
      avg_constraint_quality_score: avgMetric('constraintQualityScore'),
      avg_duration_comfort_score: avgMetric('durationComfortScore'),
      avg_line_fill_score: avgMetric('lineFillScore'),
    },
    repair: {
      avg_iterations: totalChunks === 0
        ? 0
        : Math.round((results.reduce((sum, result) => sum + result.repair_iterations, 0) / totalChunks) * 100) / 100,
    },
    model_calls: results.reduce((sum, result) => sum + result.model_calls, 0),
    token_usage: tokenUsage,
    cost_estimate: cost,
    quality_flags: {
      total: qualityFlags.length,
      error: qualityFlags.filter((flag) => flag.severity === 'error').length,
      warning: qualityFlags.filter((flag) => flag.severity === 'warning').length,
      info: qualityFlags.filter((flag) => flag.severity === 'info').length,
    },
    one_word_repairs: {
      checks: oneWordRepairs.length,
      target_checks: oneWordTargetRepairs.length,
      target_passed: oneWordTargetRepairs.filter((check) => check.passed).length,
      target_failed: oneWordTargetRepairs.filter((check) => !check.passed).length,
      passed: oneWordRepairs.filter((check) => check.passed).length,
      failed: oneWordRepairs.filter((check) => !check.passed).length,
    },
    cue_candidates: {
      generated: cueCandidateStats.reduce((sum, item) => sum + item.generated, 0),
      valid: cueCandidateStats.reduce((sum, item) => sum + item.valid, 0),
      selected: cueCandidateStats.reduce((sum, item) => sum + item.selected, 0),
      avg_best_score: cueCandidateStats.length === 0
        ? 0
        : Math.round((cueCandidateStats.reduce((sum, item) => sum + item.best_score, 0) / cueCandidateStats.length) * 1000) / 1000,
      alignment: {
        total_cues: cueCandidateStats.reduce((sum, item) => sum + (item.alignment?.total_cues ?? 0), 0),
        exact: cueCandidateStats.reduce((sum, item) => sum + (item.alignment?.exact ?? 0), 0),
        proportional: cueCandidateStats.reduce((sum, item) => sum + (item.alignment?.proportional ?? 0), 0),
        no_words: cueCandidateStats.reduce((sum, item) => sum + (item.alignment?.no_words ?? 0), 0),
      },
    },
    merge_rewrite: {
      candidates: mergeRewriteStats.reduce((sum, item) => sum + item.candidates, 0),
      attempted: mergeRewriteStats.filter((item) => item.attempted).length,
      accepted: mergeRewriteStats.filter((item) => item.accepted).length,
      before_cues: mergeRewriteStats.reduce((sum, item) => sum + item.before_cues, 0),
      after_cues: mergeRewriteStats.reduce((sum, item) => sum + item.after_cues, 0),
      avg_before_capacity_utilization: mergeRewriteStats.length === 0 ? 0 : Math.round((mergeRewriteStats.reduce((sum, item) => sum + item.before_avg_capacity_utilization, 0) / mergeRewriteStats.length) * 1000) / 1000,
      avg_after_capacity_utilization: mergeRewriteStats.length === 0 ? 0 : Math.round((mergeRewriteStats.reduce((sum, item) => sum + item.after_avg_capacity_utilization, 0) / mergeRewriteStats.length) * 1000) / 1000,
      avg_before_constraint_quality_score: mergeRewriteStats.length === 0 ? 0 : Math.round((mergeRewriteStats.reduce((sum, item) => sum + item.before_avg_constraint_quality_score, 0) / mergeRewriteStats.length) * 1000) / 1000,
      avg_after_constraint_quality_score: mergeRewriteStats.length === 0 ? 0 : Math.round((mergeRewriteStats.reduce((sum, item) => sum + item.after_avg_constraint_quality_score, 0) / mergeRewriteStats.length) * 1000) / 1000,
    },
    issue_counts: Object.fromEntries([...issueCounts.entries()].sort((a, b) => b[1] - a[1])),
  }

  logger.writeJson('reports/metrics.json', metrics)
  const exportRows = results.flatMap((result) => result.plan.cues.map((cue) => {
    const validation = result.cue_validations.find((item) => item.cue_id === cue.cue_id)
    return {
      chunk_id: result.chunk_id,
      chunk_status: result.status,
      cue_id: cue.cue_id,
      start: cue.start,
      end: cue.end,
      duration: Math.round((cue.end - cue.start) * 1000) / 1000,
      cps: validation?.metrics.cps ?? null,
      en_chars: validation?.metrics.enChars ?? null,
      max_line_len: validation?.metrics.maxLineLen ?? null,
      line_count: validation?.metrics.lineCount ?? null,
      capacity_chars: validation?.metrics.capacityChars ?? null,
      target_chars: validation?.metrics.targetChars ?? null,
      min_good_chars: validation?.metrics.minGoodChars ?? null,
      target_words: validation?.metrics.targetWords ?? null,
      utilization: validation?.metrics.utilization ?? null,
      constraint_quality_score: validation?.metrics.constraintQualityScore ?? null,
      cue_ok: validation?.ok ?? false,
      ja_span: cue.ja_span,
      en: cue.en,
      source_segment_ids: cue.source_segment_ids.join(';'),
      strategy: cue.strategy,
    }
  })).sort((a, b) => a.start - b.start || a.end - b.end)
  logger.writeText(
    'exports/final_subtitles.jsonl',
    exportRows.map((row) => JSON.stringify(row)).join('\n') + (exportRows.length ? '\n' : ''),
  )
  logger.writeText(
    'exports/final_subtitles.csv',
    [
      'chunk_id,chunk_status,cue_id,start,end,duration,cps,en_chars,max_line_len,line_count,capacity_chars,target_chars,min_good_chars,target_words,utilization,constraint_quality_score,cue_ok,ja_span,en,source_segment_ids,strategy',
      ...exportRows.map((row) => [
        row.chunk_id,
        row.chunk_status,
        row.cue_id,
        row.start,
        row.end,
        row.duration,
        row.cps ?? '',
        row.en_chars ?? '',
        row.max_line_len ?? '',
        row.line_count ?? '',
        row.capacity_chars ?? '',
        row.target_chars ?? '',
        row.min_good_chars ?? '',
        row.target_words ?? '',
        row.utilization ?? '',
        row.constraint_quality_score ?? '',
        row.cue_ok,
        row.ja_span,
        row.en,
        row.source_segment_ids,
        row.strategy,
      ].map(csvEscape).join(',')),
    ].join('\n') + '\n',
  )
  logger.writeText(
    'exports/final_subtitles.srt',
    exportRows.map((row, index) => [
      String(index + 1),
      `${srtTimestamp(row.start)} --> ${srtTimestamp(row.end)}`,
      row.en,
    ].join('\n')).join('\n\n') + (exportRows.length ? '\n' : ''),
  )
  const issueLines = Object.entries(metrics.issue_counts)
    .map(([code, count]) => `| ${code} | ${count} |`)
    .join('\n') || '| none | 0 |'
  const chunkLines = results
    .map((result) => `| ${result.chunk_id} | ${result.status} | ${result.plan.cues.length} | ${result.issues.filter((issue) => issue.severity === 'error').length} | ${result.repair_iterations} |`)
    .join('\n')
  const md = `# Hierarchical Subtitle Planner PoC Report

> run_id: ${logger.runId}

## Summary

| Metric | Value |
|---|---:|
| Chunks | ${metrics.chunks.total} |
| Accepted chunks | ${metrics.chunks.accepted} (${metrics.chunks.accepted_rate}%) |
| Manual review chunks | ${metrics.chunks.manual_review} (${metrics.chunks.manual_review_rate}%) |
| Invalid output chunks | ${metrics.chunks.invalid_output} |
| Cues | ${metrics.cues.total} |
| Hard constraint pass rate | ${metrics.cues.hard_constraint_pass_rate}% |
| Avg capacity utilization | ${metrics.cues.avg_capacity_utilization} |
| Avg constraint quality score | ${metrics.cues.avg_constraint_quality_score} |
| Avg duration comfort score | ${metrics.cues.avg_duration_comfort_score} |
| Avg line fill score | ${metrics.cues.avg_line_fill_score} |
| Avg repair iterations | ${metrics.repair.avg_iterations} |
| Model calls | ${metrics.model_calls} |
| Input tokens | ${metrics.token_usage.input_tokens} |
| Cached input tokens | ${metrics.token_usage.cached_input_tokens} |
| Output tokens | ${metrics.token_usage.output_tokens} |
| Estimated cost USD | ${metrics.cost_estimate?.estimated_usd ?? 'n/a'} |
| Quality flags | ${metrics.quality_flags.total} |
| One-word repair checks | ${metrics.one_word_repairs.passed}/${metrics.one_word_repairs.checks} passed |
| Cue structure candidates | ${metrics.cue_candidates.generated} generated / ${metrics.cue_candidates.valid} valid / ${metrics.cue_candidates.selected} selected |
| Avg best cue candidate score | ${metrics.cue_candidates.avg_best_score} |
| Cue candidate alignment | ${metrics.cue_candidates.alignment.exact} exact / ${metrics.cue_candidates.alignment.proportional} proportional / ${metrics.cue_candidates.alignment.no_words} no_words |
| Merge rewrite | ${metrics.merge_rewrite.accepted}/${metrics.merge_rewrite.attempted} accepted, ${metrics.merge_rewrite.candidates} candidates |
| Merge rewrite utilization | ${metrics.merge_rewrite.avg_before_capacity_utilization} -> ${metrics.merge_rewrite.avg_after_capacity_utilization} |
| Merge rewrite quality score | ${metrics.merge_rewrite.avg_before_constraint_quality_score} -> ${metrics.merge_rewrite.avg_after_constraint_quality_score} |

Semantic similarity is intentionally excluded from the acceptance score in this run.
Cost is estimated from response token usage. Pricing source: ${metrics.cost_estimate?.pricing_source ?? 'n/a'}.

## Exported Subtitles

| File | Purpose |
|---|---|
| \`exports/final_subtitles.srt\` | English subtitle preview/import |
| \`exports/final_subtitles.csv\` | Spreadsheet review with CPS and pass/fail |
| \`exports/final_subtitles.jsonl\` | Analysis-friendly cue records |

## Quality Flags

| Severity | Count |
|---|---:|
| error | ${metrics.quality_flags.error} |
| warning | ${metrics.quality_flags.warning} |
| info | ${metrics.quality_flags.info} |

## One-Word Repair Checks

| Metric | Value |
|---|---:|
| checks | ${metrics.one_word_repairs.checks} |
| target checks | ${metrics.one_word_repairs.target_checks} |
| target passed | ${metrics.one_word_repairs.target_passed} |
| target failed | ${metrics.one_word_repairs.target_failed} |
| passed | ${metrics.one_word_repairs.passed} |
| failed | ${metrics.one_word_repairs.failed} |

## Issue Counts

| Issue | Count |
|---|---:|
${issueLines}

## Chunk Results

| Chunk | Status | Cues | Error issues | Repair iterations |
|---|---|---:|---:|---:|
${chunkLines}
`
  logger.writeText('reports/summary.md', md)
  fs.writeFileSync(path.join(logger.baseDir, 'run-result.txt'), `summary=${path.join(logger.baseDir, 'reports', 'summary.md')}\n`, 'utf8')
}
