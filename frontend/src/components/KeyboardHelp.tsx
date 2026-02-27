import { useEffect, useRef } from 'react';
import { Keyboard } from 'lucide-react';
import { HOTKEY_LABELS, bindingToDisplayKeys } from '../utils/hotkeys';

interface KeyboardHelpProps {
  onClose: () => void;
  hotkeys: Record<string, string>;
}

const STATIC_SHORTCUTS = [
  { keys: ['Ctrl', '1\u20130'], action: 'Switch to numbered window' },
  { keys: ['Alt', '1\u20139'], action: 'Switch to window N in session' },
  { keys: ['Ctrl', 'Alt', '1\u20130'], action: 'Assign/unassign number' },
  { keys: ['\u2191', '\u2193'], action: 'Navigate in switcher' },
  { keys: ['Enter'], action: 'Select in switcher' },
  { keys: ['Esc'], action: 'Close dialog / switcher' },
];

export function KeyboardHelp({ onClose, hotkeys }: KeyboardHelpProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onClose]);

  const configurableShortcuts = (Object.entries(HOTKEY_LABELS) as [string, string][]).map(([id, action]) => ({
    keys: bindingToDisplayKeys(hotkeys[id] ?? ''),
    action,
  }));

  const allShortcuts = [...configurableShortcuts, ...STATIC_SHORTCUTS];

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center pt-[15vh] z-50" onClick={onClose}>
      <div
        ref={panelRef}
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-800">
          <Keyboard size={16} className="text-gray-500 shrink-0" />
          <span className="text-sm font-medium text-gray-200">Keyboard Shortcuts</span>
          <div className="flex-1" />
          <kbd className="text-[10px] text-gray-600 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">
            ESC
          </kbd>
        </div>

        <div className="px-4 py-3 space-y-2">
          {allShortcuts.map((s, i) => (
            <div key={i} className="flex items-center justify-between py-1">
              <span className="text-sm text-gray-400 whitespace-nowrap">{s.action}</span>
              <div className="flex items-center gap-1">
                {s.keys.map((key: string, j: number) => (
                  <span key={j}>
                    {j > 0 && <span className="text-gray-600 text-xs mx-0.5">+</span>}
                    <kbd className="text-xs text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700 min-w-[1.5rem] text-center inline-block">
                      {key}
                    </kbd>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
