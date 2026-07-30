"""
frontend/src/lib/pipeline/asrAlignment.test.ts で使う実データフィクスチャを抽出する。

scripts/timing_probe/out/whisperx_raw.json の segments[5], segments[6]
(147.48s-201.65s、いわゆる seg6/seg7) の words[] を
frontend/src/lib/pipeline/__fixtures__/asrAlignment.seg6seg7.json に書き出す。

実行:
    python scripts/timing_probe/extract_fixture.py
"""
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SRC = REPO_ROOT / "scripts" / "timing_probe" / "out" / "whisperx_raw.json"
DEST = REPO_ROOT / "frontend" / "src" / "lib" / "pipeline" / "__fixtures__" / "asrAlignment.seg6seg7.json"


def main() -> None:
    with SRC.open(encoding="utf-8") as f:
        data = json.load(f)

    segments = data["segments"]
    # 0-indexed 5,6 = 1-indexed seg6, seg7 (147.48-174.21, 174.91-201.65)
    picked = [segments[5], segments[6]]

    fixture = {
        "segments": [
            {
                "id": index + 6,
                "start": segment["start"],
                "end": segment["end"],
                "text": segment.get("text", ""),
                "words": [
                    {
                        "word": word.get("word", ""),
                        "start": word.get("start"),
                        "end": word.get("end"),
                        "score": word.get("score"),
                    }
                    for word in segment.get("words", [])
                    if "start" in word and "end" in word
                ],
            }
            for index, segment in enumerate(picked)
        ],
    }

    DEST.parent.mkdir(parents=True, exist_ok=True)
    with DEST.open("w", encoding="utf-8") as f:
        json.dump(fixture, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"wrote {DEST}")
    for segment in fixture["segments"]:
        print(segment["id"], segment["start"], segment["end"], len(segment["words"]), "words")


if __name__ == "__main__":
    main()
