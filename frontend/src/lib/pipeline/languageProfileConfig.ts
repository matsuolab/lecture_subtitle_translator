import type { AdminSettings } from '@/types/adminSettings'

export type LanguageScript = 'latin' | 'japanese' | 'generic'

export interface LanguageRoleProfile {
  label: string
  script: LanguageScript
  sentenceEndPattern?: string
  continuationEndPattern?: string
  fragmentStartPattern?: string
  /**
   * 「この字種が十分に出力されていれば翻訳済み」と見なす文字クラス（正規表現）。
   * 未指定なら script 既定（latin: 英字 / japanese: かな・漢字）を使う。
   * generic な言語（中国語・韓国語など）を簡易UIのラベル＋JSONだけで足すための拡張点。
   */
  translatedCharPattern?: string
}

export interface LanguageProfileConfig {
  subtitle: LanguageRoleProfile
  transcript: LanguageRoleProfile
}

export const DEFAULT_LANGUAGE_PROFILE_CONFIG: LanguageProfileConfig = {
  subtitle: {
    label: 'English',
    script: 'latin',
    sentenceEndPattern: '[.!?]$',
    continuationEndPattern: '[,;:]$',
    fragmentStartPattern: '^[a-z]|^(This|That|It|These|Then|Also|Conversely|Especially|Using|In that case)\\b',
  },
  transcript: {
    label: 'Japanese',
    script: 'japanese',
    sentenceEndPattern: '[。！？!?]$',
    continuationEndPattern: '[、,]$',
  },
}

export const DEFAULT_LANGUAGE_PROFILE_CONFIG_JSON = JSON.stringify(DEFAULT_LANGUAGE_PROFILE_CONFIG, null, 2)

/**
 * かな（ひらがな・カタカナ）＋ CJK 漢字。日本語出力の検知に使う既定文字クラス。
 * 漢字のみの固有名詞訳（例: 東京大学）も拾えるよう、かなと漢字の両方を含める。
 */
const JAPANESE_CHAR_CLASS = '぀-ヿ㐀-䶿一-鿿'

/**
 * 既知ラベル → 言語既定（script と作法パターン）。
 * 簡易UIのラベルだけ変えて JSON を空欄にした場合でも、言語に応じた script・文末パターンが
 * 反映されるようにするための「既定値プロバイダ」。第二の真実ではなく、JSON の明示指定が常に優先される。
 */
const LATIN_LANGUAGE_DEFAULTS: Omit<LanguageRoleProfile, 'label'> = {
  script: 'latin',
  sentenceEndPattern: '[.!?]$',
  continuationEndPattern: '[,;:]$',
  fragmentStartPattern: '^[a-z]|^(This|That|It|These|Then|Also|Conversely|Especially|Using|In that case)\\b',
}

const JAPANESE_LANGUAGE_DEFAULTS: Omit<LanguageRoleProfile, 'label'> = {
  script: 'japanese',
  sentenceEndPattern: '[。！？!?]$',
  continuationEndPattern: '[、,]$',
}

const KNOWN_LANGUAGE_DEFAULTS: Record<string, Omit<LanguageRoleProfile, 'label'>> = {
  english: LATIN_LANGUAGE_DEFAULTS,
  'english (us)': LATIN_LANGUAGE_DEFAULTS,
  japanese: JAPANESE_LANGUAGE_DEFAULTS,
  '日本語': JAPANESE_LANGUAGE_DEFAULTS,
  にほんご: JAPANESE_LANGUAGE_DEFAULTS,
  '日本': JAPANESE_LANGUAGE_DEFAULTS,
}

function inferLanguageDefaults(label: string): Omit<LanguageRoleProfile, 'label'> | undefined {
  return KNOWN_LANGUAGE_DEFAULTS[label.trim().toLowerCase()]
}

const VALID_SCRIPTS: ReadonlySet<LanguageScript> = new Set(['latin', 'japanese', 'generic'])

/**
 * 1 ロール分のプロファイルを解決する。各フィールドの優先順位は:
 *   1. JSON の明示指定（languageProfileConfigJson）— ただし stale でない場合のみ（下記参照）
 *   2. 簡易UIラベルから導出した既知言語の既定
 *   3. DEFAULT_LANGUAGE_PROFILE_CONFIG のフォールバック
 *
 * **stale 判定**: JSON 自身が持つ `label` が有効ラベルと食い違う場合、その JSON ブロックは
 * 「別言語向けに書かれた設定が残っているだけ」と見なし、作法パターンを一切採用しない。
 * 本番既定の languageProfileConfigJson は英日構成が事前充填されているため、簡易UIでラベルだけ
 * 入れ替えた利用者は必ずこの状態になる。script だけラベルへ追従してパターンが英語のまま残ると、
 * 日本語字幕が contextMergeFragments で断片誤判定される（句点で文末判定できないため）。
 * JSON に label が無い場合は「ラベル未記載の手書き JSON」として明示指定を尊重する。
 */
