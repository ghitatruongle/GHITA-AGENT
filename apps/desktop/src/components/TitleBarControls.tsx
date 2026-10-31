// Window control buttons for the frameless main window (decorations: false).
// The GHITA top bar doubles as the title bar: drag region + these buttons.
// Tauri APIs are invoked lazily (dynamic import + catch) so the component is
// safe to render in non-Tauri environments (tests, plain browser).

import { Minus, Square, X } from 'lucide-react';

type WindowAction = 'minimize' | 'toggleMaximize' | 'close';

async function invokeWindow(action: WindowAction): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const appWindow = getCurrentWindow();
    if (action === 'minimize') await appWindow.minimize();
    else if (action === 'toggleMaximize') await appWindow.toggleMaximize();
    else await appWindow.close();
  } catch {
    // Non-Tauri environment (tests, plain browser) — nothing to control.
  }
}

const baseButton =
  'flex items-center justify-center w-10 h-10 text-slate-400 hover:text-slate-100 hover:bg-white/10 transition-colors outline-none';

export function TitleBarControls() {
  return (
    <div className="flex items-center shrink-0 h-10" role="group" aria-label="Window controls">
      <button className={baseButton} title="Thu nhỏ" onClick={() => void invokeWindow('minimize')}>
        <Minus size={14} />
      </button>
      <button
        className={baseButton}
        title="Phóng to / Thu về"
        onClick={() => void invokeWindow('toggleMaximize')}
      >
        <Square size={11} />
      </button>
      <button
        className={`${baseButton} hover:!bg-red-500 hover:!text-white`}
        title="Tắt"
        onClick={() => void invokeWindow('close')}
      >
        <X size={15} />
      </button>
    </div>
  );
}
