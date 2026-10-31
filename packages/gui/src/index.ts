// --- Types ---
export type {
  WindowRole,
  WindowGeometry,
  WindowSpec,
  PersistedWindow,
  ThemeKind,
  ThemeConfig,
  ShortcutBinding,
  TrayMenuItem,
} from './types.js';

// --- Modules ---
export { WindowManager } from './manager.js';
export { WindowStateStore } from './persistence.js';
export { TrayController } from './tray.js';
export { ShortcutRegistry } from './shortcut.js';
export { ThemeManager } from './theme.js';
export { LayoutPresetManager, type LayoutPreset, type LayoutWindowEntry } from './layout-preset.js';
export { DialogService, type DialogResult, type DialogOptions, type FileFilter } from './dialog.js';
export { ClipboardService } from './clipboard.js';

export const GUI_VERSION = '0.0.0';
