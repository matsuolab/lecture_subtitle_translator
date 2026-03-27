"""
PoC: 改良版翻訳プロンプト APIテスト

処理フロー:
  サンプルSRT（日英両方入り）
    ↓ 日本語のみ抽出
    ↓ Gemini APIに改良版プロンプトで投げる
    ↓ Gemini訳 vs 人間訳の比較ファイルを出力

使用方法:
  .venv\Scripts\Activate.ps1
  python poc_translation_test.py

出力: results/translation_comparison_YYYYMMDD_HHMMSS.txt
"""

import os
import re
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

# ---------------------------------------------------------------------------
# 設定
# ---------------------------------------------------------------------------
SAMPLE_SRT = Path(
    "../00_context/files/"
    "翻訳サンプルデータ-20260325T021329Z-3-001/"
    "翻訳サンプルデータ/"
    "DL基礎_day2_EN仮訳.txt"
)
OUTPUT_DIR   = Path("results")
TEST_BLOCKS  = 50        # テストするブロック数（Noneで全件）
MODEL        = "gemini-3.1-pro-preview"

# ---------------------------------------------------------------------------
# APIバージョンの翻訳プロンプト（インタラクティブフロー除去）
# ---------------------------------------------------------------------------
TRANSLATION_PROMPT = """Role

You are a subtitle translator: Japanese university lectures → concise English.

Your output goes to a subtitle formatter next. Write short, clean, splittable English.

A human editor will review and trim your output. Give them natural sentences that are easy to work with.



Inputs

Transcription (SRT) — Japanese ASR with timecodes

Term priority

Glossary > Slide PDF > Your judgment



Important context

These subtitles are for archived lecture videos.

The primary audience is students enrolled in the course (including international students who rely on English subtitles). External viewers also watch the archive.

This means: factual information about the course, community, and events is valuable even in archive. But live-only actions (pressing buttons, clicking chat links, sharing screens) are not.



Step 0: Proper noun list (output FIRST, before any translation)

Before translating, scan the entire input and output a proper noun reference list.

Format:

=== Proper Noun List ===
[Japanese] → [English] (category)
=== End of List ===

Rules for this list:

Include ALL names of people, organizations, platforms, events, projects, technical terms with established English forms, and abbreviations/role titles.
For platform/service names: reproduce the original spelling exactly.
For people: family name + given name in Western order.
For abbreviations: keep as-is unless the speaker explicitly expands them. Flag unclear ones with [?].
If unsure of English spelling, flag with [?] for human review.

After outputting this list, proceed to Step 1.



Step 1: Clean the Japanese

Delete fillers: えー, あの, その, まあ, ですね, なんか, etc.
Delete false starts, self-corrections, redundant restatements.
Fix ASR errors using slide context (効果↔降下, 回帰↔快気, 松井→松尾).
Keep the cleaned Japanese in Japanese. Do not insert English names or terms into the Japanese line.


Step 2: Translate to concise English

Core principle
Subtitle English must be SHORT. A viewer reads these in a few seconds. Every unnecessary word is a burden.

Subtitle-specific writing rules
Each subtitle block is displayed alone on screen. The previous block disappears.
The viewer cannot look back. Write every block so it stands on its own.

Pronouns — avoid cross-block references:
  Do NOT start a block with "This," "That," "It," or "These" referring to something in the previous block.
  Repeat the noun instead: "This method..." → "Agentic RAG..." or "The agent..."
  If repeating feels heavy, restructure the sentence.
  Pronouns WITHIN the same block are fine.

No front-heavy structures:
  Do NOT start with long subordinate clauses.
  NG: "To overcome manual costs and quality drops from stale data, we introduced..."
  OK: "We introduced an event-driven pipeline. It handles stale data and manual costs."
  Do NOT use "What we do is..." / "What this means is..." patterns.
  Subject and verb first, then the rest.

Write like a human subtitle editor, not like an AI:
  Prefer casual-academic over formal-academic.
  Use contractions where natural: "we'll," "it's," "don't"
  Avoid nominalizations: "utilization" → "use," "implementation" → say what was built
  The human editor's next step is to shorten your text further. Give them clean, natural sentences they can trim — not stiff, perfect prose.

What to keep vs what to cut — the key distinction
The rule is NOT "lecture content = keep, logistics = cut."
The rule is: keep factual information, cut live-only actions.

KEEP (factual information — valuable for all viewers including archive):
  Who is speaking, what they will talk about
  What a community/project/event is and how it works
  How to join, how to apply, what the schedule is
  Background, motivation, numbers

CUT (live-only actions — meaningless in archive):
  "チャットにリンクを貼ってください"
  "画面共有します" / "画面を出してください"
  "いいねを押してください" / "スクショを撮ってください"
  "リンクはチャットに貼りました"

When a sentence mixes both, keep the factual part and drop the live-action part.

Compression rules
Use short forms:
  "make a decision" → "decide"
  "in order to" → "to"
  "at this point in time" → "now"
  "it is possible to" → "we can" / "you can"
  "there is a need to" → "we need to"

Use active voice:
  "X is calculated by the model" → "The model calculates X"

Cut meta-talk within lecture content:
  "What I want to explain here is..." → [just explain it]
  "As I mentioned earlier..." → [omit unless critical callback]
  "Let me move on to the next topic" → [omit]

Cut redundancy:
  If the speaker says the same thing twice in different words, keep the clearer version only.

Important: Do NOT omit content because it appears on slides.
The slides are in Japanese. English-speaking viewers rely on the subtitles.

Handle katakana correctly:
  Reverse-engineer to proper English using slides as authority.
  Wasei-eigo → real English: ノートパソコン → "laptop", not "note PC"

What you must NEVER cut
Technical terms, definitions, equation/theorem names
Named methods and frameworks
Proper nouns, researcher names, variable names (case-sensitive)
Logical connectors: "therefore," "however," "because"
Numbers, units, formulas

Honorifics and politeness
Keigo: Flatten to neutral academic English.
Japanese honorifics (さん, 先生, 様): Omit. Exception: "X先生" in academic context → "Professor X."

Proper noun consistency
Use the full form from your Proper Noun List on first occurrence.
Use the short form (if defined) for all subsequent occurrences.
Never alter the spelling of platform/service names.

Write for easy line-splitting
Short sentences. Prefer two short sentences over one long one.
SVO order. Subject first.
Keep together: article + noun, phrasal verbs, first name + last name.
Avoid stacking relative clauses.

Notation and formatting
Numbers: Spell out one through ten. Use digits for 11 and above.
Mathematical expressions — spell out: f(x) → "f of x"
Programming and variable names: Reproduce exactly as on slides, case-sensitive.
Greek letters: Spell out: alpha, beta, theta, sigma, lambda, epsilon.
No special formatting: No LaTeX, no markdown, no HTML. Plain text only.

Punctuation (American English):
  Periods and commas inside quotation marks.
  Serial comma: "A, B, and C"

Output format
First: Proper Noun List (see Step 0)
Then: Translation in a single ```srt code block

Format per block: [sequential number] → [timecode] → [cleaned Japanese] → [English translation]

Timecodes must be preserved exactly as given — do not alter by even 1 millisecond.

Example:

1
00:00:10,370 --> 00:00:16,280
これからディープラーニング基礎講座、機械学習基礎の講義パートを始めます
We'll now begin the Machine Learning Basics lecture.

2
00:00:16,280 --> 00:00:20,450
松尾岩沢研究室の河野誠です。
I'm Makoto Kawano from the Matsuo-Iwasawa Laboratory.

Translate ALL blocks in the input. Do not stop or ask for confirmation.
"""


