import React, { useEffect, useId, useRef } from 'react';

/** Accessible modal: Esc and backdrop click close it, focus moves inside and returns afterwards. */
export default function Modal({ title, onClose, children, footer, wide = false, dismissable = true }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const prev = document.activeElement;
    const first = ref.current?.querySelector('[data-autofocus], textarea, input, select, button:not(.ui-x)');
    (first || ref.current)?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); onClose?.(); }
      if (e.key === 'Tab' && ref.current) {
        const items = [...ref.current.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
        if (!items.length) return;
        const a = items[0], z = items[items.length - 1];
        if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
        else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); };
  }, [onClose, dismissable]);
  return (
    <div className="ui-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && dismissable) onClose?.(); }}>
      <div className={`ui-modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div className="ui-modal-head">
          <h3 id={titleId}>{title}</h3>
          {dismissable && <button type="button" className="ui-x" aria-label="Close" onClick={onClose}>×</button>}
        </div>
        <div className="ui-modal-body">{children}</div>
        {footer && <div className="ui-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
