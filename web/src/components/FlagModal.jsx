import React, { useState } from 'react';
import Modal from './Modal.jsx';
import { post } from '../lib/api.js';

/** Flag or block a phone number or an address. `initial` pre-fills it from an order or from the Flags page. */
export default function FlagModal({ initial = {}, onClose, onDone }) {
  const [kind, setKind] = useState(initial.kind || (initial.line1 && !initial.phone ? 'address' : 'phone'));
  const [phone, setPhone] = useState(initial.phone || '');
  const [line1, setLine1] = useState(initial.line1 || '');
  const [postcode, setPostcode] = useState(initial.postcode || '');
  const [level, setLevel] = useState('flagged');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!reason.trim()) return setErr('Say why, so the next person knows.');
    setBusy(true); setErr('');
    try {
      await post('/api/flags', { kind, level, reason: reason.trim(), ...(kind === 'phone' ? { phone: phone.trim() } : { line1: line1.trim(), postcode: postcode.trim() }) });
      onDone?.(); onClose();
    } catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <Modal title="Flag or block a customer" onClose={onClose} dismissable={!busy}
      footer={<><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="submit" form="flag-form" className={level === 'blocked' ? 'primary' : 'dark'} disabled={busy}>{busy ? 'Saving…' : level === 'blocked' ? 'Block' : 'Flag'}</button></>}>
      <form id="flag-form" onSubmit={submit} noValidate>
        <div className="add-seg" role="radiogroup" aria-label="What to flag">
          {[['phone', 'Phone number'], ['address', 'Address']].map(([v, l]) => <button type="button" key={v} role="radio" aria-checked={kind === v} className={kind === v ? 'on' : ''} onClick={() => setKind(v)}>{l}</button>)}
        </div>
        {kind === 'phone'
          ? <><label htmlFor="fl-phone">Phone</label><input id="fl-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-autofocus placeholder="07700 900123" /></>
          : <div className="add-two"><div><label htmlFor="fl-line">Address</label><input id="fl-line" value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="House number and street" /></div><div><label htmlFor="fl-pc">Postcode</label><input id="fl-pc" value={postcode} onChange={(e) => setPostcode(e.target.value.toUpperCase())} placeholder="SW11 1AB" /></div></div>}
        <div className="add-seg" role="radiogroup" aria-label="Flag or block" style={{ marginTop: 10 }}>
          {[['flagged', 'Flag (warn only)'], ['blocked', 'Block (refuse new orders)']].map(([v, l]) => <button type="button" key={v} role="radio" aria-checked={level === v} className={level === v ? 'on' : ''} onClick={() => setLevel(v)}>{l}</button>)}
        </div>
        <label htmlFor="fl-reason">Reason</label>
        <textarea id="fl-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Abusive to a driver on 12 Oct" />
        <small className="muted">A blocked customer is refused on the website and on Add order (you can override on Add order). Orders that arrive already paid from another platform are still taken, but shown in red.</small>
        {err && <div className="err" role="alert">{err}</div>}
      </form>
    </Modal>
  );
}
