import { createContext, useContext, useState } from 'react'
import type { LocaleStrings } from '@/i18n'
import { locales, defaultLocale } from '@/i18n'

const STORAGE_KEY = 'matsuo-subtitle-locale'

interface LocaleContextValue {
  strings: LocaleStrings
  setLocaleId: (id: string) => void
}

const LocaleContext = createContext<LocaleContextValue>({
  strings: defaultLocale,
  setLocaleId: () => {},
})

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  const [strings, setStrings] = useState<LocaleStrings>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return locales.find(l => l.id === saved) ?? defaultLocale
    } catch {
      return defaultLocale
    }
  })

  const setLocaleId = (id: string) => {
    const locale = locales.find(l => l.id === id)
    if (!locale) return
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      // localStorage が使えない環境では無視（設定はメモリ上のstateのみ反映）
    }
    setStrings(locale)
  }

  return (
    <LocaleContext.Provider value={{ strings, setLocaleId }}>
      {children}
    </LocaleContext.Provider>
  )
}

export function useLocale() {
  return useContext(LocaleContext)
}
