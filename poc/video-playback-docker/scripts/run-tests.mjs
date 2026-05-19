import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildMacAssetUrl, buildPathFlags } from './url-utils.mjs'
import { startVideoServer } from './video-server.mjs'

const tmpRoot = mkdtempSync(join(tmpdir(), 'matsuo-video-probe-'))
const scriptDir = dirname(fileURLToPath(import.meta.url))

function logPass(name) {
  console.log(`PASS ${name}`)
}

function findChromiumExecutable() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ].filter(Boolean)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  const root = '/ms-playwright'
  if (!existsSync(root)) return null
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.name === 'chrome' && path.includes('chrome-linux')) {
        return path
      }
    }
  }
  return null
}

function findFfmpegExecutable() {
  const candidates = [
    process.env.FFMPEG_PATH,
    resolve(scriptDir, '../../../frontend/src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe'),
    'ffmpeg',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
    if (candidate === 'ffmpeg') return candidate
  }
  return 'ffmpeg'
}

function generateSampleVideo(path, format = 'mp4') {
  const ffmpegPath = findFfmpegExecutable()
  const codecArgs = format === 'webm'
    ? ['-c:v', 'libvpx-vp9', '-b:v', '256k', '-c:a', 'libopus']
    : ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart']

  const ffmpeg = spawnSync(ffmpegPath, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=160x90:rate=1:duration=1',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=channel_layout=stereo:sample_rate=48000',
    '-shortest',
    ...codecArgs,
    path,
  ], { encoding: 'utf8' })

  if (!ffmpeg.error && ffmpeg.status === 0) {
    return true
  }

  const detail = ffmpeg.error?.message ?? ffmpeg.stderr ?? ffmpeg.stdout ?? `exit ${ffmpeg.status}`
  console.log(`SKIP real ${format.toUpperCase()} generation (${ffmpegPath}: ${detail}); using binary fixture for HTTP tests`)
  writeFileSync(path, Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251)))
  return false
}

async function testUrlGeneration() {
  const path = '/Users/tester/講義 動画/#day7?sample%20.mp4'
  const url = buildMacAssetUrl(path)
  assert.equal(url.startsWith('asset://localhost/Users/tester/'), true)
  assert.equal(/%2F/i.test(url), false)
  assert.match(url, /%E8%AC%9B%E7%BE%A9%20%E5%8B%95%E7%94%BB/)
  assert.match(url, /%23day7%3Fsample%2520\.mp4$/)

  const flags = buildPathFlags(path)
  assert.deepEqual(flags, {
    hasNonAsciiPath: true,
    hasWhitespacePath: true,
    hasUrlSpecialPath: true,
  })
  logPass('mac asset URL keeps slash delimiters and encodes path segments')
}

async function testHttpRangeServer(videoPath) {
  const server = await startVideoServer()
  try {
    const url = server.registerVideo(videoPath)

    const health = await fetch(`${server.baseUrl}/healthz`)
    assert.equal(health.status, 200)
    assert.equal(await health.text(), 'ok')

    const head = await fetch(url, { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('accept-ranges'), 'bytes')
    assert.equal(head.headers.get('content-type'), 'video/mp4')

    const range = await fetch(url, { headers: { Range: 'bytes=0-31' } })
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('content-range'), `bytes 0-31/${statSync(videoPath).size}`)
    assert.equal((await range.arrayBuffer()).byteLength, 32)

    const missing = await fetch(`${server.baseUrl}/video/missing`)
    assert.equal(missing.status, 404)
    logPass('local video HTTP server handles health, HEAD, Range, and missing token')
  } finally {
    await server.close()
  }
}

