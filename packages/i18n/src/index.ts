// @ghita/i18n -- Public API

export { I18nManager } from './manager.js';
export { TranslationLoaderRegistry } from './loader.js';
export type { TranslationLoader } from './loader.js';
export { LocaleDetector } from './detector.js';
export { formatNumber, formatDate, formatCurrency, formatPlural } from './formatter.js';
export type { Locale, TranslationMessages, I18nConfig, FormatMessageOptions } from './types.js';

export const I18N_VERSION = '0.0.0-preview';
