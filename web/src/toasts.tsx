import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { pushOnto } from "./toast-stack";

export type ToastInput = {
  kind: "success" | "error" | "undo";
  message: string;
  detail?: string;
  onUndo?: () => void;
  onExpire?: () => void;
};

type Toast = ToastInput & { id: number };

type ToastApi = {
  push: (toast: ToastInput) => void;
};

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function useToasts(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const stack = useRef<Toast[]>([]);
  const stackNode = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  useLayoutEffect(() => {
    const node = stackNode.current;
    const clear = () => {
      document.documentElement.style.scrollPaddingBottom = "";
      document.body.style.paddingBottom = "";
    };
    if (!node || toasts.length === 0) {
      clear();
      return;
    }
    const apply = () => {
      const inset = Math.max(0, Math.ceil(window.innerHeight - node.getBoundingClientRect().top));
      document.documentElement.style.scrollPaddingBottom = `${inset}px`;
      document.body.style.paddingBottom = `${inset}px`;
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(node);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
      clear();
    };
  }, [toasts]);

  const dismiss = useCallback((id: number) => {
    stack.current = stack.current.filter((toast) => toast.id !== id);
    setToasts(stack.current);
  }, []);

  const push = useCallback((toast: ToastInput) => {
    const id = nextId.current;
    nextId.current += 1;
    stack.current = pushOnto(stack.current, { ...toast, id });
    setToasts(stack.current);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div ref={stackNode} className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const remaining = useRef(toast.kind === "error" ? 0 : toast.kind === "undo" ? 6000 : 4000);
  const started = useRef(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (toast.kind === "error" || paused) return;
    started.current = Date.now();
    const timer = setTimeout(() => {
      toast.onExpire?.();
      onDismiss();
    }, remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(0, remaining.current - (Date.now() - started.current));
    };
  }, [paused, toast, onDismiss]);

  return (
    <div
      role="status"
      data-testid={`toast-${toast.kind}`}
      tabIndex={0}
      className="toast"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <p>{toast.message}</p>
      {toast.detail ? (
        <details className="caption">
          <summary>Technical detail</summary>
          <p>{toast.detail}</p>
        </details>
      ) : null}
      <div className="mt-2 flex gap-2">
        {toast.onUndo ? (
          <button
            type="button"
            data-testid="undo"
            className="underline"
            onClick={() => {
              toast.onUndo?.();
              onDismiss();
            }}
          >
            Undo
          </button>
        ) : null}
        {toast.kind === "error" ? (
          <button type="button" className="underline" onClick={onDismiss}>
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
