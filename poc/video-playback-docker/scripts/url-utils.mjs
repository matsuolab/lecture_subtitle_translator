export function encodeAssetPathBySegment(path) {
  return path
    .replaceAll('\\', '/')
    .split('/')
    .map((segment, index) => (index === 0 && segment === '' ? '' : encodeURIComponent(segment)))
    .join('/')
}

export function buildMacAssetUrl(path) {
  return `asset://localhost${encodeAssetPathBySegment(path)}`
}

export function buildPathFlags(path) {
  return {
    hasNonAsciiPath: /[^\x00-\x7F]/.test(path),
    hasWhitespacePath: /\s/.test(path),
    hasUrlSpecialPath: /[#?%&;]/.test(path),
  }
}
