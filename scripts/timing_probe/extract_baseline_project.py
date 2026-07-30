"""project.json の session.workLog.baseline.initialBlocks (手動編集前・旧コードの
パイプライン出力) を、compare_timings.py が読めるプロジェクトJSON形式で書き出す。

これは E2E 検証における「before」側のデータソースになる
(after 側は frontend/scripts/runPipelineE2E.ts が書き出す e2e_project.json)。

使い方:
    python scripts/timing_probe/extract_baseline_project.py <project.json> <出力先.json>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 2:
        print(
            "Usage: python scripts/timing_probe/extract_baseline_project.py "
            "<project.json> <out.json>",
            file=sys.stderr,
        )
        return 2

    project_path = Path(args[0])
    out_path = Path(args[1])

    with project_path.open(encoding="utf-8") as f:
        project = json.load(f)

    session = project.get("session")
    if not isinstance(session, dict):
        print(f"エラー: {project_path} に session キーがありません", file=sys.stderr)
        return 1

    work_log = session.get("workLog")
    if not isinstance(work_log, dict):
        print(f"エラー: {project_path} の session に workLog キーがありません", file=sys.stderr)
        return 1

    baseline = work_log.get("baseline")
    if not isinstance(baseline, dict):
        print(f"エラー: {project_path} の session.workLog に baseline キーがありません", file=sys.stderr)
        return 1

    initial_blocks = baseline.get("initialBlocks")
    if not isinstance(initial_blocks, list):
        print(
            f"エラー: {project_path} の session.workLog.baseline に "
            "initialBlocks 配列がありません",
            file=sys.stderr,
        )
        return 1

    blocks = []
    for b in initial_blocks:
        blocks.append(
            {
                "id": b["id"],
                "startTime": b["startTime"],
                "endTime": b["endTime"],
                "subtitle": b.get("subtitle", ""),
                "transcript": b.get("transcript", ""),
                "charCount": b.get("charCount", 0),
                "cps": b.get("cps", 0),
            }
        )

    out = {
        "version": 2,
        "savedAt": baseline.get("at", ""),
        "blocks": blocks,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"wrote {out_path} ({len(blocks)} blocks, origin={baseline.get('origin')!r}, at={baseline.get('at')!r})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
