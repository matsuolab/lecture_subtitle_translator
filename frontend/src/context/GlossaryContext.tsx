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

export type SelfMadeGlossaryOrigin = 'document_generated' | 'formal_import' | 'manual'
export type SelfMadeGlossaryKind = 'term' | 'abbreviation' | 'formula'
export type SelfMadeGlossaryEntryClass =
  | 'formal_term'
  | 'assistive_notation'
  | 'formula_reading'
  | 'shape_notation'
  | 'reference'
  | 'generic_word'
  | 'noise'
export type SelfMadeGlossaryValueSource = 'document' | 'vision' | 'llm_inferred' | 'manual' | 'missing'
export type SelfMadeGlossaryChildSourceType = 'page' | 'document_url' | 'linked_url'

export interface SelfMadeGlossarySource {
  id: string
  kind: 'pdf' | 'text' | 'url' | 'formal'
  name: string
  uri?: string
  importedAt: string
}

export interface SelfMadeGlossaryChildSource {
  type: SelfMadeGlossaryChildSourceType
  page?: number
  url?: string
  label?: string
  snippet?: string
}

export interface SelfMadeGlossaryEntry {
  id: string
  kind: SelfMadeGlossaryKind
  entryClass: SelfMadeGlossaryEntryClass
  origin: SelfMadeGlossaryOrigin
  ja: string
  en: string
  jaSource: SelfMadeGlossaryValueSource
  enSource: SelfMadeGlossaryValueSource
  abbr?: string
  formula?: string
  latex?: string
  displayText?: string
  spokenJa?: string
  spokenEn?: string
  domain?: string
  note?: string
  desc?: string
  confidence: number
  formalEligible: boolean
  assistiveEligible: boolean
  provisional: boolean
  disabled: boolean
  reviewReason?: string
  jaConfirmed: boolean
  enConfirmed: boolean
  promoted: boolean
  source: SelfMadeGlossarySource
  children: SelfMadeGlossaryChildSource[]
  createdAt: string
  updatedAt: string
}

const STORAGE_KEY = 'glossary_v1'
const SELF_MADE_STORAGE_KEY = 'self_made_glossary_v1'

function loadFromStorage(): GlossaryEntry[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as GlossaryEntry[]
  } catch {
    return null
  }
}

