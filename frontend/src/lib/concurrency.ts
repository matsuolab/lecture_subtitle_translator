export function normalizeConcurrency(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : parseFloat(value as string)
  if (!isFinite(n)) return fallback
  return Math.max(1, Math.trunc(n))
}

export async function mapWithConcurrency<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = []
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(normalizeConcurrency(concurrency, 1), count))

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < count) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await run(index)
    }
  }))

  return results
}