function cdpSession(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const listeners = new Set()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    for (const listener of listeners) listener(msg)
  })

  return {
    waitOpen: () => new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    }),
    send(method, params = {}, sessionId) {
      const id = nextId++
      ws.send(JSON.stringify({ id, method, params, sessionId }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close() {
      ws.close()
    },
  }
}

async function testBrowserPlayback(videoPath) {
  if (process.env.RUN_BROWSER !== '1') {
    console.log('SKIP browser video playback (RUN_BROWSER is not 1)')
    return
  }
  const chromium = findChromiumExecutable()
  if (!chromium) {
    console.log('SKIP browser video playback (Chromium executable not found)')
    return
  }

  const server = await startVideoServer()
  const chromeProfile = join(tmpRoot, 'chrome-profile')
  mkdirSync(chromeProfile, { recursive: true })
  let chrome
  let session
  try {
    const videoUrl = server.registerVideo(videoPath)
    const pageHtml = `<!doctype html>
<meta charset="utf-8">
<video id="v" muted playsinline src="${videoUrl}"></video>
<script>
const v = document.getElementById('v')
window.__videoTestResult = { status: 'pending' }
v.addEventListener('loadedmetadata', () => {
  window.__videoTestResult = {
    status: 'loadedmetadata',
    duration: Number.isFinite(v.duration) ? v.duration : null,
    readyState: v.readyState,
    networkState: v.networkState,
    currentSrc: v.currentSrc,
  }
})
v.addEventListener('error', () => {
  window.__videoTestResult = {
    status: 'error',
    code: v.error ? v.error.code : null,
    message: v.error ? v.error.message : null,
    readyState: v.readyState,
    networkState: v.networkState,
    currentSrc: v.currentSrc,
  }
})
</script>`
    const pagePath = join(tmpRoot, 'playback.html')
    writeFileSync(pagePath, pageHtml, 'utf8')

    chrome = spawn(chromium, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=0',
      `--user-data-dir=${chromeProfile}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })

    const wsUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for Chromium DevTools URL')), 15000)
      chrome.stderr.on('data', (chunk) => {
        const text = chunk.toString()
        const match = text.match(/DevTools listening on (ws:\/\/.*)/)
        if (match) {
          clearTimeout(timeout)
          resolve(match[1].trim())
        }
      })
      chrome.once('exit', (code) => {
        clearTimeout(timeout)
        reject(new Error(`Chromium exited before DevTools was ready: ${code}`))
      })
    })

    session = cdpSession(wsUrl)
    await session.waitOpen()
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true })
    await session.send('Page.enable', {}, sessionId)
    await session.send('Runtime.enable', {}, sessionId)
    await session.send('Page.navigate', { url: `file://${pagePath.replaceAll('\\', '/')}` }, sessionId)

    const deadline = Date.now() + 15000
    let result = null
    while (Date.now() < deadline) {
      const evaluated = await session.send('Runtime.evaluate', {
        expression: 'window.__videoTestResult',
        returnByValue: true,
      }, sessionId)
      result = evaluated.result.value
      if (result?.status && result.status !== 'pending') break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    assert.equal(result?.status, 'loadedmetadata', `browser video result: ${JSON.stringify(result)}`)
    assert.equal(result.currentSrc.startsWith('http://127.0.0.1:'), true)
    logPass(`Chromium <video> loaded generated video fixture (${basename(videoPath)})`)
  } finally {
    session?.close()
    if (chrome && !chrome.killed) {
      const exited = new Promise((resolve) => chrome.once('exit', resolve))
      chrome.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))])
    }
    await server.close()
  }
}

async function testMacHttpFallbackRoute(videoPath) {
  const server = await startVideoServer()
  try {
    const sourcePath = '/Users/tester/講義 動画/#day7?sample%20.webm'
    const assetUrl = buildMacAssetUrl(sourcePath)
    const httpUrl = server.registerVideo(videoPath)

    assert.equal(assetUrl.startsWith('asset://localhost/Users/tester/'), true)
    assert.equal(/%2F/i.test(assetUrl), false)
    assert.equal(httpUrl.startsWith('http://127.0.0.1:'), true)

    const probe = await fetch(httpUrl, { headers: { Range: 'bytes=0-127' } })
    assert.equal(probe.status, 206)
    assert.equal(probe.headers.get('accept-ranges'), 'bytes')
    assert.match(probe.headers.get('content-range') ?? '', /^bytes 0-127\/\d+$/)
    assert.equal((await probe.arrayBuffer()).byteLength, 128)

    logPass('Mac HTTP fallback route can replace asset URL with tokenized 127.0.0.1 video URL')
  } finally {
    await server.close()
  }
}

async function main() {
  try {
    await testUrlGeneration()

    const videoDir = join(tmpRoot, '日本語 path #1')
    mkdirSync(videoDir, { recursive: true })
    const mp4Path = join(videoDir, 'sample video.mp4')
    const hasMp4Fixture = generateSampleVideo(mp4Path, 'mp4')

    await testHttpRangeServer(mp4Path)
    if (hasMp4Fixture) {
      const webmPath = join(videoDir, 'sample video.webm')
      const hasWebmFixture = generateSampleVideo(webmPath, 'webm')
      if (hasWebmFixture) {
        await testMacHttpFallbackRoute(webmPath)
        await testBrowserPlayback(webmPath)
      } else {
        console.log('SKIP browser video playback (playable WebM fixture was not generated)')
      }
    } else {
      console.log('SKIP browser video playback (playable fixtures were not generated)')
    }

    console.log('All video playback Docker probe checks passed.')
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
