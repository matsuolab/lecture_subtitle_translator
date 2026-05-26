#!/usr/bin/env python3
"""Generate a comprehensive HTML report from a HSP run directory.

Shows for every chunk:
- Timeline of operations (which agent, which model, which tools, validation outcomes)
- Per-agent token usage and cost
- Final cue output and status
- Aggregate summary at top
"""

import json
import os
import re
import sys
from collections import defaultdict
from html import escape
from pathlib import Path

# ---------- Pricing ----------
PRICING = {
    'gpt-5.4-mini': (0.75, 0.075, 4.5),
    'gpt-5.4-mini-2026-03-17': (0.75, 0.075, 4.5),
    'gpt-5.4-nano': (0.20, 0.02, 1.25),
    'gpt-5.4-nano-2026-03-17': (0.20, 0.02, 1.25),
    'gpt-5.5': (5.0, 0.5, 30.0),
    'gpt-5.5-2026-04-23': (5.0, 0.5, 30.0),
    'gpt-4.1-mini': (0.4, 0.1, 1.6),
    'gpt-4.1-nano': (0.1, 0.025, 0.4),
}

def calc_cost(model, billable_input, cached_input, output):
    if model not in PRICING:
        return 0.0
    inp, cached, out = PRICING[model]
    return (billable_input * inp + cached_input * cached + output * out) / 1e6