function loadSelfMadeFromStorage(): SelfMadeGlossaryEntry[] | null {
  try {
    const raw = localStorage.getItem(SELF_MADE_STORAGE_KEY)
    if (!raw) return null
    const entries = JSON.parse(raw) as SelfMadeGlossaryEntry[]
    return compactSelfMadeEntries(entries)
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

function saveSelfMadeToStorage(entries: SelfMadeGlossaryEntry[]) {
  try {
    localStorage.setItem(SELF_MADE_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // localStorage が使えない環境では無視
  }
}

const initialGlossary: GlossaryEntry[] = []

const initialExtracted: ExtractedTerm[] = []
const initialSelfMadeGlossary: SelfMadeGlossaryEntry[] = []

function normalizeGlossaryText(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function normalizeSelfMadeKey(entry: Pick<SelfMadeGlossaryEntry, 'kind' | 'ja' | 'en' | 'abbr' | 'formula' | 'displayText'>): string {
  const ja = normalizeGlossaryText(entry.ja)
  const en = normalizeGlossaryText(entry.en)
  const abbr = normalizeGlossaryText(entry.abbr)
  const formula = normalizeGlossaryText(entry.formula ?? entry.displayText)
  if (entry.kind === 'formula' && formula) return `formula\u0000${formula}`
  if (ja && en) return `term\u0000${ja}\u0000${en}`
  if (abbr && en) return `abbr\u0000${abbr}\u0000${en}`
  if (abbr && ja) return `abbr\u0000${abbr}\u0000${ja}`
  return `${entry.kind}\u0000${ja}\u0000${en}`
}

function selfMadePages(entry: SelfMadeGlossaryEntry): Set<number> {
  return new Set(entry.children.map(child => child.page).filter((page): page is number => typeof page === 'number'))
}

function hasSharedPage(a: SelfMadeGlossaryEntry, b: SelfMadeGlossaryEntry): boolean {
  const pages = selfMadePages(a)
  if (pages.size === 0) return false
  return b.children.some(child => typeof child.page === 'number' && pages.has(child.page))
}

function entryMentions(textEntry: SelfMadeGlossaryEntry, target: string): boolean {
  const needle = normalizeGlossaryText(target)
  if (!needle) return false
  const haystack = [
    textEntry.ja,
    textEntry.en,
    textEntry.abbr,
    textEntry.displayText,
    textEntry.desc,
    textEntry.note,
    textEntry.reviewReason,
    ...textEntry.children.map(child => child.snippet),
  ].map(normalizeGlossaryText).join('\n')
  return haystack.includes(needle)
}

function abbreviationMatchesEnglish(abbr: string | undefined, en: string | undefined): boolean {
  const normalizedAbbr = normalizeGlossaryText(abbr).replace(/[^a-z0-9]/g, '')
  const normalizedEn = (en ?? '').trim()
  if (!normalizedAbbr || !normalizedEn) return false
  const initials = normalizedEn
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toLowerCase())
    .join('')
  return initials === normalizedAbbr
}

function shouldMergeSelfMadeEntries(previous: SelfMadeGlossaryEntry, incoming: SelfMadeGlossaryEntry): boolean {
  const prevJa = normalizeGlossaryText(previous.ja)
  const prevEn = normalizeGlossaryText(previous.en)
  const prevAbbr = normalizeGlossaryText(previous.abbr)
  const inJa = normalizeGlossaryText(incoming.ja)
  const inEn = normalizeGlossaryText(incoming.en)
  const inAbbr = normalizeGlossaryText(incoming.abbr)

  if (prevJa && prevEn && prevJa === inJa && prevEn === inEn) return true
  if (
    prevJa
    && prevJa === inJa
    && previous.entryClass === 'formal_term'
    && incoming.entryClass === 'formal_term'
    && (!prevEn || !inEn || prevEn === inEn)
  ) {
    return true
  }
  if (prevAbbr && inAbbr && prevAbbr === inAbbr && (prevEn === inEn || prevJa === inJa)) return true

  const incomingLooksLikeAbbr = incoming.kind === 'abbreviation' || Boolean(incoming.abbr)
  const previousLooksLikeAbbr = previous.kind === 'abbreviation' || Boolean(previous.abbr)

  if (
    incomingLooksLikeAbbr
    && previous.ja
    && !previous.en
    && incoming.en
    && abbreviationMatchesEnglish(incoming.abbr, incoming.en)
    && hasSharedPage(previous, incoming)
    && entryMentions(incoming, previous.ja)
  ) {
    return true
  }

  if (
    previousLooksLikeAbbr
    && incoming.ja
    && !incoming.en
    && previous.en
    && abbreviationMatchesEnglish(previous.abbr, previous.en)
    && hasSharedPage(previous, incoming)
    && entryMentions(previous, incoming.ja)
  ) {
    return true
  }

  return false
}

function preferText(incoming: string, previous: string): string {
  return incoming.trim() ? incoming : previous
}

function preferOptionalText(incoming: string | undefined, previous: string | undefined): string | undefined {
  return incoming?.trim() ? incoming : previous
}

function mergeSelfMadeEntry(previous: SelfMadeGlossaryEntry, incoming: SelfMadeGlossaryEntry): SelfMadeGlossaryEntry {
  const ja = preferText(incoming.ja, previous.ja)
  const en = preferText(incoming.en, previous.en)
  return {
    ...previous,
    ...incoming,
    id: previous.id,
    kind: previous.kind === 'term' && incoming.kind === 'abbreviation' ? 'term' : incoming.kind,
    entryClass: previous.entryClass === 'formal_term' || incoming.entryClass === 'formal_term'
      ? 'formal_term'
      : incoming.entryClass,
    ja,
    en,
    jaSource: ja === previous.ja ? previous.jaSource : incoming.jaSource,
    enSource: en === previous.en ? previous.enSource : incoming.enSource,
    abbr: preferOptionalText(incoming.abbr, previous.abbr),
    formula: preferOptionalText(incoming.formula, previous.formula),
    latex: preferOptionalText(incoming.latex, previous.latex),
    displayText: preferOptionalText(incoming.displayText, previous.displayText),
    spokenJa: preferOptionalText(incoming.spokenJa, previous.spokenJa),
    spokenEn: preferOptionalText(incoming.spokenEn, previous.spokenEn),
    domain: preferOptionalText(incoming.domain, previous.domain),
    note: preferOptionalText(incoming.note, previous.note),
    desc: preferOptionalText(incoming.desc, previous.desc),
    reviewReason: preferOptionalText(incoming.reviewReason, previous.reviewReason),
    confidence: Math.max(previous.confidence, incoming.confidence),
    formalEligible: previous.formalEligible || incoming.formalEligible,
    assistiveEligible: previous.assistiveEligible || incoming.assistiveEligible,
    jaConfirmed: previous.jaConfirmed || incoming.jaConfirmed,
    enConfirmed: previous.enConfirmed || incoming.enConfirmed,
    promoted: previous.promoted || incoming.promoted,
    disabled: previous.disabled && incoming.disabled,
    children: [...previous.children, ...incoming.children],
    createdAt: previous.createdAt,
    updatedAt: new Date().toISOString(),
  }
}

function normalizeLoadedSelfMadeEntry(entry: SelfMadeGlossaryEntry): SelfMadeGlossaryEntry {
  let next = entry
  if (next.entryClass === 'reference' || next.entryClass === 'noise') {
    next = {
      ...next,
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: next.reviewReason || '参考情報またはノイズのため利用対象から除外',
    }
  }
  if (next.entryClass === 'generic_word') {
    next = {
      ...next,
      formalEligible: false,
      assistiveEligible: false,
      disabled: true,
      reviewReason: next.reviewReason || '一般語のため既定では正式辞書・補正利用から除外',
    }
  }
  if (next.kind === 'formula' && next.entryClass === 'formal_term') {
    next = {
      ...next,
      entryClass: 'formula_reading',
      formalEligible: false,
      assistiveEligible: true,
      reviewReason: next.reviewReason || '数式読み支援候補',
    }
  }
  if (next.kind === 'formula' && next.entryClass === 'shape_notation' && /^[A-Za-zΑ-Ωα-ω]$/.test((next.formula || next.displayText || '').trim())) {
    next = {
      ...next,
      entryClass: 'formula_reading',
      formalEligible: false,
      assistiveEligible: true,
      reviewReason: next.reviewReason || '単独記号の読み支援候補',
    }
  }
  return next
}

function compactSelfMadeEntries(entries: SelfMadeGlossaryEntry[]): SelfMadeGlossaryEntry[] {
  const result: SelfMadeGlossaryEntry[] = []
  const indexByKey = new Map<string, number>()
  for (const rawEntry of entries) {
    const entry = normalizeLoadedSelfMadeEntry(rawEntry)
    const key = normalizeSelfMadeKey(entry)
    let existingIdx = indexByKey.get(key)
    if (existingIdx === undefined) {
      const mergeIdx = result.findIndex(previous => shouldMergeSelfMadeEntries(previous, entry))
      if (mergeIdx >= 0) existingIdx = mergeIdx
    }
    if (existingIdx !== undefined) {
      const merged = mergeSelfMadeEntry(result[existingIdx], entry)
      result[existingIdx] = merged
      indexByKey.set(normalizeSelfMadeKey(merged), existingIdx)
    } else {
      indexByKey.set(key, result.length)
      result.push(entry)
    }
  }
  return result
}

interface GlossaryContextValue {
  glossary: GlossaryEntry[]
  extracted: ExtractedTerm[]
  selfMadeGlossary: SelfMadeGlossaryEntry[]
  setGlossary: React.Dispatch<React.SetStateAction<GlossaryEntry[]>>
  setExtracted: React.Dispatch<React.SetStateAction<ExtractedTerm[]>>
  setSelfMadeGlossary: React.Dispatch<React.SetStateAction<SelfMadeGlossaryEntry[]>>
  /** エントリを追加・上書きインポートする（ja+enが重複する場合は既存を置換） */
  importEntries: (entries: GlossaryEntry[]) => { added: number; updated: number }
  /** 自作用語候補を追加・上書きインポートする */
  importSelfMadeEntries: (entries: SelfMadeGlossaryEntry[]) => { added: number; updated: number }
  /** 既存の正式辞書を自作辞書へ作業用データとして取り込む */
  importGlossaryIntoSelfMade: () => { added: number; updated: number }
  /** 自作用語候補を更新する */
  updateSelfMadeEntry: (id: string, patch: Partial<SelfMadeGlossaryEntry>) => void
  /** 自作用語候補を正式辞書へ昇格する */
  promoteSelfMadeEntry: (id: string) => { promoted: boolean; reason?: string }
  /** 用語辞書をクリアする */
  clearGlossary: () => void
  /** 自作辞書をクリアする */
  clearSelfMadeGlossary: () => void
}

const GlossaryContext = createContext<GlossaryContextValue>({
  glossary: initialGlossary,
  extracted: initialExtracted,
  selfMadeGlossary: initialSelfMadeGlossary,
  setGlossary: () => {},
  setExtracted: () => {},
  setSelfMadeGlossary: () => {},
  importEntries: () => ({ added: 0, updated: 0 }),
  importSelfMadeEntries: () => ({ added: 0, updated: 0 }),
  importGlossaryIntoSelfMade: () => ({ added: 0, updated: 0 }),
  updateSelfMadeEntry: () => {},
  promoteSelfMadeEntry: () => ({ promoted: false }),
  clearGlossary: () => {},
  clearSelfMadeGlossary: () => {},
})

export function GlossaryProvider({ children }: { children: React.ReactNode }) {
  const [glossary, setGlossaryRaw] = useState<GlossaryEntry[]>(
    () => loadFromStorage() ?? initialGlossary
  )
  const glossaryRef = useRef(glossary)
  glossaryRef.current = glossary

  const [extracted, setExtracted] = useState<ExtractedTerm[]>(initialExtracted)
  const [selfMadeGlossary, setSelfMadeGlossaryRaw] = useState<SelfMadeGlossaryEntry[]>(
    () => loadSelfMadeFromStorage() ?? initialSelfMadeGlossary
  )
  const selfMadeGlossaryRef = useRef(selfMadeGlossary)
  selfMadeGlossaryRef.current = selfMadeGlossary

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

  const setSelfMadeGlossary: React.Dispatch<React.SetStateAction<SelfMadeGlossaryEntry[]>> = useCallback(
    (action) => {
      setSelfMadeGlossaryRaw(prev => {
        const next = typeof action === 'function' ? action(prev) : action
        saveSelfMadeToStorage(next)
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

  const importSelfMadeEntries = useCallback((incoming: SelfMadeGlossaryEntry[]) => {
    const prev = selfMadeGlossaryRef.current
    const result = [...prev]
    const indexByKey = new Map<string, number>()
    let added = 0
    let updated = 0

    for (let i = 0; i < result.length; i++) {
      indexByKey.set(normalizeSelfMadeKey(result[i]), i)
    }

    for (const entry of incoming) {
      const key = normalizeSelfMadeKey(entry)
      let existingIdx = indexByKey.get(key)
      if (existingIdx === undefined) {
        const mergeIdx = result.findIndex(previous => shouldMergeSelfMadeEntries(previous, entry))
        if (mergeIdx >= 0) existingIdx = mergeIdx
      }
      if (existingIdx !== undefined) {
        const previous = result[existingIdx]
        const merged = mergeSelfMadeEntry(previous, entry)
        result[existingIdx] = merged
        indexByKey.set(normalizeSelfMadeKey(merged), existingIdx)
        updated++
      } else {
        indexByKey.set(key, result.length)
        result.push(entry)
        added++
      }
    }

    setSelfMadeGlossary(result)
    return { added, updated }
  }, [setSelfMadeGlossary])

  const importGlossaryIntoSelfMade = useCallback(() => {
    const now = new Date().toISOString()
    const source: SelfMadeGlossarySource = {
      id: `formal-${Date.now()}`,
      kind: 'formal',
      name: '正式辞書',
      importedAt: now,
    }
    return importSelfMadeEntries(glossaryRef.current.map(entry => ({
      id: crypto.randomUUID(),
      kind: entry.abbr ? 'abbreviation' : 'term',
      entryClass: 'formal_term',
      origin: 'formal_import',
      ja: entry.ja,
      en: entry.en,
      jaSource: 'manual',
      enSource: 'manual',
      abbr: entry.abbr,
      domain: entry.domain,
      note: entry.note,
      desc: entry.desc,
      confidence: 1,
      formalEligible: true,
      assistiveEligible: true,
      provisional: false,
      disabled: false,
      reviewReason: '正式辞書から自作辞書へ取り込み',
      jaConfirmed: true,
      enConfirmed: true,
      promoted: true,
      source,
      children: entry.source ? [{ type: 'page', snippet: entry.source }] : [],
      createdAt: now,
      updatedAt: now,
    })))
  }, [importSelfMadeEntries])

  const updateSelfMadeEntry = useCallback((id: string, patch: Partial<SelfMadeGlossaryEntry>) => {
    setSelfMadeGlossary(prev => prev.map(entry => (
      entry.id === id
        ? { ...entry, ...patch, updatedAt: new Date().toISOString() }
        : entry
    )))
  }, [setSelfMadeGlossary])

  const promoteSelfMadeEntry = useCallback((id: string) => {
    const entry = selfMadeGlossaryRef.current.find(item => item.id === id)
    if (!entry) return { promoted: false, reason: '候補が見つかりません' }
    if (entry.disabled) return { promoted: false, reason: '無効化された候補です' }
    if (!entry.formalEligible) return { promoted: false, reason: '正式辞書への昇格対象ではありません' }
    if (!entry.ja.trim() || !entry.en.trim()) return { promoted: false, reason: '日英表記が揃っていません' }
    if (!entry.jaConfirmed || !entry.enConfirmed) return { promoted: false, reason: '日英両方の確認が必要です' }

    importEntries([{
      id: crypto.randomUUID(),
      ja: entry.ja,
      en: entry.en,
      abbr: entry.abbr,
      domain: entry.domain,
      note: entry.note,
      desc: entry.desc || entry.displayText || entry.formula,
      source: entry.children.find(child => child.page)?.page
        ? `${entry.source.name} p.${entry.children.find(child => child.page)?.page}`
        : entry.source.name,
      sourceUrl: entry.children.find(child => child.url)?.url ?? null,
      confirmed: true,
    }])
    updateSelfMadeEntry(id, { promoted: true, provisional: false })
    return { promoted: true }
  }, [importEntries, updateSelfMadeEntry])

  const clearGlossary = useCallback(() => {
    setGlossary([])
  }, [setGlossary])

  const clearSelfMadeGlossary = useCallback(() => {
    setSelfMadeGlossary([])
  }, [setSelfMadeGlossary])

  return (
    <GlossaryContext.Provider value={{
      glossary,
      extracted,
      selfMadeGlossary,
      setGlossary,
      setExtracted,
      setSelfMadeGlossary,
      importEntries,
      importSelfMadeEntries,
      importGlossaryIntoSelfMade,
      updateSelfMadeEntry,
      promoteSelfMadeEntry,
      clearGlossary,
      clearSelfMadeGlossary,
    }}>
      {children}
    </GlossaryContext.Provider>
  )
}

export function useGlossary() {
  return useContext(GlossaryContext)
}
