import type { AdminSettings } from '@/types/adminSettings'

export interface LanguageRoleProfile {
  label: string
  script: 'latin' | 'japanese' | 'generic'
  sentenceEndPattern?: string
  continuationEndPattern?: string
  fragmentStartPattern?: string
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

function readRoleProfile(value: unknown, fallback: LanguageRoleProfile): LanguageRoleProfile {
  const raw = typeof value === 'object' && value !== null ? value as Partial<LanguageRoleProfile> : {}
  const script = raw.script === 'latin' || raw.script === 'japanese' || raw.script === 'generic'
    ? raw.script
    : fallback.script
  return {
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : fallback.label,
    script,
    sentenceEndPattern: typeof raw.sentenceEndPattern === 'string' ? raw.sentenceEndPattern : fallback.sentenceEndPattern,
    continuationEndPattern: typeof raw.continuationEndPattern === 'string' ? raw.continuationEndPattern : fallback.continuationEndPattern,
    fragmentStartPattern: typeof raw.fragmentStartPattern === 'string' ? raw.fragmentStartPattern : fallback.fragmentStartPattern,
  }
}

function compilePattern(pattern: string | undefined): RegExp | null {
  if (!pattern) return null
  try {
    return new RegExp(pattern, 'i')
  } catch {
    return null
  }
}

export function loadLanguageProfileConfig(settings: AdminSettings): LanguageProfileConfig {
  try {
    const parsed = settings.languageProfileConfigJson.trim()
      ? JSON.parse(settings.languageProfileConfigJson) as Partial<LanguageProfileConfig>
      : DEFAULT_LANGUAGE_PROFILE_CONFIG
    return {
      subtitle: {
        ...readRoleProfile(parsed.subtitle, DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle),
        label: settings.subtitleLanguageLabel || readRoleProfile(parsed.subtitle, DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle).label,
      },
      transcript: {
        ...readRoleProfile(parsed.transcript, DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript),
        label: settings.transcriptLanguageLabel || readRoleProfile(parsed.transcript, DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript).label,
      },
    }
  } catch {
    return {
      subtitle: { ...DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle, label: settings.subtitleLanguageLabel || DEFAULT_LANGUAGE_PROFILE_CONFIG.subtitle.label },
      transcript: { ...DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript, label: settings.transcriptLanguageLabel || DEFAULT_LANGUAGE_PROFILE_CONFIG.transcript.label },
    }
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
