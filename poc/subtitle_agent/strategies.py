"""方策カード v2 (カード2〜7). カード1 re_segment は cue.py.

【設計上の重要事実】
本データの語タイムスタンプは語間ギャップが全て0.0秒であり、キュー間に無音が無い。
そのため retime (時間延長) はほぼ機能しない (借りる無音が存在しない)。
CPS遵守の実質的な唯一の手段は condense_text (テキスト凝縮) である。
merge_cues は速いキューと遅いキューを結合して reading speed を平準化する補助手段。
"""

from dataclasses import replace

import openai

from poc.subtitle_agent import constants, prompts
from poc.subtitle_agent.cue import Cue
from poc.subtitle_agent.llm import clean_llm_output, translate_ja_to_en


def apply_line_break(text: str) -> str:
    """カード6: 1キューのテキストを最大2行に配置する (bottom-heavy)。

    1行に収まればそのまま。収まらなければ語境界で2分割し、
    調査の通り下の行を長くする (bottom-heavy)。
    """
    text = " ".join(text.replace("\n", " ").split())
    if len(text) <= constants.MAX_LINE_CHARS:
        return text

    words = text.split(" ")
    if len(words) < 2:
        return text  # 分割不能 (評価で違反としてフラグされる)

    # bottom-heavy: 上の行が全体の約45%になる分割点を選ぶ
    target = len(text) * 0.45
    best_idx, best_diff = 1, float("inf")
    cum = 0
    for i in range(1, len(words)):
        cum += len(words[i - 1]) + 1
        diff = abs(cum - target)
        if diff < best_diff:
            best_diff, best_idx = diff, i

    line1 = " ".join(words[:best_idx])
    line2 = " ".join(words[best_idx:])
    return f"{line1}\n{line2}"


def condense_text(
    en_text: str,
    severity: str,
    client: openai.OpenAI,
    model: str = constants.CHAT_MODEL,
    system_prompt: str = prompts.DEFAULT.condense,
) -> str:
    """カード2: 英語字幕を凝縮 (短縮) する。

    severity は短縮の強さの方向指示 ("shorter" / "much shorter" / "extremely short")。
    CLAUDE.md大原則によりLLMに文字数カウントは要求せず、方向のみ指示する。
    実際の文字数チェックは呼び出し側 (evaluate) が行う。
    """
    user_prompt = (
        f"Original English subtitle:\n{en_text}\n\n"
        f"Rewrite it to be {severity} while keeping the same meaning."
    )
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.2,
    )
    return clean_llm_output(response.choices[0].message.content)


def severity_for(cps: float) -> str:
    """CPS超過の深刻度から凝縮の強さ方向を決める。"""
    if cps > constants.TARGET_CPS * 1.6:
        return "extremely short"
    if cps > constants.TARGET_CPS * 1.25:
        return "much shorter"
    return "shorter"


def merge_pair(
    cue_a: Cue,
    cue_b: Cue,
    client: openai.OpenAI,
    model: str = constants.CHAT_MODEL,
    translate_prompt: str = prompts.DEFAULT.translate,
) -> Cue | None:
    """カード3: 隣接する2キューを結合し再翻訳する。

    結合後のキュー長が最長表示時間を超える場合は None (結合不可)。
    速すぎるキューを遅いキューと結合し reading speed を平準化するのに使う。
    """
    if cue_a.source_segment_id != cue_b.source_segment_id:
        return None
    merged_start = min(cue_a.start, cue_b.start)
    merged_end = max(cue_a.end, cue_b.end)
    if merged_end - merged_start > constants.MAX_CUE_DURATION:
        return None

    merged_ja = f"{cue_a.ja}{cue_b.ja}"
    merged_en = translate_ja_to_en(merged_ja, client, model, translate_prompt)
    return replace(
        cue_a,
        id=cue_a.id,
        start=round(merged_start, 3),
        end=round(merged_end, 3),
        ja=merged_ja,
        en=apply_line_break(merged_en),
        applied_strategies=cue_a.applied_strategies + ("merge_cues",),
    )
