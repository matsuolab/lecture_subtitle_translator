"""
DL基礎講座用語集.xlsx → glossary.json 変換ツール

Usage:
    python tools/xlsx_to_glossary.py \
        --input "../../00_context/files/.../DL基礎講座用語集.xlsx" \
        --output ./glossary.json

出力ファイルは GlossaryEntry[] 形式（フロントエンドと共通）。
"""

from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path


def convert(input_path: str, output_path: str) -> None:
    try:
        import openpyxl
    except ImportError:
        raise SystemExit("openpyxl が必要です: pip install openpyxl")

    wb = openpyxl.load_workbook(input_path)
    ws = wb.active

    entries: list[dict] = []
    seen: set[tuple[str, str]] = set()
    skipped = 0

    for row in ws.iter_rows(min_row=2, values_only=True):
        ja = (str(row[2]) if row[2] else "").strip()
        en = (str(row[3]) if row[3] else "").strip()
        abbr = (str(row[4]) if row[4] else "").strip() or None

        if not ja or not en:
            skipped += 1
            continue

        key = (ja, en)
        if key in seen:
            skipped += 1
            continue
        seen.add(key)

        entries.append({
            "id": str(uuid.uuid4()),
            "ja": ja,
            "en": en,
            **({"abbr": abbr} if abbr else {}),
            "confirmed": True,
        })

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)

    print(f"変換完了: {len(entries)} 件 → {output_path}")
    print(f"スキップ（空・重複）: {skipped} 件")


def main() -> None:
    parser = argparse.ArgumentParser(description="xlsx → glossary.json 変換")
    parser.add_argument("--input", required=True, help="入力 xlsx ファイルパス")
    parser.add_argument("--output", required=True, help="出力 glossary.json パス")
    args = parser.parse_args()
    convert(args.input, args.output)


if __name__ == "__main__":
    main()
