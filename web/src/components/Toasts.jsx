import React, { useCallback, useEffect, useRef, useState } from 'react';

/** Tiny toast system: `const { toast, node } = useToasts();` then render {node} once. toast(message, 'ok' | 'err' | 'info'). */
export function useToasts() {
  const [items, setItems] = useState([]);
  const seq = useRef(0);
  const timers = useRef(new Map());
  const dismiss = useCallback((id) => {
    clearTimeout(timers.current.get(id)); timers.current.delete(id);
    setItems((l) => l.filter((t) => t.id !== id));
  }, []);
  const toast = useCallback((message, kind = 'info') => {
    const id = ++seq.current;
    setItems((l) => [...l.slice(-3), { id, message: String(message), kind }]);
    timers.current.set(id, setTimeout(() => dismiss(id), kind === 'err' ? 9000 : 4500));
  }, [dismiss]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const node = (
    <div className="ui-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`ui-toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          <span>{t.message}</span>
          <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
  return { toast, node };
}
