import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ThemeProvider } from '@/context/ThemeContext'
import { LocaleProvider } from '@/context/LocaleContext'
import { GlossaryProvider } from '@/context/GlossaryContext'
import { ToastProvider } from '@/context/ToastContext'

type StartupErrorState = {
  error: Error | null
}

class StartupErrorBoundary extends Component<{ children: ReactNode }, StartupErrorState> {
  state: StartupErrorState = {
    error: null,
  }

  static getDerivedStateFromError(error: Error): StartupErrorState {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Startup render failed', error)
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return (
      <div className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
        <div className="mx-auto max-w-4xl space-y-4">
          <h1 className="text-2xl font-semibold">起動時エラー</h1>
          <p className="text-sm text-neutral-300">
            `tauri:dev` の白画面調査用に、起動時例外を表示しています。
          </p>
          <pre className="overflow-x-auto rounded border border-red-500/40 bg-black/40 p-4 text-xs leading-6 text-red-200">
            {this.state.error.stack ?? this.state.error.message}
          </pre>
        </div>
      </div>
    )
  }
}

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error('Root element "#root" was not found.')
}

const root = createRoot(rootElement)

function renderFatal(error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  root.render(
    <div className="min-h-screen bg-neutral-950 px-6 py-8 text-neutral-100">
      <div className="mx-auto max-w-4xl space-y-4">
        <h1 className="text-2xl font-semibold">起動前エラー</h1>
        <p className="text-sm text-neutral-300">
          初期化中に例外が発生しました。以下の内容を見れば白画面原因を特定できます。
        </p>
        <pre className="overflow-x-auto rounded border border-red-500/40 bg-black/40 p-4 text-xs leading-6 text-red-200">
          {message}
        </pre>
      </div>
    </div>,
  )
}

// 初回描画が完了するまでの間だけ、未捕捉エラーで全画面 fatal を出す。
// 描画完了後（=通常運用中）の一過性エラーまで全画面を潰すと、本来トーストや
// try/catch で吸収できる軽微なエラーで「アプリが落ちた」体験になってしまうため、
// 起動後はログ出力のみに留める。
let appBooted = false

window.addEventListener('error', (event) => {
  console.error('Unhandled error', event.error ?? event.message)
  if (!appBooted) {
    renderFatal(event.error ?? event.message)
  }
})

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection', event.reason)
  if (!appBooted) {
    renderFatal(event.reason)
  }
})

root.render(
  <StrictMode>
    <StartupErrorBoundary>
      <LocaleProvider>
        <ThemeProvider>
          <ToastProvider>
            <GlossaryProvider>
              <App />
            </GlossaryProvider>
          </ToastProvider>
        </ThemeProvider>
      </LocaleProvider>
    </StartupErrorBoundary>
  </StrictMode>,
)

// 描画スケジュール後の次フレームで「起動完了」とみなす。
// 以降の未捕捉エラーは全画面 fatal にせずログのみとする。
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    appBooted = true
  })
})