# ---------- Parse ----------
def parse_run(run_dir: Path):
    run_json = json.load((run_dir / 'run.json').open(encoding='utf-8'))
    metrics = json.load((run_dir / 'reports' / 'metrics.json').open(encoding='utf-8'))

    models_map = run_json.get('models') or {}
    # if "models" missing, fallback to default
    default_model = run_json.get('model', 'gpt-5.4-mini')
    correction_model = run_json.get('correction_model', default_model)

    # ---------- per-chunk events ----------
    chunks = defaultdict(lambda: {
        'events': [],
        'final_status': '',
        'agents': defaultdict(int),
        'tools': defaultdict(int),
        'failures': [],
    })
    chunk_order = []

    with (run_dir / 'events.jsonl').open(encoding='utf-8') as fh:
        for line in fh:
            try:
                ev = json.loads(line)
            except Exception:
                continue
            cid = ev.get('chunk_id')
            if not cid:
                continue
            if cid not in chunks:
                chunk_order.append(cid)
            ch = chunks[cid]
            ch['events'].append(ev)
            et = ev.get('event_type', '')
            phase = ev.get('phase', '')
            agent = ev.get('agent', '')
            summary = ev.get('summary', '')
            model = ev.get('model', '')

            if et == 'chunk_finished':
                # e.g. "day4_dummy_001 finished as accepted"
                m = re.search(r'finished as (\w+)', summary)
                if m:
                    ch['final_status'] = m.group(1)

            if agent:
                ch['agents'][agent] += 1
            if et == 'tool_finished':
                tool_name = summary.split(':')[-1].strip()
                ch['tools'][tool_name] += 1
            if et == 'validation_failed':
                data = ev.get('data', {})
                if isinstance(data, dict):
                    issues = data.get('issues') or []
                else:
                    issues = []
                codes = []
                if isinstance(issues, list):
                    for it in issues:
                        if isinstance(it, dict):
                            codes.append(it.get('issue_code') or it.get('code') or 'unknown')
                ch['failures'].append({'summary': summary, 'codes': codes})

    # ---------- per-chunk responses (token usage by agent) ----------
    chunk_usage = defaultdict(lambda: defaultdict(lambda: {'calls': 0, 'input': 0, 'cached': 0, 'output': 0, 'model': ''}))
    responses_dir = run_dir / 'responses'
    if responses_dir.exists():
        for f in sorted(responses_dir.iterdir()):
            name = f.name
            if not name.endswith('.result.json'):
                continue
            m = re.match(r'(day\d+_dummy_\d+|chunk_\d+|.+?)\.([A-Za-z]+Agent)\.', name)
            if not m:
                # try variant matching
                m = re.match(r'(.+?)\.([A-Za-z]+Agent)\.', name)
                if not m:
                    continue
            cid = m.group(1)
            agent = m.group(2)
            # categorize
            lower = name.lower()
            if 'one-word' in lower:
                cat = 'OneWordRepair'
                model_key = 'oneWord'
            elif 'fallback' in lower:
                cat = 'Fallback (gpt-5.5)'
                model_key = 'fallback'
            elif agent == 'RepairPlannerAgent':
                cat = 'RepairPlanner'
                model_key = 'repair'
            elif agent == 'ChunkPlannerAgent':
                cat = 'ChunkPlanner'
                model_key = 'planner'
            elif agent == 'QualityCriticAgent':
                cat = 'QualityCritic'
                model_key = 'critic'
            elif agent == 'CueStructureCandidateAgent':
                cat = 'CueStructure'
                model_key = 'cueStructure'
            elif agent == 'CueMergeRewriteAgent':
                cat = 'MergeRewrite'
                model_key = 'mergeRewrite'
            else:
                cat = agent
                model_key = ''

            try:
                d = json.load(f.open(encoding='utf-8'))
            except Exception:
                continue
            model_used = models_map.get(model_key, default_model)
            chunk_usage[cid][cat]['model'] = model_used
            for r in d.get('rawResponses', []) or []:
                u = r.get('usage', {})
                chunk_usage[cid][cat]['calls'] += 1
                chunk_usage[cid][cat]['input'] += u.get('inputTokens', 0)
                chunk_usage[cid][cat]['output'] += u.get('outputTokens', 0)
                details = u.get('inputTokensDetails')
                if isinstance(details, list):
                    for x in details:
                        chunk_usage[cid][cat]['cached'] += x.get('cached_tokens', 0) or 0
                elif isinstance(details, dict):
                    chunk_usage[cid][cat]['cached'] += details.get('cached_tokens', 0) or 0

    # ---------- per-chunk agent traces (internal tool calls) ----------
    chunk_traces = defaultdict(list)
    if responses_dir.exists():
        # order: cue-structure, planner, repair1, repair2, ..., fallback, one-word, critic, merge-rewrite
        def trace_sort_key(f):
            name = f.name.lower()
            cid_m = re.match(r'(day\d+_dummy_\d+|chunk_\d+|.+?)\.', name)
            cid = cid_m.group(1) if cid_m else ''
            # parse order
            if 'cuestructurecandidateagent' in name: order = 0
            elif 'chunkplanneragent' in name: order = 1
            elif 'repairplanneragent' in name:
                num_m = re.search(r'repairplanneragent\.(\d+)', name)
                num = int(num_m.group(1)) if num_m else 99
                if 'one-word' in name: order = 100 + num
                elif 'fallback' in name: order = 200 + num
                else: order = 10 + num
            elif 'qualitycriticagent' in name: order = 300
            elif 'cuemergerewriteagent' in name: order = 400
            else: order = 999
            return (cid, order)

        result_files = [f for f in responses_dir.iterdir() if f.name.endswith('.result.json')]
        for f in sorted(result_files, key=trace_sort_key):
            name = f.name
            cid_m = re.match(r'(day\d+_dummy_\d+|chunk_\d+|.+?)\.', name)
            if not cid_m: continue
            cid = cid_m.group(1)
            lower = name.lower()
            # agent label
            if 'cuestructurecandidateagent' in lower:
                label, mkey = 'CueStructure', 'cueStructure'
            elif 'chunkplanneragent' in lower:
                label, mkey = 'ChunkPlanner', 'planner'
            elif 'repairplanneragent' in lower:
                num_m = re.search(r'RepairPlannerAgent\.(\d+)', name)
                num = num_m.group(1) if num_m else '?'
                if 'one-word' in lower:
                    label, mkey = f'OneWordRepair #{num}', 'oneWord'
                elif 'fallback' in lower:
                    label, mkey = f'Fallback Repair #{num}', 'fallback'
                else:
                    label, mkey = f'RepairPlanner #{num}', 'repair'
            elif 'qualitycriticagent' in lower:
                label, mkey = 'QualityCritic', 'critic'
            elif 'cuemergerewriteagent' in lower:
                label, mkey = 'MergeRewrite', 'mergeRewrite'
            else:
                continue

            try:
                d = json.load(f.open(encoding='utf-8'))
            except Exception:
                continue
            items = d.get('newItems') or []
            steps = []
            for it in items:
                if not isinstance(it, dict): continue
                t = it.get('type','')
                raw = it.get('rawItem') or {}
                if t == 'tool_call_item':
                    nm = raw.get('name', '?')
                    args = raw.get('arguments', '')
                    steps.append(('tool_call', nm, args if isinstance(args, str) else json.dumps(args, ensure_ascii=False)))
                elif t == 'tool_call_output_item':
                    nm = raw.get('name', '?')
                    out = raw.get('output')
                    text = ''
                    if isinstance(out, dict):
                        txt = out.get('text', '')
                        text = txt if isinstance(txt, str) else json.dumps(out, ensure_ascii=False)
                    elif isinstance(out, str):
                        text = out
                    else:
                        text = json.dumps(out, ensure_ascii=False) if out else ''
                    steps.append(('tool_output', nm, text))
                elif t == 'reasoning_item':
                    content = raw.get('content', '') or raw.get('summary', '')
                    if isinstance(content, list):
                        # might be a list of {type:'text', text:...}
                        parts = []
                        for c in content:
                            if isinstance(c, dict):
                                parts.append(c.get('text','') or c.get('summary',''))
                        content = ' '.join(parts)
                    steps.append(('reasoning', '', str(content)))
                elif t == 'message_output_item':
                    content = raw.get('content', '')
                    text = ''
                    if isinstance(content, list) and content:
                        first = content[0]
                        if isinstance(first, dict):
                            text = first.get('text', '')
                    steps.append(('final_message', '', text))
            model_used = models_map.get(mkey, default_model)
            chunk_traces[cid].append({'label': label, 'model': model_used, 'steps': steps})

    # ---------- per-chunk final cues ----------
    chunk_cues = {}
    for cid in chunks.keys():
        # find the last accepted/best result file
        candidates = sorted([f for f in (run_dir / 'responses').iterdir() if f.name.startswith(f'{cid}.') and f.name.endswith('.result.json')])
        # priority: fallback > repair (highest #) > planner
        chosen = None
        for f in reversed(candidates):
            lower = f.name.lower()
            if 'fallback' in lower:
                chosen = f
                break
        if chosen is None:
            repair_candidates = [f for f in candidates if 'RepairPlannerAgent' in f.name and 'one-word' not in f.name.lower()]
            if repair_candidates:
                chosen = repair_candidates[-1]
        if chosen is None:
            planner_candidates = [f for f in candidates if 'ChunkPlannerAgent' in f.name]
            if planner_candidates:
                chosen = planner_candidates[-1]
        if chosen:
            try:
                d = json.load(chosen.open(encoding='utf-8'))
                fo = d.get('finalOutput')
                if isinstance(fo, str):
                    try:
                        fo = json.loads(fo)
                    except Exception:
                        pass
                if isinstance(fo, dict):
                    chunk_cues[cid] = fo.get('cues', [])
            except Exception:
                pass

    return {
        'run_json': run_json,
        'metrics': metrics,
        'models_map': models_map if models_map else {'(default)': default_model},
        'correction_model': correction_model,
        'chunks': chunks,
        'chunk_order': chunk_order,
        'chunk_usage': chunk_usage,
        'chunk_cues': chunk_cues,
        'chunk_traces': chunk_traces,
    }


