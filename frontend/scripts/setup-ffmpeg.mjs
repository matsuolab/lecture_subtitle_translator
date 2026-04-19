/**
 * ffmpeg サイドカーセットアップスクリプト。
 *
 * ffmpeg-static（devDependency）からバイナリを取得し、
 * Tauri が要求する命名規則でコピーする。
 *
 *   src-tauri/binaries/ffmpeg-<target-triple>[.exe]
 *
 * 使い方:
 *   npm run setup:ffmpeg
 *
 * CI (GitHub Actions) でも同じコマンドを実行する。
 */

import { copyFileSync, mkdirSync, existsSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')
const binariesDir = join(projectRoot, 'src-tauri', 'binaries')

// ---------------------------------------------------------------------------
// Rust ターゲットトリプルを取得する
// ---------------------------------------------------------------------------

function getTargetTriple() {
  // 1. rustc から取得（最も正確）
  try {
    const output = execSync('rustc -vV', { encoding: 'utf8' })
    const match = output.match(/host:\s+(\S+)/)
    if (match) return match[1]
  } catch {
    // rustc が見つからない場合は Node.js の情報で推測
  }

  // 2. Node.js の platform/arch から推測（fallback）
  const platform = process.platform
  const arch = process.arch

  const map = {
    'win32-x64':  'x86_64-pc-windows-msvc',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64':  'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  }

  const key = `${platform}-${arch}`
  const triple = map[key]
  if (!triple) {
    throw new Error(
      `サポート外のプラットフォーム: ${key}\n` +
      `手動で src-tauri/binaries/ffmpeg-<target-triple> を配置してください。`
    )
  }
  return triple
}

// ---------------------------------------------------------------------------
// ffmpeg-static からバイナリパスを取得する
// ---------------------------------------------------------------------------

async function getFFmpegStaticPath() {
  try {
    const { default: ffmpegPath } = await import('ffmpeg-static')
    return ffmpegPath
  } catch {
    throw new Error(
      'ffmpeg-static が見つかりません。\n' +
      '`npm install` を実行してください。'
    )
  }
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------

async function main() {
  const targetTriple = getTargetTriple()
  const isWindows = process.platform === 'win32'
  const ext = isWindows ? '.exe' : ''
  const destName = `ffmpeg-${targetTriple}${ext}`
  const destPath = join(binariesDir, destName)

  console.log(`ターゲット: ${targetTriple}`)
  console.log(`出力先   : src-tauri/binaries/${destName}`)

  // 既存ファイルがあればスキップ
  if (existsSync(destPath)) {
    console.log('✓ 既にインストール済みです。スキップします。')
    console.log('  （再インストールする場合は src-tauri/binaries/ を削除してください）')
    return
  }

  // binaries ディレクトリを作成
  if (!existsSync(binariesDir)) {
    mkdirSync(binariesDir, { recursive: true })
    console.log('  src-tauri/binaries/ ディレクトリを作成しました。')
  }

  // ffmpeg-static からコピー
  const srcPath = await getFFmpegStaticPath()
  if (!srcPath || !existsSync(srcPath)) {
    throw new Error(`ffmpeg-static のバイナリが見つかりません: ${srcPath}`)
  }

  console.log(`コピー中: ${srcPath}`)
  copyFileSync(srcPath, destPath)

  // Linux/macOS は実行権限を付与
  if (!isWindows) {
    chmodSync(destPath, 0o755)
  }

  console.log(`✓ インストール完了: src-tauri/binaries/${destName}`)
}

main().catch(e => {
  console.error(`\nエラー: ${e.message}`)
  process.exit(1)
})
