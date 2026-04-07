"""
Step 4: 書き起こしを LLM で日本語補正する。
- フィラー語除去（えー、あの、まあ 等）
- 専門用語の誤認識補正（スライドPDF文脈を使用）
- 文体整形（口語→書き言葉）
"""

from __future__ import annotations

from ..models.segment import CorrectedSegment, SlideContext, TranscriptSegment
from ..providers.base import EmbedProvider, LLMProvider

_SYSTEM_PROMPT = """\
あなたは講義動画の書き起こしテキストを校正する専門家です。
以下のルールに従って書き起こしテキストを修正してください。

【修正ルール】
1. フィラー語を除去する（「えー」「あの」「まあ」「ちょっと」等）
2. 専門用語リストにある用語が誤認識されている場合は正しい表記に修正する
3. 口語表現を自然な書き言葉に整える
4. 文の意味・情報量は変えない（要約・追加は禁止）
5. 修正後のテキストのみを出力する（説明・コメント不要）

【重要】意味を大きく変える修正は絶対にしないこと。\
"""

_USER_TEMPLATE = """\
【専門用語リスト】
{glossary}

【スライドテキスト（参考）】
{slide_text}

【書き起こしテキスト】
{transcript}

上記の書き起こしテキストを修正してください。\
"""


async def correct_segments(
    segments: list[TranscriptSegment],
    slide_context: SlideContext | None,
    llm: LLMProvider,
    embed: EmbedProvider,
    flag_threshold: float = 0.15,
    batch_size: int = 20,
) -> list[CorrectedSegment]:
    """
    書き起こしセグメントを LLM で補正する。

    Args:
        segments:        TranscriptSegment のリスト
        slide_context:   PDF から抽出したスライドコンテキスト（None なら省略）
        llm:             LLM Provider
        embed:           Embedding Provider（乖離チェック用）
        flag_threshold:  コサイン距離がこれを超えたら要確認フラグ
        batch_size:      1回の LLM リクエストに含めるセグメント数

    Returns:
        CorrectedSegment のリスト
    """
    glossary_text = (
        "、".join(slide_context.glossary[:100]) if slide_context else "（なし）"
    )
    slide_text_excerpt = (
        slide_context.slide_text[:2000] if slide_context else "（なし）"
    )

    results: list[CorrectedSegment] = []

    for i in range(0, len(segments), batch_size):
        batch = segments[i : i + batch_size]
        corrected_texts = await _correct_batch(
            batch, glossary_text, slide_text_excerpt, llm
        )

        for seg, corrected_text in zip(batch, corrected_texts):
            distance = await _embedding_distance(seg.text, corrected_text, embed)
            results.append(
                CorrectedSegment(
                    original=seg,
                    corrected_text=corrected_text,
                    correction_distance=distance,
                    correction_flagged=distance > flag_threshold,
                )
            )

    return results


async def _correct_batch(
    segments: list[TranscriptSegment],
    glossary_text: str,
    slide_text_excerpt: str,
    llm: LLMProvider,
) -> list[str]:
    """バッチ単位で LLM に補正を依頼し、補正後テキストのリストを返す。"""
    numbered_transcript = "\n".join(
        f"[{seg.id}] {seg.text}" for seg in segments
    )

    user_message = _USER_TEMPLATE.format(
        glossary=glossary_text,
        slide_text=slide_text_excerpt,
        transcript=numbered_transcript,
    )
    user_message += (
        "\n\n出力形式: 各行を [番号] 修正後テキスト の形式で出力してください。"
    )

    response = await llm.complete(
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": user_message},
        ],
        temperature=0.1,
    )

    return _parse_numbered_response(response, segments)


def _parse_numbered_response(
    response: str, segments: list[TranscriptSegment]
) -> list[str]:
    """
    LLM の番号付き応答をパースして補正テキストのリストを返す。
    パースに失敗したセグメントは元のテキストをそのまま使用する。
    """
    corrected_map: dict[int, str] = {}

    for line in response.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        # "[123] テキスト" の形式を想定
        if line.startswith("[") and "]" in line:
            bracket_end = line.index("]")
            try:
                seg_id = int(line[1:bracket_end])
                text = line[bracket_end + 1 :].strip()
                corrected_map[seg_id] = text
            except ValueError:
                continue

    return [corrected_map.get(seg.id, seg.text) for seg in segments]


async def _embedding_distance(
    text_a: str, text_b: str, embed: EmbedProvider
) -> float:
    """2つのテキスト間のコサイン距離を返す。"""
    vec_a, vec_b = await _parallel_embed(text_a, text_b, embed)
    return embed.cosine_distance(vec_a, vec_b)


async def _parallel_embed(
    text_a: str, text_b: str, embed: EmbedProvider
) -> tuple[list[float], list[float]]:
    import asyncio

    return await asyncio.gather(embed.embed(text_a), embed.embed(text_b))
