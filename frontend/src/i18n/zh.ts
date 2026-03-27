import type { LocaleStrings } from './types'

export const zh: LocaleStrings = {
  id: 'zh',
  label: '中文',

  videoPlayer: '视频播放器',
  tabSubtitles: '字幕块',
  tabDictionary: '词汇表',
  tabHelp: '帮助',
  saving: '保存中…',
  saved: '✓ 已保存',
  loadProject: '加载',
  saveProject: '保存',
  exportSrt: '导出 SRT',
  loadProjectTitle: '加载项目 JSON',
  saveProjectTitle: '保存为项目 JSON',
  exportSrtTitle: '导出为 SRT 文件',
  restored: '已恢复上次的工作',
  approvedCount: (a, t) => `${a} / ${t} 已审批`,
  reSplitAlert: (id) => `重新分割块 #${id}（正式版将调用 LLM API）`,
  reTranslateAlert: (id) => `重新翻译块 #${id}（正式版将调用 LLM API）`,
  importError: '项目文件加载失败',

  approve: '审批',
  approvedBtn: '已审批 ✓',
  reSplit: '重新分割',
  reTranslate: '重新翻译',
  editHint: 'Enter 换行 ／ Shift+Enter 分割 ／ Ctrl+Enter 保存 ／ Esc 取消',
  charCount: (lines, isOver) => `字数: ${lines.join(' / ')}${isOver ? ' ⚠' : ''}`,
  timeErrorFormat: '格式: MM:SS.mmm',
  timeErrorStartNeg: '开始时间必须 ≥ 0',
  timeErrorOrder: '开始时间必须 < 结束时间',
  timeEditTitle: '点击直接编辑时间',

  gapLabel: (s) =>
    s >= 60
      ? `${Math.floor(s / 60)}分${(s % 60).toFixed(1)}秒 空白`
      : `${s.toFixed(1)}秒 空白`,
  gapDragHint: '← Ctrl+拖动调整',
  boundaryDragging: '⟷ 调整边界中（松开 Ctrl 取消）',
  boundaryHover: 'Ctrl+拖动调整时间边界',

  registeredTerms: (n) => `已注册术语 (${n})`,
  unregisteredTerms: (n) => `检测到但未注册的术语 (${n})`,
  confirmed: '已确认',
  unconfirmed: '未确认',
  unregistered: '未注册',
  source: '来源:',
  requestConfirmation: '创建 Issue',
  confirmedBtn: '已确认 ✓',
  addToDictionary: '添加到词汇表',
  noDesc: '（暂无说明）',

  guide: [
    {
      title: '基本工作流程',
      paragraphs: [
        '本工具是一款字幕编辑器，用于加载SRT文件和视频，逐块检查和编辑内容，最终导出SRT文件。',
        '① 加载SRT/项目  ② 播放视频逐块确认  ③ 编辑文本和时间  ④ 确认无误后审批  ⑤ 导出SRT',
        '项目会自动保存在浏览器中，也支持JSON格式的导出和导入。',
      ],
    },
    {
      title: '字幕块与CPS（字符/秒）',
      paragraphs: [
        '每个块是在"开始时间〜结束时间"区间内显示在屏幕上的单个字幕单元，包含原文文本和译文文本。',
        'CPS（Characters Per Second，字符/秒）是衡量阅读速度的指标：字符数 ÷ 显示秒数。依据Netflix字幕指南分三档显示颜色。',
        '🟢 绿色（CPS ≤ 15）：阅读舒适  🟡 黄色（15〜20）：略快，建议确认  🔴 红色（> 20）：过快，建议分割',
      ],
    },
    {
      title: '审批（锁定）机制',
      paragraphs: [
        '点击审批按钮可锁定块的内容和时间，防止误操作。已审批的块不能编辑时间、合并或拖动边界。',
        '逐步审批完成的块可方便追踪进度。如需修改，再次点击审批按钮可解除锁定。',
      ],
    },
    {
      title: '时间轴与视频联动',
      paragraphs: [
        '左下方时间轴将所有块显示在时间轴上，块的颜色与CPS联动，有问题的块一目了然。',
        '对于2小时的讲座，可使用滚轮缩放查看细节。缩放时会显示缩略图，方便掌握在整体时间轴中的位置。',
        '最直观的时间调整方式是播放视频，按I键标记入点，按O键标记出点，操作感与视频编辑软件相同。',
      ],
    },
    {
      title: '词汇表的使用',
      paragraphs: [
        '词汇表标签页集中管理专业术语的译名。已确认的术语会在字幕块中自动高亮显示。',
        '从参考资料中检测到的未注册术语会显示橙色警告。可使用"请求确认"按钮核实翻译准确性。',
      ],
    },
  ],
  shortcutsTitle: '键盘 & 鼠标操作一览',
  shortcuts: [
    {
      category: '编辑',
      items: [
        { keys: ['点击（原文文本）'], desc: '进入编辑模式' },
        { keys: ['Enter'], desc: '插入换行（每行建议42字以内）' },
        { keys: ['Ctrl', 'Enter'], desc: '保存编辑' },
        { keys: ['Esc'], desc: '取消编辑' },
        { keys: ['Shift', 'Enter'], desc: '在光标处分割块' },
      ],
    },
    {
      category: '分割',
      items: [
        { keys: ['✂ 播放位置'], desc: '在播放位置分割块（仅在播放头位于块内时有效）' },
        { keys: ['÷ 等分'], desc: '将块在时间和文本上等分为两半' },
      ],
    },
    {
      category: '合并',
      items: [
        { keys: ['拖放'], desc: '合并两个块（已审批的块除外）' },
        { keys: ['Ctrl', 'M'], desc: '将当前块与下一块合并' },
        { keys: ['Ctrl', 'Shift', 'M'], desc: '将当前块与上一块合并' },
      ],
    },
    {
      category: '审批',
      items: [
        { keys: ['审批按钮'], desc: '将块标记为已审批（锁定时间和内容）' },
        { keys: ['已审批'], desc: '禁止编辑时间、合并和边界拖动' },
      ],
    },
    {
      category: '历史记录',
      items: [
        { keys: ['Ctrl', 'Z'], desc: '撤销' },
        { keys: ['Ctrl', 'Shift', 'Z'], desc: '重做' },
        { keys: ['Ctrl', 'Y'], desc: '重做（备用）' },
      ],
    },
    {
      category: '时间调整',
      items: [
        { keys: ['I'], desc: '将当前块的开始时间设为播放位置（标记入点）' },
        { keys: ['O'], desc: '将当前块的结束时间设为播放位置（标记出点）' },
        { keys: ['‹← / →›（时间戳旁）'], desc: '开始/结束时间 ±0.1s 微调' },
        { keys: ['点击（时间戳）'], desc: '以 MM:SS.mmm 格式直接输入时间' },
        { keys: ['Ctrl', '拖动（边界线）←→'], desc: '移动相邻块的时间边界（松开 Ctrl 取消）' },
        { keys: ['Ctrl', '拖动（时间轴边界）'], desc: '在下方时间轴直接拖动块边界进行调整' },
        { keys: ['点击 / 拖动（时间轴）'], desc: '点击或拖动时间轴进行定位' },
        { keys: ['滚轮（时间轴上）'], desc: '以光标为中心缩放（最大20倍）' },
        { keys: ['缩略图拖动'], desc: '缩放时拖动上方缩略图进行平移' },
      ],
    },
    {
      category: '视频',
      items: [
        { keys: ['点击（视频）'], desc: '播放 / 暂停' },
        { keys: ['点击（块）'], desc: '跳转到该字幕位置' },
        { keys: ['拖动（进度条）'], desc: '拖动进度条跳转到任意位置' },
      ],
    },
    {
      category: '面板操作',
      items: [
        { keys: ['←→ 拖动（中央分隔条）'], desc: '调整左右面板宽度（25〜72%）' },
        { keys: ['↕ 拖动（视频/时间轴边界）'], desc: '调整时间轴高度（30〜200 px）' },
      ],
    },
  ],
  aiAskTitle: '询问 AI',
  aiAskDesc: '未来版本将支持在此面板直接向 AI 询问工具使用方法或提示词调整问题。',

  settingsColorTheme: '颜色主题',
  settingsLanguage: '语言',
  pocThemeDesc: '深蓝色系（开发默认）',
  matsuoThemeDesc: '白色 × 灰色 × 深蓝',
}
