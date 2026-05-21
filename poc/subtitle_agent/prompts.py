"""自己進化の対象となるプロンプト群 (Phase 3 のメタ進化が変異させる config).

PromptSet は「製品パイプライン A の振る舞いを決める設定」であり、
自己進化ハーネス B はこの PromptSet を改善することで A を磨く。
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class PromptSet:
    """パイプラインが使うプロンプト一式。immutable。"""

    translate: str       # 日本語 -> 英語 字幕翻訳
    condense: str        # 英語字幕の凝縮 (短縮)
    segment: str         # 日本語を意味の塊で再分割する候補の提案 (強モデル役)

    label: str = "baseline"


_DEFAULT_TRANSLATE = (
    "Translate the following Japanese lecture transcript segment into natural "
    "English for video subtitles. The output must be short, clear, and direct. "
    "Prefer active voice and concise wording. Output ONLY the raw English "
    "translation. Do not write notes, markdown, explanation, or quotes."
)

_DEFAULT_CONDENSE = (
    "You are a professional subtitle editor. Rewrite the English subtitle to be "
    "shorter while preserving the exact meaning of the lecture content. "
    "Use active voice and shorter synonyms; remove filler words, redundant "
    "phrases, and hedging. Keep technical terms accurate. "
    "Output ONLY the optimized raw English subtitle, no explanation or quotes."
)

# 強モデル (本番=設定モデル) に意味の塊での再分割候補を複数提案させる。
# 日本語校正は工程0 (correct.py) が済ませているため、ここでは分割のみ行わせる
# (Design A 破棄, docs/research/20260521_*.md)。
# CLAUDE.md大原則どおり、LLM の役割は「意味」側 (意味の塊を作る)。
# 各候補の時間/文字数制約の良し悪しはコード (cue.score_candidate) が採点する。
_DEFAULT_SEGMENT = (
    "You organize a Japanese university lecture transcript segment into "
    "subtitle cues.\n\n"
    "The Japanese text has already been proofread. Do NOT change, rephrase, "
    "summarize, translate, or add any text. Your ONLY edit is inserting the "
    "delimiter '|'. Keep every other character byte-for-byte identical.\n\n"
    "Split the text into subtitle cues with the delimiter '|'. A cue is one "
    "on-screen subtitle and must be a semantically COHERENT unit -- a single "
    "definition, step, example, reason, or contrast -- never an arbitrary "
    "fragment cut mid-thought.\n"
    "Propose SEVERAL distinct candidate splits that trade off differently "
    "between cue length and coherence.\n"
    "Output ONLY this XML, nothing else:\n"
    "<candidates>\n"
    "  <candidate>first split with | delimiters</candidate>\n"
    "  <candidate>second split with | delimiters</candidate>\n"
    "  <candidate>third split with | delimiters</candidate>\n"
    "</candidates>"
)

DEFAULT = PromptSet(
    translate=_DEFAULT_TRANSLATE,
    condense=_DEFAULT_CONDENSE,
    segment=_DEFAULT_SEGMENT,
    label="baseline",
)
