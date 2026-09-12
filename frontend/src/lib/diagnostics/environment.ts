/**
 * 不具合が「アプリのロジック不具合」か「実行環境（PCスペック等）の限界」かを
 * 切り分けるための、実行環境スナップショット。取得コストが高い/対応環境が
 * 限られる値が含まれるため、常時ではなくイベント記録の detail に都度付与する。
 */
export interface EnvironmentSnapshot {
  hardwareConcurrency?: number
  devicePixelRatio?: number
  innerWidth?: number
  innerHeight?: number
  /** Chromium系のみ。非対応環境では省略 */
  jsHeapUsedMb?: number
  jsHeapLimitMb?: number
}

interface PerformanceMemory {
  usedJSHeapSize: number
  jsHeapSizeLimit: number
}

export function collectEnvironmentSnapshot(): EnvironmentSnapshot {
  const perf = performance as Performance & { memory?: PerformanceMemory }
  return {
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined,
    devicePixelRatio: typeof window !== 'undefined' ? window.devicePixelRatio : undefined,
    innerWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    innerHeight: typeof window !== 'undefined' ? window.innerHeight : undefined,
    jsHeapUsedMb: perf.memory ? Math.round(perf.memory.usedJSHeapSize / 1048576) : undefined,
    jsHeapLimitMb: perf.memory ? Math.round(perf.memory.jsHeapSizeLimit / 1048576) : undefined,
  }
}
