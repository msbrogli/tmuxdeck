import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export interface Toast {
  id: string;
  title: string;
  message: string;
  onClick?: () => void;
}

interface ToastContextType {
  addToast: (toast: Omit<Toast, 'id'>) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export function useToast(): ToastContextType {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const TOAST_DURATION = 5000;

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    // Trigger slide-in on next frame
    requestAnimationFrame(() => setVisible(true));
    timerRef.current = setTimeout(onDismiss, TOAST_DURATION);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [onDismiss]);

  return (
    <div
      className={`max-w-sm w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-lg p-3 cursor-pointer transition-all duration-300 ${visible ? 'translate-x-0 opacity-100' : 'translate-x-full opacity-0'}`}
      onClick={() => { toast.onClick?.(); onDismiss(); }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-100 truncate">{toast.title}</p>
          <p className="text-xs text-gray-400 mt-0.5 line-clamp-3">{toast.message}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          className="text-gray-500 hover:text-gray-300 shrink-0 p-0.5"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counterRef = useRef(0);

  const addToast = useCallback((toast: Omit<Toast, 'id'>) => {
    const id = `toast-${++counterRef.current}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