# ---------------------------------------------------------------------------
# SRTパース
# ---------------------------------------------------------------------------
@dataclass
class SrtBlock:
    index: int
    timecode: str
    japanese: str
    english: str  # サンプルの人間訳（比較用）


def parse_bilingual_srt(path: Path, max_blocks: int | None = None) -> list[SrtBlock]:
    """日英2行セットのSRTをパース"""
    text = path.read_text(encoding="utf-8")
    raw_blocks = re.split(r"\n\n+", text.strip())

    blocks = []
    for raw in raw_blocks:
        lines = raw.strip().splitlines()
        if len(lines) < 3:
            continue
        try:
            idx = int(lines[0].strip())
        except ValueError:
            continue
        timecode = lines[1].strip()
        content = lines[2:]

        # 日本語と英語を分離（日本語は日本語文字を含む行、英語はそれ以外）
        japanese_lines = [l for l in content if re.search(r"[\u3040-\u9fff]", l)]
        english_lines  = [l for l in content if not re.search(r"[\u3040-\u9fff]", l)]

        blocks.append(SrtBlock(
            index=idx,
            timecode=timecode,
            japanese=" ".join(japanese_lines),
            english=" ".join(english_lines),
        ))
        if max_blocks and len(blocks) >= max_blocks:
            break

    return blocks


