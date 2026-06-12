'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type ToastType = 'success' | 'error' | 'info';
interface ToastMsg {
  id: number;
  type: ToastType;
  message: string;
}
interface ToastApi {
  toast: (message: string, type?: ToastType) => void;
}

const Ctx = createContext<ToastApi | null>(null);

/** Fire a transient notification. No-op if no provider is mounted (safe). */
export function useToast(): ToastApi {
  return useContext(Ctx) ?? { toast: () => {} };
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = ++seq;
      setToasts((t) => [...t.slice(-3), { id, type, message }]); // cap the stack
      setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {mounted &&
        createPortal(
          <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[200] flex flex-col items-center gap-2 p-4 sm:items-end">
            {toasts.map((t) => (
              <ToastItem key={t.id} toast={t} onClose={() => remove(t.id)} />
            ))}
          </div>,
          document.body,
        )}
    </Ctx.Provider>
  );
}

const SIGNAL: Record<ToastType, string> = {
  success: '--signal-success',
  error: '--signal-danger',
  info: '--signal-info',
};

function ToastItem({ toast, onClose }: { toast: ToastMsg; onClose: () => void }) {
  return (
    <div
      role="status"
      className="pd-toast pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm"
      style={{ background: 'var(--panel)', borderColor: 'var(--border)', boxShadow: 'var(--shadow-lifted)' }}
    >
      <span
        className="mt-[5px] h-2 w-2 shrink-0 rounded-full"
        style={{ background: `var(${SIGNAL[toast.type]})` }}
      />
      <span className="min-w-0 flex-1 text-[color:var(--text)]">{toast.message}</span>
      <button
        onClick={onClose}
        aria-label="Dismiss"
        className="shrink-0 text-[color:var(--muted)] transition hover:text-[color:var(--text)]"
      >
        ✕
      </button>
    </div>
  );
}
