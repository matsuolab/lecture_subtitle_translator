import type { LocaleStrings } from './types'

export const en: LocaleStrings = {
  id: 'en',
  label: 'English',

  videoPlayer: 'Video Player',
  tabSubtitles: 'Subtitle Blocks',
  tabDictionary: 'Glossary',
  tabHelp: 'Help',
  saving: 'Saving…',
  saved: '✓ Saved',
  loadProject: 'Load',
  saveProject: 'Save',
  exportSrt: 'Export SRT',
  loadProjectTitle: 'Load project JSON',
  saveProjectTitle: 'Save as project JSON',
  exportSrtTitle: 'Export as SRT file',
  restored: 'Previous session restored',
  approvedCount: (a, t) => `${a} / ${t} approved`,
  reSplitAlert: (id) => `Re-splitting block #${id} (calls LLM API in production)`,
  reTranslateAlert: (id) => `Re-translating block #${id} (calls LLM API in production)`,
  importError: 'Failed to load project file',
  loadSrt: 'Load SRT',
  loadSrtTitle: 'Load SRT file (1 line: English only / 2 lines: Japanese + English)',
  importSrtError: 'Failed to load SRT file',

  approve: 'Approve',
  approvedBtn: 'Approved ✓',
  reSplit: 'Re-split',
  reTranslate: 'Re-translate',
  editHint: 'Enter to newline ／ Shift+Enter to split ／ Ctrl+Enter to save ／ Esc to cancel',
  charCount: (lines, isOver) => `Chars: ${lines.join(' / ')}${isOver ? ' ⚠' : ''}`,
  timeErrorFormat: 'Format: MM:SS.mmm',
  timeErrorStartNeg: 'Start must be ≥ 0',
  timeErrorOrder: 'Start must be < End',
  timeEditTitle: 'Click to edit time directly',

  gapLabel: (s) =>
    s >= 60
      ? `${Math.floor(s / 60)}m ${(s % 60).toFixed(1)}s gap`
      : `${s.toFixed(1)}s gap`,
  gapDragHint: '← Ctrl+drag to adjust',
  boundaryDragging: '⟷ Adjusting boundary (release Ctrl to cancel)',
  boundaryHover: 'Ctrl+drag to adjust time boundary',

  registeredTerms: (n) => `Registered terms (${n})`,
  unregisteredTerms: (n) => `Detected but not in glossary (${n})`,
  confirmed: 'Confirmed',
  unconfirmed: 'Unconfirmed',
  unregistered: 'Unregistered',
  source: 'Source:',
  requestConfirmation: 'Create Issue',
  confirmedBtn: 'Confirmed ✓',
  addToDictionary: 'Add to glossary',
  noDesc: '(No description)',

  guide: [
    {
      title: 'Basic Workflow',
      paragraphs: [
        'This tool is a subtitle editor for loading an SRT file and video, reviewing and editing each block, and exporting the final SRT.',
        '① Load SRT / project  ② Review each block while playing the video  ③ Edit text and timing  ④ Approve when satisfied  ⑤ Export as SRT',
        'The project is auto-saved in the browser. JSON export and import are also available.',
      ],
    },
    {
      title: 'Subtitle Blocks and CPS (Characters Per Second)',
      paragraphs: [
        'Each block is a single subtitle unit displayed on screen during a "start time – end time" interval. It holds both the source text and the translation.',
        'CPS (Characters Per Second) measures reading speed: character count ÷ display duration. Blocks are color-coded in three levels following Netflix subtitle guidelines.',
        '🟢 Green (CPS ≤ 15): comfortable reading speed  🟡 Yellow (15–20): slightly fast, review recommended  🔴 Red (> 20): too fast, consider splitting',
      ],
    },
    {
      title: 'Approval (Lock) System',
      paragraphs: [
        'Clicking Approve locks a block\'s content and timing to prevent accidental edits. Approved blocks cannot have their times edited, be merged, or have their boundaries dragged.',
        'Approving blocks as you finish them lets you track progress at a glance. Click Approve again to unlock a block if you need to make corrections.',
      ],
    },
    {
      title: 'Timeline and Video Integration',
      paragraphs: [
        'The timeline at the bottom left shows all blocks on a time axis. Block colors reflect CPS, so problem blocks are immediately visible.',
        'For 2-hour lectures, use the scroll wheel to zoom in for detail. A minimap appears when zoomed so you always know where you are in the full timeline.',
        'The most intuitive way to adjust timing is to play the video and press I to mark the in-point and O to mark the out-point — the same workflow as video editing software.',
      ],
    },
    {
      title: 'Using the Glossary',
      paragraphs: [
        'The Glossary tab centralizes translations for technical terms. Confirmed terms are automatically highlighted inside subtitle blocks.',
        'Unregistered terms detected from reference materials are shown as orange warnings. Use the "Create Issue" button to open a review request Issue (planned feature).',
      ],
    },
  ],
  shortcutsTitle: 'Keyboard & Mouse Reference',
  shortcuts: [
    {
      category: 'Edit',
      items: [
        { keys: ['Click (source text)'], desc: 'Enter edit mode' },
        { keys: ['Enter'], desc: 'Insert line break (42 chars per line recommended)' },
        { keys: ['Ctrl', 'Enter'], desc: 'Save edit' },
        { keys: ['Esc'], desc: 'Cancel edit' },
        { keys: ['Shift', 'Enter'], desc: 'Split block at cursor' },
      ],
    },
    {
      category: 'Split',
      items: [
        { keys: ['✂ At Playhead'], desc: 'Split block at playhead position (only active when playhead is inside the block)' },
        { keys: ['÷ Equal Split'], desc: 'Split block into two equal halves (time and text)' },
      ],
    },
    {
      category: 'Merge',
      items: [
        { keys: ['Drag & Drop'], desc: 'Merge two blocks (approved blocks excluded)' },
        { keys: ['Ctrl', 'M'], desc: 'Merge active block with next' },
        { keys: ['Ctrl', 'Shift', 'M'], desc: 'Merge active block with previous' },
      ],
    },
    {
      category: 'Approve',
      items: [
        { keys: ['Approve button'], desc: 'Mark block as approved (locks timing and content)' },
        { keys: ['Approved'], desc: 'Time editing, merging, and boundary drag are disabled' },
      ],
    },
    {
      category: 'History',
      items: [
        { keys: ['Ctrl', 'Z'], desc: 'Undo' },
        { keys: ['Ctrl', 'Shift', 'Z'], desc: 'Redo' },
        { keys: ['Ctrl', 'Y'], desc: 'Redo (alternate)' },
      ],
    },
    {
      category: 'Time',
      items: [
        { keys: ['I'], desc: 'Set active block start = playback position (mark in)' },
        { keys: ['O'], desc: 'Set active block end = playback position (mark out)' },
        { keys: ['‹← / →› (next to timestamp)'], desc: 'Fine-tune start/end by ±0.1s' },
        { keys: ['Click (timestamp)'], desc: 'Type time directly in MM:SS.mmm format' },
        { keys: ['Ctrl', 'Drag (boundary) ←→'], desc: 'Shift time boundary between adjacent blocks (Ctrl release = cancel)' },
        { keys: ['Ctrl', 'Drag (timeline boundary)'], desc: 'Drag block boundary on the bottom timeline' },
        { keys: ['Click / Drag (timeline)'], desc: 'Click or drag the timeline to seek' },
        { keys: ['Wheel (on timeline)'], desc: 'Zoom in/out centered on cursor (up to 20×)' },
        { keys: ['Minimap drag'], desc: 'Drag the minimap (shown when zoomed) to pan' },
      ],
    },
    {
      category: 'Video',
      items: [
        { keys: ['Click (video)'], desc: 'Play / Pause' },
        { keys: ['Click (block)'], desc: 'Seek to subtitle position' },
        { keys: ['Drag (seek bar)'], desc: 'Drag the seek bar to any position' },
      ],
    },
    {
      category: 'Panels',
      items: [
        { keys: ['←→ Drag (center handle)'], desc: 'Resize left/right panel width (25–72%)' },
        { keys: ['↕ Drag (video/timeline border)'], desc: 'Resize timeline height (30–200 px)' },
      ],
    },
  ],
  aiAskTitle: 'Ask AI',
  aiAskDesc: 'In a future version you will be able to ask AI questions about the tool or prompt tuning directly from this panel.',

  settingsColorTheme: 'Color Theme',
  settingsLanguage: 'Language',
  pocThemeDesc: 'Dark blue (development default)',
  matsuoThemeDesc: 'White × Gray × Deep blue',
}
