"""
Step 3: スライド PDF から専門用語リストとスライドテキストを抽出する。
pymupdf (fitz) を使用。

図・数式が多いスライドの場合は将来的に Vision API 対応に切り替え可能。
"""

from __future__ import annotations

import re
from pathlib import Path

import fitz  # type: ignore[import]  # pymupdf

from ..models.segment import SlideContext


def extract_slide_context(pdf_path: str) -> SlideContext:
    """
    PDF からスライドテキストと専門用語を抽出する。

    Args:
        pdf_path: スライド PDF のパス

    Returns:
        SlideContext（専門用語リスト + 全スライドテキスト）

    Raises:
        FileNotFoundError: PDF ファイルが存在しない
    """
    path = Path(pdf_path).resolve()
    if not path.exists():
        raise FileNotFoundError(f"PDF が見つかりません: {path}")

    doc = fitz.open(str(path))
    page_texts: list[str] = []

    for page in doc:
        text = page.get_text("text")
        if text.strip():
            page_texts.append(text.strip())

    doc.close()

    full_text = "\n\n".join(page_texts)
    glossary = _extract_glossary(full_text)

    return SlideContext(
        glossary=tuple(glossary),
        slide_text=full_text,
        source_path=str(path),
    )


def _extract_glossary(text: str) -> list[str]:
    """
    テキストから専門用語候補を抽出する。

    抽出ルール:
    - カタカナ語（3文字以上）
    - 英数字混在の技術用語（CamelCase, UPPER_CASE, 略語等）
    - 重複排除・頻度順
    """
    candidates: list[str] = []

    # カタカナ語（3文字以上）
    katakana_terms = re.findall(r"[ァ-ヶー]{3,}", text)
    candidates.extend(katakana_terms)

    # 英語技術用語（大文字始まりまたは全大文字、2文字以上）
    # 例: WhisperX, BERT, GPT-4, CPS, SRT
    english_terms = re.findall(
        r"\b(?:[A-Z][a-zA-Z0-9\-\.]{1,}|[A-Z]{2,}[0-9\-\.]*)\b", text
    )
    candidates.extend(english_terms)

    # 頻度でソートして重複除去
    freq: dict[str, int] = {}
    for term in candidates:
        freq[term] = freq.get(term, 0) + 1

    # 頻度2回以上 or 英語術語（頻度1でも保持）
    glossary = sorted(
        set(
            term for term, count in freq.items()
            if count >= 2 or re.match(r"[A-Za-z]", term)
        ),
        key=lambda t: -freq[t],
    )

    return glossary
