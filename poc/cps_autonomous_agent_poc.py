#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
 matsuo-subtitle-pipeline - 字幕最適化エージェントPoC (自律的方策探索ループ・自己進化メタ改善)

 概要:
   実際の講義動画ファイルから音声を抽出し、Docker上の WhisperX サーバーを呼び出して
   タイムスタンプ付きの書き起こし (corrected_segments 相当) を動的に生成してキャッシュ化。
   ローカルの LM Studio (gemma-4-e4b-it / text-embedding-qwen3-embedding-0.6b) と、
   分析・自己進化用の Gemini 3.5 Flash を組み合わせ、CPS制限 (CPS < 15.0) および行文字数制約 (1行最大40文字) を
   最大化する最適方策コンボを自律探索し、さらにその自律探索ループ自体（プロンプトや制約指示）を
   メタモデルが自動改善して世代を回す、完全に自己完結した「自己進化メタ改善ループ」の PoC。

 使用方法:
   python poc/cps_autonomous_agent_poc.py --video <動画ファイルのパス> [--force] [--generations <世代数>]

 例:
   python poc/cps_autonomous_agent_poc.py --video "00_context/files/テスト用会議風音声.mp4" --generations 2
"""

import sys
import os
import argparse
import json
import time
import re
import math
from pathlib import Path
from dotenv import load_dotenv

# プロジェクトのルートディレクトリを sys.path に追加してバックエンドモジュールをインポート可能にする
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.append(str(PROJECT_ROOT))

# バックエンドモジュール群のインポート
try:
    from backend.pipeline.contracts import RunState
    from backend.pipeline.nodes.extract_audio import ExtractAudioNode
    from backend.pipeline.nodes.transcribe import TranscribeNode
    from backend.pipeline.nodes.correct import CorrectNode
except ImportError as e:
    print(f"[ERROR] バックエンドモジュールのインポートに失敗しました。プロジェクトルートから実行しているか確認してください。: {e}")
    sys.exit(1)

# APIクライアント
import openai
from google import genai
from google.genai import types

load_dotenv()

# ---------------------------------------------------------------------------
# 定数とデフォルト設定
# ---------------------------------------------------------------------------
LM_STUDIO_BASE_URL = "http://localhost:1234/v1"
CHAT_MODEL = "gemma-4-e4b-it"
EMBEDDING_MODEL = "text-embedding-qwen3-embedding-0.6b"

# スコアリング重み
W_ALIGN = 1.2    # 意味類似度の重み
W_CPS = 1.5      # CPS超過ペナルティの重み
W_LEN = 1.0      # 行文字数超過ペナルティの重み
W_TIME = 0.1     # 処理時間コストペナルティの重み

# 閾値
TARGET_CPS = 15.0
MAX_LINE_CHARS = 40
SIMILARITY_THRESHOLD = 0.85  # これを下回ると意味崩壊とみなして却下 (Score=0)

# ---------------------------------------------------------------------------
# 動的プロンプト管理機構 (PromptManager)
# ---------------------------------------------------------------------------
class PromptManager:
    """自律探索で使用されるプロンプト（英語/日本語リライト）を動的に管理するクラス"""
    def __init__(self):
        self.en_rewrite_prompt = (
            "You are a professional subtitle editor. Your task is to rewrite the English subtitle to be shorter to fit CPS constraints, while preserving the exact meaning.\n"
            "Use active voice, shorter synonyms, and eliminate unnecessary filler words. Use at most 2 lines, and at most 40 characters per line.\n"
            "Output ONLY the optimized raw English subtitle, no explanations, no markdown, no quotes."
        )
        self.ja_rewrite_prompt = (
            "あなたはプロの字幕編集者です。与えられた講義の日本語書き起こしを、意味を一切損なわずに「最も文字数が少なく簡潔な表現」にリライトしてください。\n"
            "接続詞、重複表現、フィラー（「ええと」「その」など）、冗長な敬語（「〜させていただきます」→「〜します」）は徹底的に削ってください。\n"
            "出力はリライト後の日本語のみとし、説明や括弧、マークダウンは一切含めないでください。"
        )
        self.history = {
            0: {
                "en": self.en_rewrite_prompt,
                "ja": self.ja_rewrite_prompt,
                "focus": "Initial Baseline"
            }
        }

    def get_en_prompt(self) -> str:
        return self.en_rewrite_prompt

    def get_ja_prompt(self) -> str:
        return self.ja_rewrite_prompt

    def update_prompts(self, gen: int, en_prompt: str, ja_prompt: str, focus: str = ""):
        self.en_rewrite_prompt = en_prompt
        self.ja_rewrite_prompt = ja_prompt
        self.history[gen] = {
            "en": en_prompt,
            "ja": ja_prompt,
            "focus": focus
        }

# グローバルなプロンプト管理インスタンス
prompt_manager = PromptManager()

# ---------------------------------------------------------------------------
# キャッシュライフサイクル管理 (WhisperX & Correction Caching)
# ---------------------------------------------------------------------------
def check_and_create_cache(video_path: str, force: bool = False) -> list[dict]:
    """
    動画ファイルから音声を抽出し、WhisperXで書き起こし、校正を行って結果をキャッシュ保存する。
    2回目以降はキャッシュから即時ロードする。
    """
    video_path = os.path.abspath(video_path)
    if not os.path.exists(video_path):
        raise FileNotFoundError(f"動画ファイルが見つかりません: {video_path}")

    video_stem = Path(video_path).stem
    cache_dir = Path(__file__).resolve().parent / "cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{video_stem}_cache.json"

    if cache_file.exists() and not force:
        print(f"\n[CACHE] キャッシュファイルを発見しました: {cache_file}")
        print("[CACHE] 時間のかかる書き起こし処理をスキップし、キャッシュをロードします。")
        with open(cache_file, "r", encoding="utf-8") as f:
            return json.load(f)

    print(f"\n[CACHE] 新規キャッシュの生成を開始します。動画: {video_path}")
    print("[CACHE] ※この処理には数分〜十数分かかる場合があります。")

    # RunStateの構築
    state = RunState(run_id=f"poc-run-{uuid_hex()[:8]}", schema_version="v3")
    state.data["source_media_path"] = video_path
    state.data["execution_mode"] = "production"
    state.data["allow_transcribe_fallback"] = False
    
    # 1. ffmpegによる音声抽出
    print("\n[PIPELINE] >>> 1. ffmpegによる音声抽出を実行します...")
    extract_node = ExtractAudioNode()
    res_extract = extract_node.run(state)
    if res_extract.status == "failure":
        raise RuntimeError(f"ffmpeg音声抽出に失敗しました: {res_extract.issues}")
    state.data.update(res_extract.updates)
    print(f"[PIPELINE] 音声抽出成功: {state.data.get('audio_path')}")

    # 2. WhisperXによる書き起こし (Docker経由の large-v3-ja)
    print("\n[PIPELINE] >>> 2. Docker上の WhisperX による単語レベル書き起こしを実行します...")
    state.data["runtime_settings"] = {
        "whisperx_execution_backend": "docker",
        "whisperx_docker_image": "ghcr.io/jim60105/whisperx:large-v3-ja"
    }
    state.data["strict_external_whisperx"] = True
    transcribe_node = TranscribeNode()
    res_transcribe = transcribe_node.run(state)
    if res_transcribe.status == "failure":
        raise RuntimeError(f"WhisperX書き起こしに失敗しました: {res_transcribe.issues}")
    state.data.update(res_transcribe.updates)
    print(f"[PIPELINE] WhisperX書き起こし成功: {len(state.data.get('transcript_segments', []))} セグメントを取得しました。")

    # 3. CorrectNodeによる日本語校正整形 (フィラー除去等)
    print("\n[PIPELINE] >>> 3. 決定論的日本語校正 (CorrectNode) を実行します...")
    correct_node = CorrectNode()
    res_correct = correct_node.run(state)
    if res_correct.status == "failure":
        raise RuntimeError(f"日本語校正に失敗しました: {res_correct.issues}")
    state.data.update(res_correct.updates)
    
    corrected_segments = state.data["corrected_segments"]
    print(f"[PIPELINE] 日本語校正成功: 全 {len(corrected_segments)} セグメントの校正済み日本語 (ja_corrected) を取得しました。")

    # 4. キャッシュファイルとして保存
    print(f"\n[CACHE] 生成されたデータをキャッシュファイルとして保存します: {cache_file}")
    with open(cache_file, "w", encoding="utf-8") as f:
        json.dump(corrected_segments, f, ensure_ascii=False, indent=2)

    return corrected_segments

def uuid_hex() -> str:
    import uuid
    return uuid.uuid4().hex

# ---------------------------------------------------------------------------
# ピュアPythonによるコサイン類似度とベクトル演算 (環境依存回避)
# ---------------------------------------------------------------------------
def calculate_cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """ピュアPythonでのコサイン類似度算出"""
    dot_product = sum(a * b for a, b in zip(vec_a, vec_b))
    norm_a = math.sqrt(sum(a * a for a in vec_a))
    norm_b = math.sqrt(sum(b * b for b in vec_b))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot_product / (norm_a * norm_b)

def get_embedding(text: str, client: openai.OpenAI, model: str) -> list[float]:
    """
    LM Studio の Embedding API からベクトルを取得する。
    フェイルファスト設計: 接続失敗時は曖昧な代替をせず即座に例外を投げる。
    """
    try:
        response = client.embeddings.create(
            input=[text],
            model=model
        )
        return response.data[0].embedding
    except Exception as e:
        print(f"\n[CRITICAL ERROR] ローカル Embedding サーバーへの接続に失敗しました: {e}")
        print("【対処法】LM Studio を起動し、ポート 1234 で 'text-embedding-qwen3-embedding-0.6b' などの埋め込みモデルをロードしてください。")
        print("※フォールバック（SequenceMatcher等）は無効化されているため、処理を即時強制停止（Fail-Fast）します。")
        raise e

# ---------------------------------------------------------------------------
# 定量評価・スコアリング関数 (Multi-Objective Score)
# ---------------------------------------------------------------------------
def evaluate_candidate(
    original_ja_corrected: str,
    candidate_en: str,
    start: float,
    end: float,
    llm_calls_count: int,
    client: openai.OpenAI,
    emb_model: str
) -> dict:
    """
    候補の字幕テキストおよび時間軸を多目的にスコアリングする。
    不動の基準である `ja_corrected` と 候補英語 `candidate_en` の意味コサイン類似度を測定。
    """
    duration = max(0.1, end - start)
    
    # 1. 意味類似度 S_align (Ground Truth である ja_corrected との比較)
    vec_ja = get_embedding(original_ja_corrected, client, emb_model)
    vec_en = get_embedding(candidate_en, client, emb_model)
    similarity = calculate_cosine_similarity(vec_ja, vec_en)
    
    # 閾値判定：致命的なセマンティックロス (類似度 < 0.85) は即座に却下 (Score=0)
    if similarity < SIMILARITY_THRESHOLD:
        return {
            "score": 0.0,
            "similarity": similarity,
            "cps": len(candidate_en) / duration,
            "cps_penalty": 1.0,
            "len_penalty": 1.0,
            "time_penalty": 0.0,
            "rejected": True,
            "reason": f"Semantic similarity ({similarity:.4f}) below threshold ({SIMILARITY_THRESHOLD})"
        }
        
    # 2. CPS超過ペナルティ P_cps
    cps = len(candidate_en) / duration
    cps_penalty = 0.0
    if cps > TARGET_CPS:
        # 目標値 15.0 を超過した比率に応じたペナルティ
        cps_penalty = (cps - TARGET_CPS) / TARGET_CPS
        
    # 3. 行文字数・行数超過ペナルティ P_len
    # 1行最大40文字、最大2行
    lines = candidate_en.split("\n")
    len_penalty = 0.0
    if len(lines) > 2:
        len_penalty += 0.5 * (len(lines) - 2)
    for line in lines:
        if len(line) > MAX_LINE_CHARS:
            len_penalty += (len(line) - MAX_LINE_CHARS) / MAX_LINE_CHARS
            
    # 4. 実時間コスト（LLM呼び出し回数）ペナルティ C_time
    time_penalty = llm_calls_count * W_TIME
    
    # 総合スコア算出
    score = (W_ALIGN * similarity) - (W_CPS * cps_penalty) - (W_LEN * len_penalty) - time_penalty
    # スコアが負にならないように下限を設ける
    score = max(0.01, score)
    
    return {
        "score": score,
        "similarity": similarity,
        "cps": cps,
        "cps_penalty": cps_penalty,
        "len_penalty": len_penalty,
        "time_penalty": time_penalty,
        "rejected": False
    }

# ---------------------------------------------------------------------------
# LM Studio (Gemma-4-e4b-it) によるチャット・翻訳・簡潔化処理
# ---------------------------------------------------------------------------
def translate_segment(ja_text: str, client: openai.OpenAI, model: str) -> str:
    """日本語から英語への標準翻訳"""
    system_prompt = (
        "Translate the following Japanese lecture transcript segment into natural English for video subtitles. "
        "The output must be short, clear, and direct. Output ONLY the raw English translation. "
        "Do not write any notes, markdown, explanation, or quotes."
    )
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": ja_text}
            ],
            temperature=0.1
        )
        return clean_llm_output(response.choices[0].message.content)
    except Exception as e:
        print(f"[ERROR] LLMによる翻訳に失敗しました: {e}")
        raise e

def rewrite_ja_concise(ja_text: str, client: openai.OpenAI, model: str) -> str:
    """日本語の段階での簡潔化リライト (PromptManager からプロンプトを取得)"""
    system_prompt = prompt_manager.get_ja_prompt()
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": ja_text}
            ],
            temperature=0.1
        )
        return clean_llm_output(response.choices[0].message.content)
    except Exception as e:
        print(f"[ERROR] LLMによる日本語リライトに失敗しました: {e}")
        raise e

def rewrite_en_concise(en_text: str, client: openai.OpenAI, model: str, chars_to_remove: int) -> str:
    """
    英語の段階での簡潔化リライト (PromptManager からプロンプトを取得)。
    軽量モデル Gemma に優しく指示をフィードバックする。
    """
    system_prompt = prompt_manager.get_en_prompt()
    user_prompt = (
        f"Original English subtitle: '{en_text}'\n"
        f"Constraint: This subtitle exceeds the length limit. Please make it shorter by removing approximately {chars_to_remove} characters (or more) while keeping the same meaning."
    )
    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.2
        )
        return clean_llm_output(response.choices[0].message.content)
    except Exception as e:
        print(f"[ERROR] LLMによる英語リライトに失敗しました: {e}")
        raise e

def clean_llm_output(text: str) -> str:
    """LLMが余分に出力したマークダウンやクォートを取り除く"""
    text = text.strip()
    # 行頭・行末のクォート除去
    if text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    if text.startswith("'") and text.endswith("'"):
        text = text[1:-1].strip()
    # マークダウンコードブロックの除去
    text = re.sub(r"```[a-zA-Z]*\n", "", text)
    text = text.replace("```", "")
    return text.strip()

# ---------------------------------------------------------------------------
# 自律方策探索カード (Strategy Cards Operations)
# ---------------------------------------------------------------------------
def apply_strategy_borrow_gap(block: dict, prev_block: dict | None) -> dict:
    """前のセグメントとの間の無音時間を利用して、開始時刻を前方に拡張する"""
    new_block = block.copy()
    if prev_block is None:
        return new_block
    
    gap = block["start"] - prev_block["end"]
    if gap > 0.1:
        # 最大でギャップの80%（または衝突防止用の安全マージン 0.05秒 を残す）拡張可能とする
        borrow_time = max(0.0, gap - 0.05)
        new_block["start"] = round(block["start"] - borrow_time, 3)
        new_block["applied_strategies"].append("borrow_gap")
    return new_block

def apply_strategy_expand_ts(block: dict, next_block: dict | None) -> dict:
    """次のセグメントとの衝突を避ける安全範囲で、終了時刻を遅らせて表示時間を稼ぐ"""
    new_block = block.copy()
    if next_block is None:
        # 最終ブロックの場合は安全に最大2.0秒まで拡張可能とする
        new_block["end"] = round(block["end"] + 1.5, 3)
        new_block["applied_strategies"].append("expand_ts")
        return new_block
    
    gap = next_block["start"] - block["end"]
    if gap > 0.1:
        # 安全マージン 0.05秒 を残して表示秒数を拡張
        expand_time = max(0.0, gap - 0.05)
        new_block["end"] = round(block["end"] + expand_time, 3)
        new_block["applied_strategies"].append("expand_ts")
    return new_block

# ---------------------------------------------------------------------------
# 自律方策探索・最適化ループ (Self-Correction Strategy Search)
# ---------------------------------------------------------------------------
def optimize_subtitle_pipeline(
    segments: list[dict],
    local_client: openai.OpenAI,
    chat_model: str,
    emb_model: str
) -> tuple[list[dict], list[dict]]:
    """
    全セグメントを翻訳し、CPS違反が発生したセグメントを自律的に修復する。
    修復にあたっては「日本語前処理（アプローチA）」と「英語後処理（アプローチB）」の多様な組み合わせから
    最も高い Score を出す戦略を選択する。
    """
    print("\n    [自律方策探索] 初期翻訳を実行中...")
    translated_segments = []
    for seg in segments:
        ja_text = seg.get("ja_corrected") or seg.get("text") or seg.get("ja")
        en_trans = translate_segment(ja_text, local_client, chat_model)
        
        duration = max(0.1, seg["end"] - seg["start"])
        cps = len(en_trans) / duration
        
        is_violated = cps > TARGET_CPS
        translated_segments.append({
            "id": seg["id"],
            "start": seg["start"],
            "end": seg["end"],
            "ja_corrected": ja_text,
            "en": en_trans,
            "cps": cps,
            "applied_strategies": [],
            "llm_calls": 1,
            "status": "PASS" if not is_violated else "VIOLATED",
            "is_initially_violated": is_violated
        })
    
    violated_blocks = [b for b in translated_segments if b["status"] == "VIOLATED"]
    print(f"    [自律方策探索] 初期翻訳完了: 全 {len(translated_segments)} ブロック中 {len(violated_blocks)} 件の違反を検知。")
    
    optimized_segments = {b["id"]: b.copy() for b in translated_segments}
    failed_ng_blocks = [] # 合格スコアに達しなかったNGパターンをメタ進化用に保存

    for idx, viol in enumerate(violated_blocks, start=1):
        block_id = viol["id"]
        original_block = viol.copy()
        
        # 周辺コンテキストの取得
        prev_block = optimized_segments.get(block_id - 1)
        next_block = optimized_segments.get(block_id + 1)
        
        best_candidate = viol.copy()
        eval_init = evaluate_candidate(
            viol["ja_corrected"], viol["en"], viol["start"], viol["end"], viol["llm_calls"], local_client, emb_model
        )
        best_candidate["score"] = eval_init["score"]
        best_candidate["similarity"] = eval_init["similarity"]
        best_candidate["rejected"] = eval_init["rejected"]
        
        # 手札を組み合わせて「コンボ候補」をテストする
        candidates_to_test = []

        # **方策コンボ 1: [borrow_gap] + [expand_ts] (時間軸拡張のみ)**
        cand_ts = viol.copy()
        cand_ts["applied_strategies"] = []
        cand_ts = apply_strategy_borrow_gap(cand_ts, prev_block)
        cand_ts = apply_strategy_expand_ts(cand_ts, next_block)
        candidates_to_test.append(("タイムスタンプ拡張のみ", cand_ts))

        # **方策コンボ 2: [rewrite_en] (英語段階での要約リライト)**
        cand_rewrite_en = viol.copy()
        cand_rewrite_en["applied_strategies"] = []
        target_len = int(TARGET_CPS * (viol["end"] - viol["start"]))
        chars_to_remove = max(3, len(viol["en"]) - target_len)
        shorter_en = rewrite_en_concise(viol["en"], local_client, chat_model, chars_to_remove)
        cand_rewrite_en["en"] = shorter_en
        cand_rewrite_en["llm_calls"] += 1
        cand_rewrite_en["applied_strategies"].append("rewrite_en")
        candidates_to_test.append(("英語簡潔化リライトのみ", cand_rewrite_en))

        # **方策コンボ 3: [borrow_gap] + [expand_ts] + [rewrite_en] (拡張と英語リライトのハイブリッド)**
        cand_hybrid = viol.copy()
        cand_hybrid["applied_strategies"] = []
        cand_hybrid = apply_strategy_borrow_gap(cand_hybrid, prev_block)
        cand_hybrid = apply_strategy_expand_ts(cand_hybrid, next_block)
        
        new_duration = max(0.1, cand_hybrid["end"] - cand_hybrid["start"])
        target_len_hybrid = int(TARGET_CPS * new_duration)
        chars_to_remove_hybrid = max(3, len(viol["en"]) - target_len_hybrid)
        shorter_hybrid_en = rewrite_en_concise(viol["en"], local_client, chat_model, chars_to_remove_hybrid)
        cand_hybrid["en"] = shorter_hybrid_en
        cand_hybrid["llm_calls"] += 1
        cand_hybrid["applied_strategies"].append("rewrite_en")
        candidates_to_test.append(("タイムスタンプ拡張＋英語リライト", cand_hybrid))

        # **方策コンボ 4: [rewrite_ja] (日本語前処理要約＋翻訳)**
        cand_rewrite_ja = viol.copy()
        cand_rewrite_ja["applied_strategies"] = []
        shorter_ja = rewrite_ja_concise(viol["ja_corrected"], local_client, chat_model)
        translated_shorter_en = translate_segment(shorter_ja, local_client, chat_model)
        cand_rewrite_ja["en"] = translated_shorter_en
        cand_rewrite_ja["llm_calls"] += 2
        cand_rewrite_ja["applied_strategies"].extend(["rewrite_ja", "translate"])
        candidates_to_test.append(("日本語要約リライト＋翻訳", cand_rewrite_ja))

        # **方策コンボ 5: [merge_ja] (日本語前方ブロック結合＋再翻訳)**
        if prev_block:
            cand_merge_ja = viol.copy()
            cand_merge_ja["applied_strategies"] = []
            merged_ja = f"{prev_block['ja_corrected']}。{viol['ja_corrected']}"
            merged_en = translate_segment(merged_ja, local_client, chat_model)
            cand_merge_ja["ja_corrected"] = merged_ja
            cand_merge_ja["en"] = merged_en
            cand_merge_ja["start"] = prev_block["start"]
            cand_merge_ja["llm_calls"] += 1
            cand_merge_ja["applied_strategies"].extend(["merge_ja", "translate"])
            candidates_to_test.append(("日本語前方ブロック結合＋再翻訳", cand_merge_ja))

        # --- 候補のスコアリングと選定 ---
        for name, cand in candidates_to_test:
            res_eval = evaluate_candidate(
                original_block["ja_corrected"],
                cand["en"],
                cand["start"],
                cand["end"],
                cand["llm_calls"],
                local_client,
                emb_model
            )
            
            if res_eval["rejected"]:
                continue
                
            score = res_eval["score"]
            if score > best_candidate.get("score", 0.0):
                best_candidate = cand.copy()
                best_candidate["score"] = score
                best_candidate["similarity"] = res_eval["similarity"]
                best_candidate["cps"] = res_eval["cps"]
                best_candidate["rejected"] = False

        # --- 最適戦略の決定と適用 ---
        if best_candidate["score"] > original_block.get("score", 0.0) and not best_candidate.get("rejected", True):
            if best_candidate["cps"] <= TARGET_CPS:
                best_candidate["status"] = "PASS"
            else:
                best_candidate["status"] = "VIOLATED_IMPROVED"
                failed_ng_blocks.append(best_candidate)
            optimized_segments[block_id] = best_candidate
        else:
            original_block["status"] = "FAILED"
            failed_ng_blocks.append(original_block)
            optimized_segments[block_id] = original_block

    return list(optimized_segments.values()), failed_ng_blocks

# ---------------------------------------------------------------------------
# Gemini 3.5 Flash による「自己進化メタ分析・プロンプト改善」
# ---------------------------------------------------------------------------
def parse_evolution_xml(resp_text: str, current_en: str, current_ja: str) -> tuple[str, str, str, str]:
    """XML形式の出力から分析、焦点、進化したプロンプト群を抽出する"""
    analysis = "Analysis extraction failed"
    focus = "Focus extraction failed"
    new_en = current_en
    new_ja = current_ja

    if not resp_text:
        return analysis, new_en, new_ja, focus

    m_analysis = re.search(r"<analysis>(.*?)</analysis>", resp_text, re.DOTALL)
    if m_analysis:
        analysis = m_analysis.group(1).strip()
    
    m_focus = re.search(r"<focus>(.*?)</focus>", resp_text, re.DOTALL)
    if m_focus:
        focus = m_focus.group(1).strip()

    m_en = re.search(r"<en_prompt>(.*?)</en_prompt>", resp_text, re.DOTALL)
    if m_en:
        new_en = m_en.group(1).strip()

    m_ja = re.search(r"<ja_prompt>(.*?)</ja_prompt>", resp_text, re.DOTALL)
    if m_ja:
        new_ja = m_ja.group(1).strip()

    return analysis, new_en, new_ja, focus

def run_self_evolution_analysis(failed_blocks: list[dict], gen: int) -> tuple[str, str, str, str]:
    """
    探索ループで合格CPS（< 15.0）に達しなかったNGブロックを収集し、
    Gemini 3.5 Flash (またはローカル gemma-4-e4b-it にフォールバック) に失敗を分析させ、
    進化した新しいプロンプトを自動生成する。
    """
    print(f"\n[META-EVOLUTION] >>> 自己進化メタ・ループ起動 (世代 {gen} -> {gen+1})")
    print(f"[META-EVOLUTION] 難解セグメント件数: {len(failed_blocks)} 件")

    # 失敗事例を整形 (コンテキスト制限回避のため、最も厳しい事例から最大5件を厳選)
    sorted_failed = sorted(
        failed_blocks,
        key=lambda x: (x.get("cps", 0.0) - TARGET_CPS if x.get("cps", 0.0) > TARGET_CPS else 0.0) + (1.0 - x.get("similarity", 1.0)),
        reverse=True
    )
    selected_failed = sorted_failed[:5]
    print(f"[META-EVOLUTION] コンテキスト制限回避のため、全 {len(failed_blocks)} 件の失敗事例から最も難解な {len(selected_failed)} 件を厳選して分析に送ります。")

    failed_cases_str = ""
    for block in selected_failed:
        failed_cases_str += (
            f"- Segment ID: {block['id']}\n"
            f"  Original Japanese Ground Truth (不動の基準): {block['ja_corrected']}\n"
            f"  Current English Translation              : {block['en']}\n"
            f"  Current CPS                              : {block['cps']:.2f}\n"
            f"  Current Semantic Similarity              : {block.get('similarity', 0.0):.4f}\n"
            f"  Attempted Strategies                     : {block.get('applied_strategies', [])}\n\n"
        )

    current_en = prompt_manager.get_en_prompt()
    current_ja = prompt_manager.get_ja_prompt()

    prompt = (
        "You are an AI Subtitle Evolution Agent. The following university lecture subtitle segments "
        "could not be optimized to satisfy the strict constraint (CPS < 15.0 and line character limit < 40) "
        "even after trying our standard autonomous strategy cards (borrow_gap, expand_ts, rewrite_en, rewrite_ja, merge_ja).\n\n"
        f"--- CURRENT PROMPTS (Generation {gen}) ---\n"
        f"[Current English Rewrite System Prompt]:\n{current_en}\n\n"
        f"[Current Japanese Rewrite System Prompt]:\n{current_ja}\n\n"
        "--- FAILED CASES ---\n"
        f"{failed_cases_str}\n"
        "Please perform a deep semantic failure analysis. Identify the root cause of these failures (e.g., extremely high information density, complex technical jargon, or rigid passive grammars).\n"
        "Then, design an IMPROVED English rewrite prompt and Japanese rewrite prompt that directly address these failure patterns.\n"
        "You must output your response in the exact XML format below. Output ONLY the XML block and nothing else:\n\n"
        "<evolution>\n"
        "  <analysis>Your failure analysis and reasoning here</analysis>\n"
        "  <focus>Brief summary of what this generation focuses on improving (e.g. \"Active voice emphasis\", \"Extreme academic condensation\", etc.)</focus>\n"
        "  <en_prompt>The entire new, improved system prompt for rewriting English subtitles to be shorter</en_prompt>\n"
        "  <ja_prompt>The entire new, improved system prompt for rewriting Japanese subtitles to be shorter</ja_prompt>\n"
        "</evolution>"
    )

    api_key = os.getenv("GEMINI_API_KEY")
    use_local = False
    if not api_key or api_key == "your_key_here":
        print("[WARNING] GEMINI_API_KEY が設定されていないかデフォルト値のままです。ローカルの LM Studio (gemma-4-e4b-it) での自己進化分析にフォールバックします。")
        use_local = True

    resp_text = None
    if not use_local:
        try:
            print("[META-EVOLUTION] Gemini 3.5 Flash に分析リクエストを送信中...")
            client = genai.Client(api_key=api_key)
            response = client.models.generate_content(
                model="gemini-3.5-flash",
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3
                )
            )
            resp_text = response.text
        except Exception as e:
            print(f"[ERROR] Gemini APIによる自己進化分析に失敗しました。ローカルフォールバックを実行します。: {e}")
            use_local = True

    if use_local:
        try:
            print("[META-EVOLUTION] ローカルの LM Studio (gemma-4-e4b-it) で自己進化分析を生成中...")
            local_client = openai.OpenAI(base_url=LM_STUDIO_BASE_URL, api_key="lm-studio")
            response = local_client.chat.completions.create(
                model=CHAT_MODEL,
                messages=[
                    {"role": "system", "content": "You are a professional system optimizer. Output ONLY the requested XML block."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.3
            )
            resp_text = response.choices[0].message.content
        except Exception as e:
            print(f"[ERROR] ローカル自己進化フォールバックにも失敗しました: {e}")
            return f"Self-evolution analysis failed: {e}", current_en, current_ja, "Local Evolution Failed"

    # XMLパースを実行
    analysis, new_en, new_ja, focus = parse_evolution_xml(resp_text, current_en, current_ja)

    # 個別世代の分析結果を保存
    results_dir = Path(__file__).resolve().parent / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    report_file = results_dir / f"self_evolution_analysis_gen_{gen}.md"
    with open(report_file, "w", encoding="utf-8") as f:
        f.write(f"# Meta Evolution Analysis: Gen {gen} -> Gen {gen+1}\n\n")
        f.write(f"## Focus\n{focus}\n\n")
        f.write(f"## Failure Analysis\n{analysis}\n\n")
        f.write(f"## New English Prompt\n```\n{new_en}\n```\n\n")
        f.write(f"## New Japanese Prompt\n```\n{new_ja}\n```\n\n")
        f.write(f"## Raw XML Output\n```xml\n{resp_text}\n```\n")

    print(f"[SELF-EVOLUTION] 進化の焦点: {focus}")
    print(f"[SELF-EVOLUTION] 世代 {gen} 分析レポート保存完了: {report_file}")
    return analysis, new_en, new_ja, focus

# ---------------------------------------------------------------------------
# パフォーマンス比較レポートの自動生成
# ---------------------------------------------------------------------------
def generate_comparison_report(metrics: dict, results_dir: Path) -> str:
    """すべての世代のメトリクスを比較した美しいマークダウンレポートを生成する"""
    report = "# 自己進化字幕最適化エージェント パフォーマンス比較レポート\n\n"
    report += f"> 生成日時: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
    report += "> このレポートは、メタモデル（Gemini 3.5 Flash）が自律方策探索の失敗から学習し、プロンプトを自動改善した成果（自己進化プロセス）を示しています。\n\n"
    
    report += "## 1. 定量評価メトリクス比較\n\n"
    report += "| 世代 (Gen) | 合格ブロック数 | 合格率 (%) | 平均コサイン類似度 | 平均総合スコア | 未解決件数 | プロンプト文字数 (EN/JA) | 進化の焦点 |\n"
    report += "|------------|---------------|-----------|-------------------|---------------|------------|-------------------------|------------|\n"
    
    for gen, met in metrics.items():
        pass_rate_str = f"{met['pass_rate']:.1f}%"
        avg_sim_str = f"{met['avg_similarity']:.4f}"
        avg_score_str = f"{met['avg_score']:.4f}"
        prompt_len = f"{len(met['en_prompt'])} / {len(met['ja_prompt'])}"
        
        gen_str = f"**Gen {gen} (Base)**" if gen == 0 else f"Gen {gen}"
        
        report += f"| {gen_str} | {met['passed']} / {met['total']} | {pass_rate_str} | {avg_sim_str} | {avg_score_str} | {met['failed_count']} | {prompt_len} | {met['focus']} |\n"
        
    report += "\n\n## 2. 世代別プロンプトの進化史\n\n"
    
    for gen, met in metrics.items():
        report += f"### 世代 {gen}\n"
        report += f"- **改善の焦点**: {met['focus']}\n"
        report += f"- **英語リライトプロンプト**:\n"
        report += f"```\n{met['en_prompt']}\n```\n"
        report += f"- **日本語リライトプロンプト**:\n"
        report += f"```\n{met['ja_prompt']}\n```\n\n"
        report += "---\n\n"
        
    results_dir.mkdir(parents=True, exist_ok=True)
    report_file = results_dir / "meta_evolution_comparison_report.md"
    with open(report_file, "w", encoding="utf-8") as f:
        f.write(report)
        
    print(f"\n[REPORT] 全世代定量比較レポートを出力しました: {report_file}")
    return str(report_file)

# ---------------------------------------------------------------------------
# メイン実行関数
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="字幕最適化エージェントPoC (自律的方策探索・自己進化メタ・ループ)")
    parser.add_argument("--video", type=str, required=True, help="対象となる講義動画ファイルのパス")
    parser.add_argument("--force", action="store_true", help="キャッシュを強制的に再作成する")
    parser.add_argument("--generations", type=int, default=2, help="自己進化させる世代数 (デフォルト: 2)")
    args = parser.parse_args()

    # LM Studio の接続確認（フェイルファスト）
    local_client = openai.OpenAI(base_url=LM_STUDIO_BASE_URL, api_key="lm-studio")
    print(f"\n[INIT] ローカル接続テストを実行中 (LM Studio Endpoint: {LM_STUDIO_BASE_URL})...")
    get_embedding("接続テスト", local_client, EMBEDDING_MODEL)
    print("[INIT] ローカル Embedding サーバーへの接続成功！(text-embedding-qwen3-embedding-0.6b)")

    try:
        # キャッシュ取得または新規作成
        corrected_segments = check_and_create_cache(args.video, args.force)
        print(f"\n[INIT] タイムスタンプ付き日本語書き起こしデータをロードしました (セグメント数: {len(corrected_segments)})")
        
        generations_count = args.generations
        generation_metrics = {}

        print("\n==================================================")
        print("    自己進化型・字幕最適化メタ・ループを開始します")
        print(f"    対象: {Path(args.video).name}")
        print(f"    目標設定世代数: {generations_count}")
        print("==================================================")

        for gen in range(generations_count):
            print(f"\n--------------------------------------------------")
            print(f"        >>> [ Generation {gen} ] Start <<<")
            print(f"--------------------------------------------------")
            print(f"  [English Prompt Length] : {len(prompt_manager.get_en_prompt())}文字")
            print(f"  [Japanese Prompt Length]: {len(prompt_manager.get_ja_prompt())}文字")

            # 自律方策探索・最適化ループの実行
            optimized, failed_ngs = optimize_subtitle_pipeline(
                corrected_segments, local_client, CHAT_MODEL, EMBEDDING_MODEL
            )
            
            # メトリクスの算出
            total = len(optimized)
            violated = len([b for b in optimized if b["status"] in ("VIOLATED", "VIOLATED_IMPROVED", "FAILED")])
            passed = total - violated
            pass_rate = (passed / total) * 100 if total > 0 else 0.0

            # 初期違反ブロックのIDリスト（最適化対象ブロック）
            violated_ids = {b["id"] for b in optimized if b.get("is_initially_violated", False)}

            # 最適化対象となったブロックの中で、rejected（類似度が低すぎて切り捨てられた）ではない有効なブロックの類似度・スコアを算出
            valid_optimized_blocks = [
                b for b in optimized 
                if b["id"] in violated_ids and not b.get("rejected", False)
            ]

            avg_similarity = (
                sum(b.get("similarity", 0.0) for b in valid_optimized_blocks) / len(valid_optimized_blocks)
                if valid_optimized_blocks else 0.0
            )

            avg_score = (
                sum(b.get("score", 0.0) for b in valid_optimized_blocks) / len(valid_optimized_blocks)
                if valid_optimized_blocks else 0.0
            )

            # 世代メトリクスの保存
            generation_metrics[gen] = {
                "total": total,
                "passed": passed,
                "violated": violated,
                "pass_rate": pass_rate,
                "avg_similarity": avg_similarity,
                "avg_score": avg_score,
                "failed_count": len(failed_ngs),
                "en_prompt": prompt_manager.get_en_prompt(),
                "ja_prompt": prompt_manager.get_ja_prompt(),
                "focus": prompt_manager.history[gen]["focus"] if gen in prompt_manager.history else "N/A"
            }

            print(f"\n  [Generation {gen} Summary]")
            print(f"    - Pass Rate : {passed}/{total} ({pass_rate:.1f}%)")
            print(f"    - Avg Similarity : {avg_similarity:.4f}")
            print(f"    - Avg Score: {avg_score:.4f}")
            print(f"    - Unresolved Blocks : {len(failed_ngs)} cases")

            # 最終世代に達した、あるいは未解決ブロックがない場合は終了
            if gen == generations_count - 1:
                print("\n[META-EVOLUTION] 指定された最終世代に到達したため、自己進化メタ・ループを終了します。")
                break
                
            if not failed_ngs:
                print("\n[META-EVOLUTION] 全ブロックがCPS制約を遵守したため、これ以上の進化は不要です。")
                # 以降の世代のメトリクスを埋めてループを抜ける
                for remaining_gen in range(gen + 1, generations_count):
                    generation_metrics[remaining_gen] = generation_metrics[gen].copy()
                    # focus などを更新
                    generation_metrics[remaining_gen]["focus"] = "Fully Compliance Reached"
                break

            # 次世代のために自己進化メタ分析を実行してプロンプトを更新
            analysis, new_en, new_ja, focus = run_self_evolution_analysis(failed_ngs, gen)
            prompt_manager.update_prompts(gen + 1, new_en, new_ja, focus)

        # パフォーマンス比較レポートの生成
        results_dir = Path(__file__).resolve().parent / "results"
        generate_comparison_report(generation_metrics, results_dir)

        print("\n自己進化メタ改善ループのPoC実行がすべて正常に完了しました！")

    except Exception as e:
        print(f"\n[FATAL ERROR] 処理中に致命的なエラーが発生しました: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
