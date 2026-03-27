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
    const saved = localStorage.getItem(STORAGE_KEY)
    return locales.find(l => l.id === saved) ?? defaultLocale
  })

  const setLocaleId = (id: string) => {
    const locale = locales.find(l => l.id === id)
    if (!locale) return
    localStorage.setItem(STORAGE_KEY, id)
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
