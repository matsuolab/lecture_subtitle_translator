import { createContext, useContext, useState } from 'react'

export interface GlossaryEntry {
  en: string
  ja: string
  desc: string
  source: string
  sourceUrl: string | null
  confirmed: boolean
}

export interface ExtractedTerm {
  en: string
  ja: string
  source: string
  sourceUrl: string | null
}

const initialGlossary: GlossaryEntry[] = [
  { en: 'Transformer', ja: 'トランスフォーマー', desc: '自然言語処理の基盤となるニューラルネットワークアーキテクチャ。Self-attentionを中核とする。', source: 'Attention Is All You Need (Vaswani et al., 2017)', sourceUrl: 'https://arxiv.org/abs/1706.03762', confirmed: true },
  { en: 'attention', ja: '注意機構', desc: '入力の重要部分に重みを割り当てる機構。Transformerの中核をなす。', source: 'Attention Is All You Need (Vaswani et al., 2017)', sourceUrl: 'https://arxiv.org/abs/1706.03762', confirmed: true },
  { en: 'gradient descent', ja: '勾配降下法', desc: '損失関数の勾配方向にパラメータを更新する最適化アルゴリズム。', source: 'Deep Learning (Goodfellow et al., 2016)', sourceUrl: 'https://www.deeplearningbook.org/', confirmed: false },
  { en: 'overfitting', ja: '過学習', desc: '訓練データへの過剰適合により汎化性能が低下する現象。正則化で対処。', source: 'スライド第3回 p.12より抽出', sourceUrl: null, confirmed: false },
  { en: 'learning rate', ja: '学習率', desc: '勾配降下法でのパラメータ更新幅を制御するハイパーパラメータ。', source: 'Deep Learning (Goodfellow et al., 2016)', sourceUrl: 'https://www.deeplearningbook.org/', confirmed: false },
]

const initialExtracted: ExtractedTerm[] = [
  { en: 'backpropagation', ja: '誤差逆伝播法', source: 'Deep Learning (Goodfellow et al., 2016)', sourceUrl: 'https://www.deeplearningbook.org/' },
  { en: 'batch normalization', ja: 'バッチ正規化', source: 'スライド第4回 p.7より抽出', sourceUrl: null },
  { en: 'softmax', ja: 'ソフトマックス関数', source: 'スライド第2回 p.15より抽出', sourceUrl: null },
]

interface GlossaryContextValue {
  glossary: GlossaryEntry[]
  extracted: ExtractedTerm[]
  setGlossary: React.Dispatch<React.SetStateAction<GlossaryEntry[]>>
  setExtracted: React.Dispatch<React.SetStateAction<ExtractedTerm[]>>
}

const GlossaryContext = createContext<GlossaryContextValue>({
  glossary: initialGlossary,
  extracted: initialExtracted,
  setGlossary: () => {},
  setExtracted: () => {},
})

export function GlossaryProvider({ children }: { children: React.ReactNode }) {
  const [glossary, setGlossary] = useState<GlossaryEntry[]>(initialGlossary)
  const [extracted, setExtracted] = useState<ExtractedTerm[]>(initialExtracted)

  return (
    <GlossaryContext.Provider value={{ glossary, extracted, setGlossary, setExtracted }}>
      {children}
    </GlossaryContext.Provider>
  )
}

export function useGlossary() {
  return useContext(GlossaryContext)
}
