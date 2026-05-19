export interface BuildMacAssetUrlResult {
  url: string
  segments: string[]
}

export function buildMacAssetUrl(path: string): BuildMacAssetUrlResult {
  const slashed = path.replace(/\\/g, '/')
  const segments = slashed.split('/').map(segment => encodeURIComponent(segment))
  return {
    url: `asset://localhost${segments.join('/')}`,
    segments,
  }
}
