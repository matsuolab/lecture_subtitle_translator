import { createContext, useContext, useState, useCallback, useRef } from 'react'

export interface GlossaryEntry {
  id: string
  ja: string
  en: string
  abbr?: string
  domain?: string
  note?: string
  /** 詳細説明（手動入力・初期データ用） */
  desc?: string
  /** 出典（論文・スライド等の参照情報） */
  source?: string
  sourceUrl?: string | null
  confirmed: boolean
}

export interface ExtractedTerm {
  en: string
  ja: string
  source: string
  sourceUrl: string | null
}

const STORAGE_KEY = 'glossary_v1'

function loadFromStorage(): GlossaryEntry[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as GlossaryEntry[]
  } catch {
    return null
  }
}

function saveToStorage(entries: GlossaryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage が使えない環境では無視
  }
}

const initialGlossary: GlossaryEntry[] = []

const initialExtracted: ExtractedTerm[] = []

interface GlossaryContextValue {
  glossary: GlossaryEntry[]
  extracted: ExtractedTerm[]
  setGlossary: React.Dispatch<React.SetStateAction<GlossaryEntry[]>>
  setExtracted: React.Dispatch<React.SetStateAction<ExtractedTerm[]>>
  /** エントリを追加・上書きインポートする（ja+enが重複する場合は既存を置換） */
  importEntries: (entries: GlossaryEntry[]) => { added: number; updated: number }
  /** 用語辞書をクリアする */
  clearGlossary: () => void
}

const GlossaryContext = createContext<GlossaryContextValue>({
  glossary: initialGlossary,
  extracted: initialExtracted,
  setGlossary: () => {},
  setExtracted: () => {},
  importEntries: () => ({ added: 0, updated: 0 }),
  clearGlossary: () => {},
})

export function GlossaryProvider({ children }: { children: React.ReactNode }) {
  const [glossary, setGlossaryRaw] = useState<GlossaryEntry[]>(
    () => loadFromStorage() ?? initialGlossary
  )
  const glossaryRef = useRef(glossary)
  glossaryRef.current = glossary

  const [extracted, setExtracted] = useState<ExtractedTerm[]>(initialExtracted)

  const setGlossary: React.Dispatch<React.SetStateAction<GlossaryEntry[]>> = useCallback(
    (action) => {
      setGlossaryRaw(prev => {
        const next = typeof action === 'function' ? action(prev) : action
        saveToStorage(next)
        return next
      })
    },
    []
  )

  const importEntries = useCallback((incoming: GlossaryEntry[]) => {
    // O(n*m) を避けるため、ja+en の複合キーでインデックスを作る
    const prev = glossaryRef.current
    const result = [...prev]
    const indexByKey = new Map<string, number>()
    let added = 0
    let updated = 0

    for (let i = 0; i < result.length; i++) {
      const e = result[i]
      indexByKey.set(`${e.ja}\u0000${e.en}`, i)
    }

    for (const entry of incoming) {
      const key = `${entry.ja}\u0000${entry.en}`
      const existingIdx = indexByKey.get(key)
      if (existingIdx !== undefined) {
        // 既存エントリを更新（confirmed状態は保持）
        result[existingIdx] = { ...entry, confirmed: result[existingIdx].confirmed }
        updated++
      } else {
        indexByKey.set(key, result.length)
        result.push(entry)
        added++
      }
    }

    setGlossary(result)
    return { added, updated }
  }, [setGlossary])

  const clearGlossary = useCallback(() => {
    setGlossary([])
  }, [setGlossary])

  return (
    <GlossaryContext.Provider value={{ glossary, extracted, setGlossary, setExtracted, importEntries, clearGlossary }}>
      {children}
    </GlossaryContext.Provider>
  )
}

export function useGlossary() {
  return useContext(GlossaryContext)
}
