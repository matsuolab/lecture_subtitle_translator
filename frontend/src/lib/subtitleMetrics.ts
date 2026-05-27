export function countCpsChars(text: string): number {
  return text.replace(/\s/g, '').length
}

export function calculateCps(text: string, durationSec: number): number {
  return countCpsChars(text) / Math.max(0.001, durationSec)
}

export function calculateRoundedCps(text: string, durationSec: number): number {
  return Math.round(calculateCps(text, durationSec) * 10) / 10
}
