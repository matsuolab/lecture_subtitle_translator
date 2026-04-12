"""
Step 6: 補正済み日本語テキストを英語字幕スタイルで英訳する。
BBC/Netflix 字幕スタイルガイドに基づくプロンプトを使用。
"""

from __future__ import annotations

from ..models.segment import CorrectedSegment, TranslatedSegment
from ..providers.base import EmbedProvider, LLMProvider

_SYSTEM_PROMPT = """\
あなたは学術講義の字幕翻訳専門家です。
日本語テキストを英語字幕向けに翻訳してください。

【翻訳スタイルガイド（BBC/Netflix 字幕規範）】
1. 自然で読みやすい英語にする（直訳は避ける）
2. 学術的に正確な専門用語を使う
3. 短い文を優先する（読みやすさのため）
4. 日本語特有の回りくどい表現は英語として自然な形に整える
5. 意味を変えない範囲で英語として最も自然な語順・表現を選ぶ
6. 翻訳後のテキストのみを出力する（説明・コメント不要）

【重要】意味を損なう省略・要約は禁止。情報量を保つこと。\
"""

_USER_TEMPLATE = """\
【専門用語（日→英対応）】
{glossary}

【翻訳対象テキスト】
{transcript}

上記を英語字幕向けに翻訳してください。
出力形式: 各行を [番号] 翻訳後テキスト の形式で出力してください。\
"""


async def translate_segments(
    corrected_segments: list[CorrectedSegment],
    llm: LLMProvider,
    embed: EmbedProvider,
    flag_threshold: float = 0.25,
    batch_size: int = 20,
    glossary: tuple[str, ...] = (),
) -> list[TranslatedSegment]:
    """
    補正済みセグメントを英訳する。

    Args:
        corrected_segments: CorrectedSegment のリスト
        llm:                LLM Provider
        embed:              Embedding Provider（乖離チェック用）
        flag_threshold:     コサイン距離がこれを超えたら要確認フラグ
                            ※ 日→英は言語間距離があるため補正より高めに設定
        batch_size:         1回の LLM リクエストに含めるセグメント数
        glossary:           専門用語リスト（スライドPDFから抽出）

    Returns:
        TranslatedSegment のリスト
    """
    glossary_text = "、".join(glossary[:50]) if glossary else "（なし）"
    results: list[TranslatedSegment] = []

    for i in range(0, len(corrected_segments), batch_size):
        batch = corrected_segments[i : i + batch_size]
        translated_texts = await _translate_batch(batch, glossary_text, llm)

        for seg, translated_text in zip(batch, translated_texts):
            distance = await _embedding_distance(
                seg.corrected_text, translated_text, embed
            )
            results.append(
                TranslatedSegment(
                    corrected=seg,
                    translated_text=translated_text,
                    translation_distance=distance,
                    translation_flagged=distance > flag_threshold,
                )
            )

    return results


async def _translate_batch(
    segments: list[CorrectedSegment],
    glossary_text: str,
    llm: LLMProvider,
) -> list[str]:
    numbered_transcript = "\n".join(
        f"[{seg.original.id}] {seg.corrected_text}" for seg in segments
    )

    user_message = _USER_TEMPLATE.format(
        glossary=glossary_text,
        transcript=numbered_transcript,
    )

    response = await llm.complete(
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0.2,
        max_tokens=16384,
    )

    return _parse_numbered_response(response, segments)


def _parse_numbered_response(
    response: str, segments: list[CorrectedSegment]
) -> list[str]:
    translated_map: dict[int, str] = {}

    for line in response.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("[") and "]" in line:
            bracket_end = line.index("]")
            try:
                seg_id = int(line[1:bracket_end])
                text = line[bracket_end + 1 :].strip()
                translated_map[seg_id] = text
            except ValueError:
                continue

    return [
        translated_map.get(seg.original.id, seg.corrected_text)
        for seg in segments
    ]


async def _embedding_distance(
    text_a: str, text_b: str, embed: EmbedProvider
) -> float:
    import asyncio

    vec_a, vec_b = await asyncio.gather(
        embed.embed(text_a), embed.embed(text_b)
    )
    return embed.cosine_distance(vec_a, vec_b)
