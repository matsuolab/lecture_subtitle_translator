# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tauri v2 desktop app (`subtitle-editor`) that produces English subtitles from Japanese lecture videos. The app has two layers:

- **Frontend** (`frontend/`): React + TypeScript UI with an embedded TypeScript post-processing pipeline
- **Backend** (`backend/`): FastAPI + Python for audio extraction, WhisperX transcription, and managed/AWS modes

## Commands

**Frontend (run from `frontend/`):**
```bash
npm install
npm run dev          # Vite dev server on port 5173
npm run build        # tsc + vite build
npm run lint         # ESLint
npm run tauri:dev    # Tauri desktop dev (kills port 5173 first)
npm run tauri:build  # Production desktop build
```

**Backend (run from `lecture_subtitle_translator/`):**
```bash
cd backend
pip install -r requirements.txt
uvicorn backend.api:app --reload --port 8765
```

**Tests (run from `lecture_subtitle_translator/`):**
```bash
pytest backend/tests/                              # all tests
pytest backend/tests/test_pipeline_service.py      # single file
```

**Infra:**
```bash
# From infra/terraform/aws_dev/
terraform init && terraform plan
terraform apply
```

## Architecture

### Two independent pipelines

**1. Local path (frontend-only, no backend needed)**
- User loads a video → backend transcribes via WhisperX → frontend receives `TranscriptSegment[]`
- Frontend runs `runLocalPostPipeline()` (`src/lib/pipeline/localPipeline.ts`) in three phases:
  - **Phase 1** (`phase1.ts`): Japanese correction → sentence splitting (`splitJa`) → short-block merging
  - **Phase 2** (`phase2.ts`): Translation to English → CPS/line-length validation → correction agent loop
  - **Phase 3** (`phase3.ts`): Terminology check → `SubtitleBlock[]` assembly with review diagnostics
- The correction agent (`src/lib/pipeline/correctionAgent/`) is a mini tool-use loop with strategies: compress, split, borrow gap, offload neighbor, compress+rephrase

**2. Managed/AWS path (backend-routed)**
- Frontend calls `/v1/uploads` → `/v1/jobs` on the backend
- `backend/managed/factory.py` selects `LocalManagedAdapter` or `AwsManagedAdapter` based on `MANAGED_SERVICE_BACKEND` env var
- AWS mode submits to Batch; local mode wraps `PipelineService` directly

### Backend DAG engine (`backend/pipeline/`)

- `runner.py` — `DAGRunner`: walks a `WorkflowDefinition`, retries on failure, enforces `max_visits` per node
- `workflow.py` — `WorkflowDefinition` + `NodeSpec` + `Edge` (condition: `success | failure | always`)
- `registry.py` — `NodeRegistry`: maps string keys to `Node` factory callables
- `bootstrap.py` — wires all nodes into the default registry
- `workflows/drop_first.py` — three named workflows:
  - `drop_first_v1`: extract_audio → transcribe → correct → translate → subtitle
  - `drop_first_with_quality_v1`: adds semantic_check, terminology_check, cps_guard with retry loops
  - `managed_transcript_v1`: transcribe only (used by AWS Batch worker)
- `contracts.py` — `NodeContract` (schema versioning), `NodeResult`, `RunState`
- `service.py` — `PipelineService`: in-memory run store, executes DAGs in daemon threads
- `policy.py` — `PolicyEngine`: decides retry vs. stop per node result

### API endpoints (`backend/api.py`)

- `/api/pipeline/runs` — local DAG runner (no auth)
- `/v1/uploads`, `/v1/jobs`, `/v1/service-config`, `/v1/connection-check` — managed adapter (Bearer token auth when `MANAGED_SERVICE_AUTH_MODE=bearer_token`)

### Frontend component layout

- `App.tsx` — single-page root: tab router (subtitles / dictionary / help / report / settings), pipeline orchestration, video sync
- `src/api/pipelineClient.ts` — decides local vs. remote path; handles backend result shape normalization
- `src/api/persistence.ts` — localStorage, project JSON import/export, SRT import/export
- `src/api/adminSettings.ts` — reads/writes `AdminSettings` (API keys, model names, CPS limits, etc.)
- `src/context/` — React contexts for theme, locale (ja/en/zh), and glossary
- `src/types/subtitle.ts` — `SubtitleBlock` (core data model for each subtitle block)
- `src/types/adminSettings.ts` — `AdminSettings` (all user-configurable settings)

### Key env vars for backend (AWS mode)

| Var | Purpose |
|---|---|
| `MANAGED_SERVICE_BACKEND` | `aws` or `local` (default: `local`) |
| `MANAGED_SERVICE_AUTH_MODE` | `bearer_token` or `none` |
| `MANAGED_SERVICE_BEARER_TOKEN` | token value (or use `_SECRET_NAME` for Secrets Manager) |
| `AWS_REGION` / `MANAGED_SERVICE_AWS_*` | S3 buckets, DynamoDB table, Batch queue/job-def |