function resolveRoleProfile(
  rawValue: unknown,
  simpleLabel: string | undefined,
  fallback: LanguageRoleProfile,
): LanguageRoleProfile {
  const raw = typeof rawValue === 'object' && rawValue !== null ? rawValue as Partial<LanguageRoleProfile> : {}
  const jsonLabel = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : undefined
  const label = simpleLabel?.trim() || jsonLabel || fallback.label
  const inferred = inferLanguageDefaults(label)

  // JSON が別言語のものとして残っていないか。label 未記載なら明示指定として扱う（stale ではない）。
  const isStaleJson = jsonLabel !== undefined && !labelsMatch(jsonLabel, label)

  const explicitScript = !isStaleJson && typeof raw.script === 'string' && VALID_SCRIPTS.has(raw.script as LanguageScript)
    ? raw.script as LanguageScript
    : undefined
  // script は「どの言語か」というアイデンティティなので、既知ラベルから導出した値を最優先する。
  // （簡易UIでラベルを切り替えたら script も追従する。古い languageProfileConfigJson に残った
  //  矛盾する script を無視できるため、ラベル変更前に保存したプロジェクトも正しく読み込める。）
  // 未知ラベル（中国語など）のときだけ JSON の明示 script を使い、最後に generic へフォールバック。
  const script = inferred?.script ?? explicitScript ?? 'generic'

  const pick = (key: 'sentenceEndPattern' | 'continuationEndPattern' | 'fragmentStartPattern' | 'translatedCharPattern'): string | undefined => {
    if (!isStaleJson && typeof raw[key] === 'string') return raw[key] as string
    return inferred?.[key]
  }

  return {
    label,
    script,
    sentenceEndPattern: pick('sentenceEndPattern'),
    continuationEndPattern: pick('continuationEndPattern'),
    fragmentStartPattern: pick('fragmentStartPattern'),
    translatedCharPattern: pick('translatedCharPattern'),
  }
}

/**
 * 2つの言語ラベルが同じ言語を指すか。表記ゆれ（Japanese / 日本語 / にほんご）は
 * KNOWN_LANGUAGE_DEFAULTS の既定オブジェクト同一性で吸収し、未知ラベルは文字列比較で判定する。
 */
function labelsMatch(a: string, b: string): boolean {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true
  const inferredA = inferLanguageDefaults(a)
  const inferredB = inferLanguageDefaults(b)
  return inferredA !== undefined && inferredA === inferredB
}

/**
 * 出力が「ターゲット言語の文字」を十分含むか判定するための正規表現を返す。
 * translatedCharPattern が指定されていればそれを最優先。なければ script 既定。
 * generic でパターン未指定の場合は検知不能として null。
 */
export function resolveTargetCharMatcher(profile: LanguageRoleProfile): RegExp | null {
  if (profile.translatedCharPattern) {
    try {
      return new RegExp(profile.translatedCharPattern, 'gu')
    } catch {
      // 不正な正規表現は script 既定にフォールバック
    }
  }
  switch (profile.script) {
    case 'latin':
      return /[A-Za-z]/gu
    case 'japanese':
      return new RegExp(`[${JAPANESE_CHAR_CLASS}]`, 'gu')
    default:
      return null
  }
}

/**
 * 作法パターンをコンパイルする。**フラグは付けない**（大文字小文字を区別する）。
 *
 * かつて 'i' を固定で付けていたが、既定の fragmentStartPattern に含まれる `^[a-z]`
 * （＝「小文字始まりは前ブロックからの続き」）が大文字にもマッチしてしまい、
 * 英字で始まる英語字幕が事実上すべて「文脈依存の断片」と判定されていた。
 * リファクタ前の実装（reviewDiagnostics の `/^[a-z]/` と `/^(This|That|…)/i` の2本立て）は
 * `^[a-z]` を大文字小文字区別ありで評価していたので、その意味論へ戻す。
 *
 * 大文字小文字を無視したい独自パターンを JSON で書く場合は、JS に inline フラグが無いため
 * 文字クラスや列挙で明示する（`[A-Za-z]` / `(?:this|This)` など）。
 */
function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

export function loadLanguageProfileConfig(settings: AdminSettings): LanguageProfileConfig {
  let parsed: Partial<LanguageProfileConfig> = {}
  const rawJson = (settings.languageProfileConfigJson ?? '').trim()
  if (rawJson) {
    try {
      parsed = JSON.parse(rawJson) as Partial<LanguageProfileConfig>
    } catch {
      parsed = {}
    }
  }
  return {
    subtitle: resolveRoleProfile(parsed.subtitle, settings.subtitleLanguageLabel, DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle),
    transcript: resolveRoleProfile(parsed.transcript, settings.transcriptLanguageLabel, DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript),
  }
}

export function matchesPattern(text: string, pattern: string | undefined): boolean {
  const re = compilePattern(pattern)
  return re ? re.test(text.trim()) : false
}

export function hasSentenceEnd(text: string, profile: LanguageRoleProfile): boolean {
  return matchesPattern(text, profile.sentenceEndPattern)
}

export function hasContinuationEnd(text: string, profile: LanguageRoleProfile): boolean {
  return matchesPattern(text, profile.continuationEndPattern)
}

export function hasFragmentStart(text: string, profile: LanguageRoleProfile): boolean {
  return matchesPattern(text, profile.fragmentStartPattern)
}
