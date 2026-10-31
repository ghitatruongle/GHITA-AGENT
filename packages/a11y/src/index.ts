// @ghita/a11y -- Public API

export { AccessibilityChecker } from './checker.js';
export type { ElementDescriptor } from './checker.js';
export { AriaValidator } from './aria-validator.js';
export { ColorContrastAnalyzer } from './color-contrast.js';
export { ScreenReaderHelper } from './screen-reader.js';
export type {
  WcagLevel,
  A11ySeverity,
  A11yCategory,
  A11yIssue,
  A11yReport,
  RgbColor,
  ContrastResult,
  AriaValidationResult,
  AriaValidationError,
  AriaValidationWarning,
  AnnouncementPriority,
  ScreenReaderText,
  A11yCheckerConfig,
} from './types.js';

export const A11Y_VERSION = '0.0.0';
