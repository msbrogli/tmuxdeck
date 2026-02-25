import { useState, useRef, useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmLabel?: string;
  /** When set, the user must type this exact string to enable the confirm button. */
  requiredInput?: string;
  inputPlaceholder?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  requiredInput,
  inputPlaceholder,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const canConfirm = requiredInput ? inputValue === requiredInput : true;

  useEffect(() => {
    if (requiredInput && inputRef.current) inputRef.current.focus();
  }, [requiredInput]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onCancel}>
      <div
        className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <AlertTriangle size={18} className="text-red-400" />
            <h2 className="text-lg font-semibold text-gray-100">{title}</h2>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-gray-800 text-gray-400 hover:text-gray-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-300">{message}</p>

          {requiredInput && (
            <div>
              <label className="block text-xs text-gray-500 mb-1">
                Type <span className="font-mono text-gray-300">{requiredInput}</span> to confirm
              </label>
              <input
                ref={inputRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canConfirm) onConfirm();
                }}
                placeholder={inputPlaceholder ?? requiredInput}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500 transition-colors font-mono"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-800">
          <button
            onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
