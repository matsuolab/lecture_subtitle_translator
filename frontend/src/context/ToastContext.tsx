import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import type { LocaleStrings, ToastMessageParams } from '@/i18n'
import { useLocale } from '@/context/LocaleContext'
import { useTheme } from '@/context/ThemeContext'

type ToastVariant = 'success' | 'error' | 'info'
type ToastKey = keyof LocaleStrings['toast']

type ToastItem = {
  id: number
  variant: ToastVariant
  message: string
}

type ToastApi = {
  success: (key: ToastKey, params?: ToastMessageParams) => void
  error: (key: ToastKey, params?: ToastMessageParams) => void
  info: (key: ToastKey, params?: ToastMessageParams) => void
}

const ToastContext = createContext<ToastApi>({
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
})

function resolveToastMessage(strings: LocaleStrings, key: ToastKey, params: ToastMessageParams = {}) {
  const message = strings.toast[key]
  return typeof message === 'function' ? message(params) : message
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { strings } = useLocale()
  const { theme } = useTheme()
  const [items, setItems] = useState<ToastItem[]>([])
  const nextIdRef = useRef(1)

  const push = useCallback((variant: ToastVariant, key: ToastKey, params?: ToastMessageParams) => {
    const id = nextIdRef.current++
    const item = { id, variant, message: resolveToastMessage(strings, key, params) }
    setItems(prev => [...prev.slice(-3), item])
    window.setTimeout(() => {
      setItems(prev => prev.filter(current => current.id !== id))
    }, 3000)
  }, [strings])

  const api: ToastApi = useMemo(() => ({
    success: (key, params) => push('success', key, params),
    error: (key, params) => push('error', key, params),
    info: (key, params) => push('info', key, params),
  }), [push])

  const getAccentColor = (variant: ToastVariant) => {
    if (variant === 'success') return '#22c55e'
    if (variant === 'error') return '#ef4444'
    return theme.accent
  }

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        style={{
          position: 'fixed',
          right: 16,
          top: 16,
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          width: 'min(360px, calc(100vw - 32px))',
          pointerEvents: 'none',
        }}
      >
        {items.map(item => (
          <div
            key={item.id}
            role="status"
            style={{
              display: 'grid',
              gridTemplateColumns: '8px 1fr',
              alignItems: 'stretch',
              overflow: 'hidden',
              borderRadius: 8,
              border: `1px solid ${theme.panelBorder}`,
              background: theme.panelBg,
              color: theme.textPrimary,
              boxShadow: '0 16px 40px rgba(0, 0, 0, 0.42)',
              fontSize: 13,
              fontWeight: 600,
              lineHeight: 1.5,
            }}
          >
            <div style={{ background: getAccentColor(item.variant) }} />
            <div style={{ padding: '10px 12px' }}>{item.message}</div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}