# ---------- Generate HTML ----------
def gen_html(data, out_path: Path):
    run = data['run_json']
    metrics = data['metrics']
    models_map = data['models_map']
    chunks = data['chunks']
    chunk_order = data['chunk_order']
    chunk_usage = data['chunk_usage']
    chunk_cues = data['chunk_cues']
    chunk_traces = data['chunk_traces']

    status_count = defaultdict(int)
    for cid in chunk_order:
        status_count[chunks[cid]['final_status'] or 'unknown'] += 1

    # per-chunk cost summary
    chunk_costs = {}
    for cid in chunk_order:
        total = 0.0
        per_agent = []
        for agent_cat, u in chunk_usage[cid].items():
            model = u['model']
            billable = u['input'] - u['cached']
            cost = calc_cost(model, billable, u['cached'], u['output'])
            total += cost
            per_agent.append({**u, 'cat': agent_cat, 'cost': cost})
        chunk_costs[cid] = {'total': total, 'agents': per_agent}

    sorted_by_cost = sorted(chunk_order, key=lambda c: -chunk_costs[c]['total'])

    html = []
    html.append("""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<title>HSP PoC チャンク別動作レポート — """ + escape(run['run_id']) + """</title>
<style>
  body { font-family: 'Hiragino Sans', 'Noto Sans JP', sans-serif;
         max-width: 1200px; margin: 1.5rem auto; padding: 0 1rem;
         line-height: 1.55; color: #1e293b; background: #f8fafc; }
  h1 { font-size: 1.7rem; border-bottom: 3px solid #2563eb; padding-bottom: .3rem; }
  h2 { font-size: 1.15rem; color: #2563eb; margin: 1.4rem 0 .4rem; }
  h3 { font-size: 1rem; color: #475569; margin: .8rem 0 .3rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0; font-size: .85rem; }
  th { background: #dbeafe; padding: .35rem .7rem; text-align: left; }
  td { padding: .3rem .7rem; border-top: 1px solid #e2e8f0; vertical-align: top; }
  tr:hover td { background: #f1f5f9; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .accepted { color: #16a34a; font-weight: bold; }
  .manual_review { color: #d97706; font-weight: bold; }
  .invalid_output { color: #dc2626; font-weight: bold; }
  details { background: #fff; border: 1px solid #e2e8f0; border-radius: 6px;
            margin: .4rem 0; padding: .5rem .9rem; }
  details[open] { border-color: #93c5fd; }
  summary { cursor: pointer; font-weight: 600; }
  .timeline { font-family: 'Consolas', monospace; font-size: .78rem; background: #1e293b;
              color: #e2e8f0; padding: .6rem; border-radius: 4px; overflow-x: auto;
              white-space: pre; line-height: 1.4; }
  .timeline .phase-cue_structure { color: #fbbf24; }
  .timeline .phase-planning { color: #60a5fa; }
  .timeline .phase-repair { color: #f87171; }
  .timeline .phase-quality { color: #34d399; }
  .timeline .phase-preprocess { color: #a78bfa; }
  .timeline .phase-tool { color: #94a3b8; }
  .timeline .phase-validation { color: #fca5a5; font-weight: bold; }
  .timeline .phase-chunk { color: #cbd5e1; }
  .tag { display: inline-block; background: #e2e8f0; padding: 1px 6px; border-radius: 3px;
         font-size: .75rem; margin-right: .3rem; }
  .tag-mini { background: #dbeafe; color: #1e40af; }
  .tag-nano { background: #d1fae5; color: #065f46; }
  .tag-gpt55 { background: #fee2e2; color: #991b1b; }
  .cue-list { font-size: .8rem; }
  .cue-list tr.violate td { background: #fef3c7; }
  nav { position: sticky; top: 1rem; float: right; width: 200px; margin-left: 1rem;
        background: #fff; border: 1px solid #e2e8f0; border-radius: 8px;
        padding: .5rem .8rem; font-size: .8rem; max-height: 80vh; overflow-y: auto; }
  nav a { display: block; color: #2563eb; text-decoration: none; margin: .15rem 0; }
  nav a:hover { text-decoration: underline; }
  .note { background: #fef9c3; border-left: 4px solid #eab308;
          padding: .4rem .8rem; border-radius: 0 4px 4px 0; margin: .5rem 0; font-size: .85rem; }
  .progress-bar { display: inline-block; height: 10px; background: #93c5fd;
                  border-radius: 2px; vertical-align: middle; margin-left: .5rem; }
  .trace-block { background: #fff; border: 1px solid #cbd5e1; border-radius: 5px;
                 padding: .5rem .7rem; margin: .4rem 0; }
  .trace-block.gpt55 { border-left: 4px solid #ef4444; background: #fef2f2; }
  .trace-block.mini  { border-left: 4px solid #3b82f6; background: #eff6ff; }
  .trace-block.nano  { border-left: 4px solid #10b981; background: #ecfdf5; }
  .trace-block h4 { margin: 0 0 .3rem 0; font-size: .92rem; font-family: 'Hiragino Sans', sans-serif; }
  .trace-step { font-family: 'Consolas', monospace; font-size: .76rem;
                padding: 2px 6px; margin: 1px 0; border-radius: 2px;
                white-space: pre-wrap; word-break: break-all; }
  .trace-step.tool_call    { background: #dbeafe; color: #1e3a8a; }
  .trace-step.tool_output  { background: #f1f5f9; color: #334155; padding-left: 1.5rem; }
  .trace-step.reasoning    { background: #fef3c7; color: #92400e; font-style: italic; }
  .trace-step.final_message{ background: #d1fae5; color: #065f46; font-weight: bold; }
  .step-label { display: inline-block; font-weight: bold; min-width: 90px; }
  .check-ok { color: #16a34a; font-weight: bold; }
  .check-fail { color: #dc2626; font-weight: bold; }
</style>
</head>
<body>
""")

    html.append(f"<h1>HSP PoC チャンク別動作レポート</h1>")
    html.append(f"<p>run_id: <code>{escape(run['run_id'])}</code> ／ fixture: <code>{escape(os.path.basename(run.get('fixture','')))}</code></p>")

    # === Overall summary ===
    html.append("<h2>📊 全体サマリー</h2>")
    html.append("<table>")
    html.append(f"<tr><th>チャンク数</th><td>{metrics['chunks']['total']}</td></tr>")
    html.append(f"<tr><th>accepted</th><td><span class='accepted'>{metrics['chunks']['accepted']} ({metrics['chunks']['accepted_rate']}%)</span></td></tr>")
    html.append(f"<tr><th>manual_review</th><td><span class='manual_review'>{metrics['chunks']['manual_review']} ({metrics['chunks']['manual_review_rate']}%)</span></td></tr>")
    html.append(f"<tr><th>invalid_output</th><td><span class='invalid_output'>{metrics['chunks']['invalid_output']}</span></td></tr>")
    html.append(f"<tr><th>hard constraint pass率</th><td>{metrics['cues']['hard_constraint_pass_rate']}%</td></tr>")
    html.append(f"<tr><th>model calls 合計</th><td>{metrics['model_calls']}</td></tr>")
    html.append(f"<tr><th>repair iterations 平均</th><td>{metrics['repair']['avg_iterations']}</td></tr>")
    html.append(f"<tr><th>入力 tokens</th><td class='num'>{metrics['token_usage']['input_tokens']:,}</td></tr>")
    html.append(f"<tr><th>キャッシュ入力</th><td class='num'>{metrics['token_usage']['cached_input_tokens']:,}</td></tr>")
    html.append(f"<tr><th>出力 tokens</th><td class='num'>{metrics['token_usage']['output_tokens']:,}</td></tr>")
    html.append(f"<tr><th>実測コスト合計</th><td class='num'><b>${metrics['cost_estimate']['estimated_usd']:.4f}</b></td></tr>")
    html.append("</table>")

    # Model config
    html.append("<h2>⚙️ 各エージェントのモデル設定</h2>")
    html.append("<table><tr><th>役割</th><th>モデル</th></tr>")
    role_labels = {
        'cueStructure': 'CueStructure（区切り候補生成）',
        'planner': 'ChunkPlanner（中核：分割計画）',
        'repair': 'RepairPlanner（失敗時の修復）',
        'oneWord': 'OneWordRepair（1語削減）',
        'critic': 'QualityCritic（品質審査）',
        'mergeRewrite': 'MergeRewrite（統合書き直し）',
        'fallback': 'Fallback（最終手段）',
    }
    for k, label in role_labels.items():
        m = models_map.get(k, '(未設定)')
        tag = ''
        if 'nano' in m: tag = "tag tag-nano"
        elif 'gpt-5.5' in m: tag = "tag tag-gpt55"
        elif 'mini' in m: tag = "tag tag-mini"
        html.append(f"<tr><td>{label}</td><td><span class='{tag}'>{escape(m)}</span></td></tr>")
    html.append(f"<tr><td>Correction（書き起こし用語補正）</td><td><span class='tag tag-nano'>{escape(data['correction_model'])}</span></td></tr>")
    html.append("</table>")

    # Stats by status
    html.append("<h2>📈 ステータス分布</h2>")
    html.append("<table><tr><th>状態</th><th>件数</th><th>平均コスト</th></tr>")
    for st in ['accepted', 'manual_review', 'invalid_output', 'unknown']:
        ids = [c for c in chunk_order if (chunks[c]['final_status'] or 'unknown') == st]
        if not ids: continue
        avg = sum(chunk_costs[c]['total'] for c in ids) / len(ids)
        css_cls = st
        html.append(f"<tr><td><span class='{css_cls}'>{st}</span></td><td class='num'>{len(ids)}</td><td class='num'>${avg:.4f}</td></tr>")
    html.append("</table>")

    # Top costly chunks
    html.append("<h2>💰 コスト上位10チャンク</h2>")
    html.append("<table><tr><th>#</th><th>chunk</th><th>状態</th><th>呼出</th><th>コスト</th></tr>")
    for cid in sorted_by_cost[:10]:
        st = chunks[cid]['final_status'] or 'unknown'
        ncalls = sum(u['calls'] for u in chunk_usage[cid].values())
        html.append(f"<tr><td>{cid}</td><td><a href='#{cid}'>{cid}</a></td><td><span class='{st}'>{st}</span></td><td class='num'>{ncalls}</td><td class='num'>${chunk_costs[cid]['total']:.4f}</td></tr>")
    html.append("</table>")

    # nav
    html.append("<nav><strong>チャンク一覧</strong>")
    for cid in chunk_order:
        st = chunks[cid]['final_status'] or 'unknown'
        cost = chunk_costs[cid]['total']
        icon = {'accepted': '✅', 'manual_review': '🟡', 'invalid_output': '❌'}.get(st, '?')
        html.append(f"<a href='#{cid}'>{icon} {cid} <small>(${cost:.3f})</small></a>")
    html.append("</nav>")

    # === Per-chunk sections ===
    html.append("<h2>📋 チャンク別の動作ログ</h2>")
    html.append('<div class="note">各チャンクを展開すると、実際のイベント時系列・エージェントごとのトークン消費・最終 cue 出力を確認できます。</div>')

    for cid in chunk_order:
        ch = chunks[cid]
        st = ch['final_status'] or 'unknown'
        cost = chunk_costs[cid]['total']
        n_repair = ch['agents'].get('RepairPlannerAgent', 0)
        n_planner = ch['agents'].get('ChunkPlannerAgent', 0)
        fb_called = any('Fallback' in c['cat'] for c in chunk_costs[cid]['agents'])
        fb_tag = " 🔥Fallback" if fb_called else ""
        html.append(f"<details id='{cid}'><summary>")
        html.append(f"<span class='{st}'>{st.upper()}</span> &nbsp; <code>{cid}</code> &nbsp; ${cost:.4f}{fb_tag} &nbsp; repair×{n_repair} planner×{n_planner}")
        html.append("</summary>")

        # Timeline
        html.append("<h3>⏱️ イベント時系列</h3>")
        html.append('<div class="timeline">')
        for ev in ch['events']:
            phase = ev.get('phase', '')
            et = ev.get('event_type', '')
            agent = ev.get('agent', '')
            model = ev.get('model', '')
            summary = ev.get('summary', '')
            phase_class = f"phase-{phase}"
            line = f"[{phase}/{et}]"
            if agent:
                line += f" {agent}"
            if model:
                line += f" <{model}>"
            if summary:
                line += f" :: {summary}"
            html.append(f"<span class='{phase_class}'>{escape(line)}</span>\n")
        html.append('</div>')

        # Validation failures
        if ch['failures']:
            html.append("<h3>❌ Validation 失敗の内訳</h3>")
            html.append("<table><tr><th>#</th><th>失敗内容</th><th>違反コード</th></tr>")
            for i, f in enumerate(ch['failures'], 1):
                codes_str = ', '.join(set(f['codes'])) if f['codes'] else '-'
                html.append(f"<tr><td>{i}</td><td>{escape(f['summary'])}</td><td><code>{escape(codes_str)}</code></td></tr>")
            html.append("</table>")

        # Per-agent cost
        html.append("<h3>💰 エージェント別トークン消費</h3>")
        html.append("<table><tr><th>エージェント</th><th>モデル</th><th>呼出</th><th>入力</th><th>キャッシュ</th><th>出力</th><th>コスト</th></tr>")
        for a in chunk_costs[cid]['agents']:
            m = a['model']
            cls = ''
            if 'nano' in m: cls = "tag tag-nano"
            elif 'gpt-5.5' in m: cls = "tag tag-gpt55"
            elif 'mini' in m: cls = "tag tag-mini"
            html.append(f"<tr><td>{escape(a['cat'])}</td><td><span class='{cls}'>{escape(m)}</span></td>"
                        f"<td class='num'>{a['calls']}</td>"
                        f"<td class='num'>{a['input']:,}</td>"
                        f"<td class='num'>{a['cached']:,}</td>"
                        f"<td class='num'>{a['output']:,}</td>"
                        f"<td class='num'>${a['cost']:.4f}</td></tr>")
        html.append(f"<tr><th colspan='6'>合計</th><th class='num'>${cost:.4f}</th></tr>")
        html.append("</table>")

        # Agent internal traces
        traces = chunk_traces.get(cid, [])
        if traces:
            html.append("<h3>🧠 各エージェントの内部動作（tool call trace）</h3>")
            html.append('<div class="note">Agent SDK の <code>newItems</code> から抽出。各 Agent が tool を呼んで結果を見ながら判断しているかを確認できます。</div>')
            for tr in traces:
                m = tr['model']
                model_cls = 'gpt55' if 'gpt-5.5' in m else ('nano' if 'nano' in m else 'mini')
                # quick stats
                n_tool = sum(1 for s in tr['steps'] if s[0] == 'tool_call')
                n_reason = sum(1 for s in tr['steps'] if s[0] == 'reasoning')
                tools_used = {}
                for s in tr['steps']:
                    if s[0] == 'tool_call':
                        tools_used[s[1]] = tools_used.get(s[1], 0) + 1
                tools_summary = ', '.join(f'{k}×{v}' for k,v in tools_used.items()) if tools_used else '(なし)'
                html.append(f'<div class="trace-block {model_cls}">')
                html.append(f'<h4>{escape(tr["label"])} <span class="tag tag-{model_cls}">{escape(m)}</span> &nbsp; <small>tool×{n_tool} / reasoning×{n_reason} / {escape(tools_summary)}</small></h4>')

                # render steps
                # Pair tool_call with its matching output
                for i, (kind, name, payload) in enumerate(tr['steps']):
                    if kind == 'tool_call':
                        args_short = payload[:200].replace('\n', ' ')
                        html.append(f'<div class="trace-step tool_call"><span class="step-label">→ {escape(name)}</span> args: {escape(args_short)}{"…" if len(payload)>200 else ""}</div>')
                    elif kind == 'tool_output':
                        out_short = payload[:200].replace('\n', ' ')
                        # check if it indicates ok/fail
                        marker = ''
                        if '"ok":true' in payload[:300]:
                            marker = '<span class="check-ok">✓ ok</span> '
                        elif '"ok":false' in payload[:300] or '"issues":[{' in payload[:300]:
                            marker = '<span class="check-fail">✗ failed</span> '
                        html.append(f'<div class="trace-step tool_output">  ← {escape(name)} output: {marker}{escape(out_short)}{"…" if len(payload)>200 else ""}</div>')
                    elif kind == 'reasoning':
                        text_short = payload[:300].replace('\n', ' ')
                        if text_short.strip():
                            html.append(f'<div class="trace-step reasoning"><span class="step-label">💭 reasoning</span>: {escape(text_short)}{"…" if len(payload)>300 else ""}</div>')
                        else:
                            html.append(f'<div class="trace-step reasoning"><span class="step-label">💭 reasoning</span>: <em>(空の reasoning スロット — 高度モデルのプライベート思考)</em></div>')
                    elif kind == 'final_message':
                        text_short = payload[:300].replace('\n', ' ')
                        html.append(f'<div class="trace-step final_message"><span class="step-label">🎯 final</span>: {escape(text_short)}{"…" if len(payload)>300 else ""}</div>')
                html.append('</div>')

        # Final cues
        cues = chunk_cues.get(cid, [])
        if cues:
            html.append(f"<h3>🎬 最終 cue 出力（{len(cues)} 件）</h3>")
            html.append("<table class='cue-list'><tr><th>#</th><th>start</th><th>end</th><th>dur</th><th>cps</th><th>EN</th></tr>")
            for i, c in enumerate(cues, 1):
                start = c.get('start', 0)
                end = c.get('end', 0)
                dur = end - start
                cps = c.get('cps', '')
                en = (c.get('en') or '').replace('\n', ' / ')
                violate = (isinstance(dur, (int, float)) and dur > 7.05) or (isinstance(cps, (int, float)) and cps > 17.5)
                cls = ' class="violate"' if violate else ''
                html.append(f"<tr{cls}><td>{i}</td><td class='num'>{start:.2f}</td><td class='num'>{end:.2f}</td>"
                            f"<td class='num'>{dur:.2f}</td><td class='num'>{cps}</td><td>{escape(en)}</td></tr>")
            html.append("</table>")

        html.append("</details>")

    html.append("</body></html>")

    out_path.write_text('\n'.join(html), encoding='utf-8')
    print(f"Generated: {out_path}")
    print(f"  chunks: {len(chunk_order)}")
    print(f"  total cost: ${sum(chunk_costs[c]['total'] for c in chunk_order):.4f}")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python generate_chunk_report.py <run_dir> [out_path]")
        sys.exit(1)
    run_dir = Path(sys.argv[1])
    out_path = Path(sys.argv[2]) if len(sys.argv) > 2 else run_dir / 'reports' / 'chunk_report.html'
    data = parse_run(run_dir)
    gen_html(data, out_path)