## Commit convention

Commit **early and often**. A branch should land as a series of small, self-contained
commits, not one large commit at the end. Each commit must build and pass tests on its
own, so that `git bisect` and per-commit review stay useful.

Split commits by *intent*, not by file. A refactor that moves code without changing
behavior, and the behavior change that follows it, are two commits — reviewing them
together is much harder than reviewing them apart. Likewise, keep incidental fixes found
along the way in their own commit rather than folding them into an unrelated change.

### Message format

```
<type>(<scope>): <何をしたか (現在形・日本語可)>

なぜこの変更が必要か（変更前に何が壊れていたか／何が言えなかったか）。
コードを読めば分かる「何を」ではなく、読んでも分からない「なぜ」を書く。

## 変更
- 具体的な変更点を列挙する
- 挙動が変わる場合は、変わる条件と変わらない条件を明示する

既定構成の挙動が変わらないなら、その旨とどう担保したか（テスト等）を書く。
```

`<type>` は `feat` / `fix` / `refactor` / `test` / `docs` / `chore`。

### The body must make the diff's intent self-evident

A reviewer should be able to read the message alone and know what to expect in the diff.
In particular:

- **不具合修正では、修正前に何が起きていたかを具体的に書く。** 「〜に対応」ではなく
  「`\b機械学習\b` は `\b` が `\w` 境界を要求するため常に不成立で、用語ハイライトが
  字幕側で常に不発だった」のように、失敗の機序まで書く。
- **消極的な変更（削除・無効化）ほど理由を厚く書く。** なぜ消してよいと判断したか、
  何を確認したかを残す。
- **一つのコミットに複数の変更が入る場合は `## 変更` で分節する。** 副次的な修正は
  `## 副次的な修正` として分けると、レビュー時に主目的と区別できる。

既存コミット `c7621dd` / `6cb4b33` がこの形式の実例。迷ったらそれに倣うこと。

### Code comments follow the same rule

コメントも同様に「なぜ」を書く。特に、非自明な判断・回避策・意図的に採らなかった選択肢は
コードからは復元できないため、必ずコメントに残す。自明な「何を」の説明は書かない。

## Script authoring convention

When writing standalone/PoC Python or TS scripts (e.g. `poc/*.py`, one-off verification scripts) that a human will iterate on by hand-tuning values, put every tunable variable (paths, model names, batch/sample sizes, thresholds, retry counts, feature flags) in a single `CONFIG` block at the top of the file — not scattered inline through the logic below. This is so the user can adjust behavior by editing one place instead of hunting through the script.

## Diagram authoring convention (Mermaid, architecture diagrams, etc.)

When producing a diagram (Mermaid or otherwise) for a report, proposal, or investigation doc, keep the diagram a neutral record of facts, not a persuasion device:

- Do not encode evaluative judgments (good/bad, OK/NG, bottleneck/fine) into diagram structure, subgraph grouping, color, or line weight/length. State evaluations and conclusions only in the surrounding prose, never inside the diagram itself.
- Only color the elements that are the actual subject of a change or comparison (e.g., the specific edge that was reordered). Leave everything else unstyled/neutral.
- Do not use visual exaggeration (thicker arrows for "the important path", warning-colored boxes, dramatized timing gaps) to make a point land harder than the underlying data supports.
- Use real identifiers in labels — actual Terraform resource/variable names, actual AWS status strings (e.g. `RUNNABLE`, not "waiting") — rather than paraphrased or dramatized labels, so the diagram stays checkable against source.
- Each diagram should be followed by 1–2 sentences stating what fact the diagram shows, with interpretation/recommendation kept in a separate paragraph.

This applies to any future diagram-drawing task in this repo (architecture diagrams, comparison before/after diagrams, state-transition diagrams), not just Terraform-related ones.

## Document management rules (from AGENTS.md)

| What | Where |
|---|---|
| Research/tech surveys | `docs/research/YYYYMMDD_<topic>.md` (required after any investigation) |
| Sprint tasks / open issues | `10_meetings/ongoing_issues.md` |
| Project phase status | `00_context/project_overview.md` |
| Meeting records | `10_meetings/YYYYMMDD_*.md` |
| Ideas / feature proposals | `docs/ideas.md` |

`task_list.md` is **deprecated** — do not read or write it.

Always check `.github/workflows/release.yml` and `build.yml` before documenting build/release procedures.

## AWS MCP rules

Always verify AWS MCP availability by directly calling `mcp__aws_mcp__aws___list_regions` or `mcp__aws_mcp__aws___search_documentation` first. A single `call_aws` failure does not mean AWS MCP is unavailable — classify the error type (auth, validation, throttling) before concluding anything.