def make_japanese_srt(blocks: list[SrtBlock]) -> str:
    """日本語のみのSRT文字列を生成（APIへの入力）"""
    parts = []
    for b in blocks:
        parts.append(f"{b.index}\n{b.timecode}\n{b.japanese}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# API呼び出し
# ---------------------------------------------------------------------------
def translate(japanese_srt: str) -> str:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY または GOOGLE_API_KEY が未設定です")

    client = genai.Client(api_key=api_key)
    prompt = TRANSLATION_PROMPT + "\n\n---\n\n" + japanese_srt
    response = client.models.generate_content(
        model=MODEL,
        contents=prompt,
    )
    return response.text


# ---------------------------------------------------------------------------
# 比較ファイル出力
# ---------------------------------------------------------------------------
def save_comparison(blocks: list[SrtBlock], gemini_output: str, output_path: Path) -> None:
    lines = [
        f"# 翻訳比較レポート",
        f"# 生成日時: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        f"# モデル: {MODEL}",
        f"# テストブロック数: {len(blocks)}",
        "",
        "=" * 80,
        "## Gemini API 出力（全文）",
        "=" * 80,
        gemini_output,
        "",
        "=" * 80,
        "## ブロック別比較（人間訳 vs Gemini訳）",
        "=" * 80,
        "※ Gemini訳はAPIの生出力から自動抽出（パース誤りがある場合あり）",
        "",
    ]

    # Gemini出力からSRTブロックを抽出してブロック別比較
    srt_match = re.search(r"```srt\n(.*?)```", gemini_output, re.DOTALL)
    gemini_blocks: dict[int, str] = {}
    if srt_match:
        srt_text = srt_match.group(1)
        for raw in re.split(r"\n\n+", srt_text.strip()):
            raw_lines = raw.strip().splitlines()
            if len(raw_lines) < 3:
                continue
            try:
                idx = int(raw_lines[0].strip())
            except ValueError:
                continue
            # 最後の行が英語訳
            gemini_blocks[idx] = raw_lines[-1]

    for b in blocks:
        lines.append(f"[{b.index}] {b.timecode}")
        lines.append(f"  JA : {b.japanese}")
        lines.append(f"  人間: {b.english}")
        lines.append(f"  AI  : {gemini_blocks.get(b.index, '(抽出失敗)')}")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"比較ファイル出力: {output_path}")


# ---------------------------------------------------------------------------
# メイン
# ---------------------------------------------------------------------------
def main() -> None:
    print(f"サンプルSRT読み込み: {SAMPLE_SRT}")
    blocks = parse_bilingual_srt(SAMPLE_SRT, max_blocks=TEST_BLOCKS)
    print(f"  → {len(blocks)} ブロック読み込み完了")

    japanese_srt = make_japanese_srt(blocks)
    print(f"  → 日本語SRT生成完了 ({len(japanese_srt)} 文字)")

    print(f"\nGemini API呼び出し中 (model={MODEL}) ...")
    gemini_output = translate(japanese_srt)
    print("  → 完了")

    OUTPUT_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_path = OUTPUT_DIR / f"translation_comparison_{timestamp}.txt"
    save_comparison(blocks, gemini_output, output_path)


if __name__ == "__main__":
    main()
