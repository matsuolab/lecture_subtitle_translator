export type { LocaleStrings } from './types'
export { ja } from './ja'
export { en } from './en'
export { zh } from './zh'

import { ja } from './ja'
import { en } from './en'
import { zh } from './zh'

export const locales = [ja, en, zh] as const
export const defaultLocale = ja
