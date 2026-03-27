import { createContext, useContext, useState } from 'react'
import type { Theme, ThemeId } from '@/themes'
import { themes, defaultTheme } from '@/themes'

const STORAGE_KEY = 'matsuo-subtitle-theme'

interface ThemeContextValue {
  theme: Theme
  setThemeId: (id: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: defaultTheme,
  setThemeId: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(STORAGE_KEY) as ThemeId | null
    return themes.find(t => t.id === saved) ?? defaultTheme
  })

  const setThemeId = (id: ThemeId) => {
    const t = themes.find(t => t.id === id) ?? defaultTheme
    localStorage.setItem(STORAGE_KEY, id)
    setTheme(t)
  }

  return (
    <ThemeContext.Provider value={{ theme, setThemeId }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
