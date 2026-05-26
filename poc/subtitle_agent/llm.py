"""LM Studio (ローカルLLM) クライアントと翻訳・整形ヘルパ.

232セグメントの一括翻訳・リライトはコスト管理のためローカル gemma に委譲する。
Claude (Agent SDK) は方策プランニングとメタ反省にのみ用いる。
"""

import re

import openai

from poc.subtitle_agent import constants


def make_local_client() -> openai.OpenAI:
    """LM Studio (OpenAI互換API) クライアントを生成する。"""
    return openai.OpenAI(base_url=constants.LM_STUDIO_BASE_URL, api_key="lm-studio")


def clean_llm_output(text: str) -> str:
    """LLMが余分に出力したマークダウン・クォートを取り除く。"""
    text = text.strip()
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    if text.startswith("'") and text.endswith("'"):
        text = text[1:-1].strip()
    text = re.sub(r"```[a-zA-Z]*\n", "", text)
    text = text.replace("```", "")
    return text.strip()


def translate_ja_to_en(
    ja_text: str,
    client: openai.OpenAI,
    model: str = constants.CHAT_MODEL,
    system_prompt: str | None = None,
) -> str:
    """日本語から英語への字幕翻訳。

    system_prompt を省略すると既定の翻訳方向性プロンプトを使う。
    自己進化ハーネス (Phase 3) はこの system_prompt を進化対象にする。
    """
    if system_prompt is None:
        system_prompt = (
            "Translate the following Japanese lecture transcript segment into "
            "natural English for video subtitles. The output must be short, "
            "clear, and direct. Output ONLY the raw English translation. "
            "Do not write any notes, markdown, explanation, or quotes."
        )
    # temperature=0: 翻訳を決定論化する。確率的だと同一 PromptSet でも世代ごとに
    # スコアがブレ、自己進化が「ノイズを信号として」読んでしまうため。
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": ja_text},
        ],
        temperature=0.0,
    )
    return clean_llm_output(response.choices[0].message.content)
