import React, { useState } from 'react';
import Modal from './Modal.jsx';

/**
 * Confirm / reason prompt. `field` = { label, required, placeholder } adds a text box whose value is passed to onSubmit.
 * onSubmit may be async; a thrown error is shown inside the dialog and the dialog stays open.
 */
export default function AskDialog({ title, body, field, confirmText = 'Confirm', cancelText = 'Cancel', danger = false, onSubmit, onClose }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const missing = Boolean(field?.required) && !value.trim();
  const go = async (e) => {
    e?.preventDefault();
    if (missing || busy) return;
    setBusy(true); setErr('');
    try { await onSubmit(value.trim()); onClose(); } catch (x) { setErr(x.message || 'That did not work'); setBusy(false); }
  };
  return (
    <Modal title={title} onClose={onClose} dismissable={!busy}
      footer={<>
        <button type="button" onClick={onClose} disabled={busy}>{cancelText}</button>
        <button type="submit" form="ui-ask-form" className={danger ? 'primary' : 'dark'} disabled={missing || busy}>{busy ? 'Working…' : confirmText}</button>
      </>}>
      <form id="ui-ask-form" onSubmit={go}>
        {body && <p className="ui-ask-body">{body}</p>}
        {field && (
          <>
            <label htmlFor="ui-ask-field">{field.label}{field.required ? '' : ' (optional)'}</label>
            <textarea id="ui-ask-field" rows={3} value={value} maxLength={300} placeholder={field.placeholder} onChange={(e) => setValue(e.target.value)} data-autofocus
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) go(e); }} />
          </>
        )}
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
