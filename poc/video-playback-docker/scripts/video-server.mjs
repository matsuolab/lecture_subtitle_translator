import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname } from 'node:path'
import { randomBytes } from 'node:crypto'

const VIDEO_CHUNK_MAX = 32 * 1024 * 1024

function parseRangeHeader(range, fileSize) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '')
  if (!match) return null
  const start = Number.parseInt(match[1], 10)
  const end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  if (start >= fileSize || end < start) return null
  return [start, Math.min(end, fileSize - 1)]
}

function mimeForPath(path) {
  switch (extname(path).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.mkv':
      return 'video/x-matroska'
    case '.webm':
      return 'video/webm'
    case '.avi':
      return 'video/x-msvideo'
    default:
      return 'video/mp4'
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Range, If-Range, If-None-Match, If-Modified-Since',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  }
}

export async function startVideoServer() {
  const tokens = new Map()
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { ...corsHeaders(), 'Content-Type': 'text/plain' })
      res.end('ok')
      return
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, corsHeaders())
      res.end('method not allowed')
      return
    }

    const token = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.replace(/^\/video\//, '')
    const path = tokens.get(token)
    if (!token || !path) {
      res.writeHead(404, corsHeaders())
      res.end('not found')
      return
    }

    const fileSize = statSync(path).size
    const requestedRange = req.headers.range
    const parsedRange = parseRangeHeader(requestedRange, fileSize)
    const hasRange = Boolean(parsedRange)
    const [rangeStart, rangeEnd] = parsedRange ?? [0, Math.min(fileSize - 1, VIDEO_CHUNK_MAX - 1)]
    const end = Math.min(rangeEnd, rangeStart + VIDEO_CHUNK_MAX - 1)
    const length = end - rangeStart + 1
    const headers = {
      ...corsHeaders(),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(length),
      'Content-Type': mimeForPath(path),
    }
    if (hasRange) headers['Content-Range'] = `bytes ${rangeStart}-${end}/${fileSize}`

    res.writeHead(hasRange ? 206 : 200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    createReadStream(path, { start: rangeStart, end }).pipe(res)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    registerVideo(path) {
      const token = randomBytes(16).toString('hex')
      tokens.set(token, path)
      return `http://127.0.0.1:${port}/video/${token}`
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    },
  }
}
