"""
Step 8: 英訳テキストを字幕ブロックに分割する。

CPS / 文字数制約は SubtitleConstraints から受け取り、ハードコードしない。
言語ごとに異なる制約に対応（英語・日本語・中国語等）。

課題#15（cps_regen_poc_plan.md）の設計を実装:
- LLM に分割させた後 Python で文字数・CPS を検証
- 制約違反なら「短縮戦略を立案してから再生成」アプローチ（アイデア②）
- max_retry 回失敗したら flagged=True でそのまま通す
"""

from __future__ import annotations

from ..constraints import SubtitleConstraints
from ..models.segment import SubtitleBlock, TranslatedSegment
from ..providers.base import LLMProvider


def _build_split_system(constraints: SubtitleConstraints) -> str:
    return (
        "You are a subtitle editor following BBC/Netflix subtitle guidelines.\n"
        "Split the given English text into subtitle blocks that satisfy:\n"
        f"- Maximum {constraints.max_chars} characters per block (including spaces)\n"
        "- Natural sentence breaks (not mid-phrase)\n"
        "- Each block should be a coherent unit of meaning\n\n"
        "Output each block on a separate line. No numbering, no extra text."
    )


def _build_shorten_system(constraints: SubtitleConstraints) -> str:
    return (
        "You are a subtitle editor. The subtitle block below exceeds the "
        f"{constraints.max_chars}-character or {constraints.max_cps} CPS limit.\n"
        "First, plan how to shorten it (using pronouns, contractions, "
        "word reordering, or moving text to adjacent blocks).\n"
        "Then output the shortened version.\n\n"
        "Rules:\n"
        "- Do NOT change the meaning\n"
        "- Output format: PLAN: <your plan>\\nRESULT: <shortened text>"
    )


async def split_into_blocks(
    translated_segments: list[TranslatedSegment],
    llm: LLMProvider,
    constraints: SubtitleConstraints | None = None,
) -> list[SubtitleBlock]:
    """
    翻訳済みセグメントを字幕ブロックに分割する。

    時系列のタイムスタンプは aligner.py で後から付与するため、
    ここでは start/end を元セグメントの均等割りで仮設定する。
    """
    from ..constraints import SubtitleConstraints, load_constraints

    c = constraints or load_constraints().get_subtitle("en")
    split_sys = _build_split_system(c)
    shorten_sys = _build_shorten_system(c)

    blocks: list[SubtitleBlock] = []
    block_id = 0

    for seg in translated_segments:
        raw_text = seg.translated_text
        duration = (
            seg.corrected.original.end - seg.corrected.original.start
        )

        split_texts = await _split_text(raw_text, llm, split_sys, c)

        # 文字数比例でタイムスタンプを仮割り当て（aligner で上書きされる）
        total_chars = sum(len(t) for t in split_texts) or 1
        cursor = seg.corrected.original.start

        for text in split_texts:
            char_count = len(text)
            block_duration = duration * (char_count / total_chars)
            end = cursor + block_duration

            cps = char_count / block_duration if block_duration > 0 else 0.0
            cps_ok = cps <= c.max_cps and char_count <= c.max_chars

            if not cps_ok:
                text, cps_ok = await _try_shorten(
                    text, block_duration, llm, shorten_sys, c
                )
                char_count = len(text)
                cps = char_count / block_duration if block_duration > 0 else 0.0
                cps_ok = cps <= c.max_cps and char_count <= c.max_chars

            blocks.append(
                SubtitleBlock(
                    id=block_id,
                    start=cursor,
                    end=end,
                    text=text,
                    char_count=len(text),
                    cps=round(cps, 2),
                    cps_ok=cps_ok,
                    source_segment_id=seg.corrected.original.id,
                    flagged=not cps_ok,
                )
            )
            cursor = end
            block_id += 1

    return blocks


async def _split_text(
    text: str,
    llm: LLMProvider,
    system_prompt: str,
    constraints: SubtitleConstraints,
) -> list[str]:
    """テキストを LLM で字幕ブロックに分割する。"""
    if len(text) <= constraints.max_chars:
        return [text]

    response = await llm.complete(
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": text},
        ],
        temperature=0.1,
        max_tokens=512,
    )

    lines = [line.strip() for line in response.strip().splitlines() if line.strip()]
    return lines if lines else [text]


async def _try_shorten(
    text: str,
    duration: float,
    llm: LLMProvider,
    system_prompt: str,
    constraints: SubtitleConstraints,
) -> tuple[str, bool]:
    """
    CPS / 文字数違反のブロックを短縮する。
    アイデア②: 計画→実行アプローチ。max_retry 回失敗したら flagged のまま返す。
    """
    max_chars = min(constraints.max_chars, int(duration * constraints.max_cps))

    for _ in range(constraints.max_retry):
        response = await llm.complete(
            messages=[
                {"role": "system", "content": system_prompt},
                {
                    "role": "user",
                    "content": (
                        f"Duration: {duration:.2f}s\n"
                        f"Max chars: {max_chars}\n"
                        f"Text: {text}"
                    ),
                },
            ],
            temperature=0.3,
            max_tokens=256,
        )

        shortened = _extract_result(response, text)
        char_count = len(shortened)
        cps = char_count / duration if duration > 0 else 0.0

        if cps <= constraints.max_cps and char_count <= constraints.max_chars:
            return shortened, True

    # max_retry 回失敗 → flagged のままパス
    return text, False


def _extract_result(response: str, fallback: str) -> str:
    """RESULT: 行を抽出する。見つからなければ最後の非空行を使う。"""
    for line in response.strip().splitlines():
        if line.upper().startswith("RESULT:"):
            return line[len("RESULT:"):].strip()
    lines = [l.strip() for l in response.strip().splitlines() if l.strip()]
    return lines[-1] if lines else fallback
