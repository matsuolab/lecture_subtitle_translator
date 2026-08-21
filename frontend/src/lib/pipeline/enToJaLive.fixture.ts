import type { TranscriptSegment } from './types'

/**
 * WhisperX (ghcr.io/jim60105/whisperx:base-en, CPU) が実際に返した英語書きおこし。
 *
 * 単語タイムスタンプを含めることが重要。words が無いと alignConf が 'no_words' になり、
 * classifyViolation が proportional_ts を返して correctionEngine が走らなくなるため、
 * CPS・行長の修復経路を検証できない。
 * 1文目の 'In fact, propagation' は ASR の誤認識（正しくは Backpropagation）。
 * 補正ノードがこれを直せるかの検証も兼ねる。
 */
export const WHISPERX_EN_TRANSCRIPT: TranscriptSegment[] = [
  {
    id: 1,
    start: 0.002,
    end: 5.229,
    text: "In fact, propagation computes the gradient of the loss function with respect to every weight in the neural network.",
    words: [
      { word: "In", start: 0.002, end: 0.042 },
      { word: "fact,", start: 0.062, end: 0.202 },
      { word: "propagation", start: 0.222, end: 0.863 },
      { word: "computes", start: 0.903, end: 1.304 },
      { word: "the", start: 1.384, end: 1.464 },
      { word: "gradient", start: 1.504, end: 1.965 },
      { word: "of", start: 1.985, end: 2.065 },
      { word: "the", start: 2.105, end: 2.165 },
      { word: "loss", start: 2.205, end: 2.425 },
      { word: "function", start: 2.485, end: 2.846 },
      { word: "with", start: 2.886, end: 3.046 },
      { word: "respect", start: 3.086, end: 3.467 },
      { word: "to", start: 3.527, end: 3.667 },
      { word: "every", start: 3.727, end: 3.927 },
      { word: "weight", start: 3.967, end: 4.188 },
      { word: "in", start: 4.228, end: 4.288 },
      { word: "the", start: 4.328, end: 4.388 },
      { word: "neural", start: 4.428, end: 4.749 },
      { word: "network.", start: 4.789, end: 5.229 },
    ],
  },
  {
    id: 2,
    start: 5.53,
    end: 9.415,
    text: "This lecture explains how the chain rule makes that computation efficient.",
    words: [
      { word: "This", start: 5.53, end: 5.71 },
      { word: "lecture", start: 5.79, end: 6.17 },
      { word: "explains", start: 6.251, end: 6.711 },
      { word: "how", start: 6.771, end: 6.912 },
      { word: "the", start: 6.972, end: 7.052 },
      { word: "chain", start: 7.112, end: 7.352 },
      { word: "rule", start: 7.372, end: 7.572 },
      { word: "makes", start: 7.632, end: 7.853 },
      { word: "that", start: 7.933, end: 8.073 },
      { word: "computation", start: 8.133, end: 8.894 },
      { word: "efficient.", start: 8.934, end: 9.415 },
    ],
  },
]
