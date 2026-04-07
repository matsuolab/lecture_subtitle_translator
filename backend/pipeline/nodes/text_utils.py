from __future__ import annotations

import re
from typing import Iterable

_FILLERS = (
    "えー",
    "ええ",
    "あの",
    "あのー",
    "えーと",
    "そのー",
    "まあ",
)


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def remove_fillers(text: str) -> str:
    out = text
    for filler in _FILLERS:
        out = out.replace(filler, "")
    return normalize_spaces(out)


def split_ja_sentences(text: str) -> list[str]:
    text = text.replace("\r\n", "\n")
    chunks = re.split(r"[。！？\n]+", text)
    lines = [normalize_spaces(c) for c in chunks if normalize_spaces(c)]
    return lines


def apply_term_replacements(text: str, terms: Iterable[dict]) -> str:
    out = text
    for term in terms:
        src = str(term.get("from") or "")
        dst = str(term.get("to") or "")
        if src and dst:
            out = out.replace(src, dst)
    return normalize_spaces(out)


def split_en_lines_42(text: str, max_chars: int = 42) -> str:
    text = normalize_spaces(text)
    if len(text) <= max_chars:
        return text

    words = text.split(" ")
    if len(words) <= 1:
        return text[:max_chars] + "\n" + text[max_chars: max_chars * 2]

    best = len(text) // 2
    best_dist = float("inf")
    pos = 0
    for w in words[:-1]:
        pos += len(w)
        dist = abs(pos - len(text) // 2)
        if dist < best_dist and pos <= max_chars:
            best_dist = dist
            best = pos
        pos += 1

    left = text[:best].rstrip()
    right = text[best:].lstrip()
    return f"{left}\n{right}" if right else left
